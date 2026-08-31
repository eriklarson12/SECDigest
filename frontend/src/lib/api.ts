import type {
  CompanySearchResult,
  Filing,
  AnalysisRequest,
  AnalysisResponse,
  AnalysisListResponse,
  AskResponse,
  IndexStatus,
  FinancialsResponse,
} from "./types";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000/api";

const GET_TIMEOUT_MS = 30_000;

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** slowapi sends whole seconds; the header is also legal as an HTTP-date, which we ignore. */
function retryAfterSeconds(res: Response): number | null {
  const raw = res.headers.get("Retry-After");
  if (raw === null) return null;
  const seconds = Number(raw);
  return Number.isInteger(seconds) && seconds > 0 ? seconds : null;
}

/** Users never see raw backend errors — every status maps to friendly copy. */
function friendlyMessage(
  status: number,
  detail: string | null,
  retryAfter: number | null,
): string {
  switch (status) {
    case 404:
      return "That analysis could not be found.";
    case 422:
      return detail ?? "The request was invalid — try a different filing.";
    case 429:
      return retryAfter === null
        ? "Rate limit reached — try again in a minute."
        : `Rate limit reached — try again in ${retryAfter}s.`;
    case 502:
      return "SEC EDGAR or the analysis service is having trouble — try again shortly.";
    case 503:
      return "Analysis service is at capacity — try again in a minute.";
    default:
      return "Something went wrong — try again.";
  }
}

async function fetchJson<T>(
  url: string,
  init?: RequestInit,
  timeoutMs: number | null = GET_TIMEOUT_MS,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      signal: timeoutMs === null ? undefined : AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError") {
      throw new ApiError(0, "Request timed out — try again.");
    }
    throw new ApiError(
      0,
      "Could not reach the server — check your connection.",
    );
  }

  if (!res.ok) await throwApiError(res);
  return res.json();
}

/** The single place a non-2xx becomes user-facing copy. Shared by the JSON and
 * streaming paths so the two mappings cannot drift apart. */
async function throwApiError(res: Response): Promise<never> {
  let detail: string | null = null;
  try {
    const body = await res.json();
    if (typeof body?.detail === "string") detail = body.detail;
  } catch {
    // non-JSON error body — fall through to the generic message
  }
  throw new ApiError(
    res.status,
    friendlyMessage(res.status, detail, retryAfterSeconds(res)),
  );
}

export async function searchCompanies(
  query: string,
): Promise<CompanySearchResult[]> {
  return fetchJson<CompanySearchResult[]>(
    `${API_URL}/companies/search?q=${encodeURIComponent(query)}`,
  );
}

export async function getFilings(
  cik: string,
  formType = "10-K,10-Q",
  limit = 10,
): Promise<Filing[]> {
  return fetchJson<Filing[]>(
    `${API_URL}/filings/${cik}?form_type=${encodeURIComponent(formType)}&limit=${limit}`,
  );
}

export async function createAnalysis(
  request: AnalysisRequest,
): Promise<AnalysisResponse> {
  // No timeout: analyzing a large filing legitimately runs 10–60s
  return fetchJson<AnalysisResponse>(
    `${API_URL}/analysis`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    },
    null,
  );
}

/** Pipeline stages the backend streams, in the order it emits them
 * (`backend/app/routers/analysis.py`). LoadingState renders its checklist from this. */
export const ANALYSIS_STAGES = [
  "cache_check",
  "fetching_filing",
  "extracting",
  "storing",
] as const;

export type AnalysisStage = (typeof ANALYSIS_STAGES)[number];

/** Anything that leaves the caller without a result *and* without a mapped backend
 * status: a dropped connection, or a stream that ended mid-pipeline. `useAnalyze`
 * keys its one non-streaming retry on this status. */
const TRANSPORT = 0;

const INTERRUPTED = "Analysis was interrupted — try again.";

/** One SSE frame. Returns the analysis on `result`, null on anything the caller
 * should keep reading past, and throws on `error`. */
function readFrame(
  frame: string,
  onStage: (stage: AnalysisStage) => void,
): AnalysisResponse | null {
  let event = "";
  let data = "";
  for (const line of frame.split(/\r?\n/)) {
    // A leading colon opens an SSE comment, which is what the keepalives are.
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!data) return null;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(data);
  } catch {
    // A malformed frame is a broken server, not a message for the user — the
    // raw SyntaxError would otherwise reach the screen as the error copy.
    throw new ApiError(TRANSPORT, INTERRUPTED);
  }

  if (event === "stage") {
    onStage(payload.stage as AnalysisStage);
    return null;
  }
  if (event === "result") return payload as unknown as AnalysisResponse;
  if (event === "error") {
    const status =
      typeof payload.status === "number" ? payload.status : TRANSPORT;
    const detail = typeof payload.detail === "string" ? payload.detail : null;
    throw new ApiError(status, friendlyMessage(status, detail, null));
  }
  return null;
}

/** Same analysis as `createAnalysis`, with stage progress reported as it happens.
 * `EventSource` cannot POST, so this reads the SSE body off `fetch` itself. */
export async function createAnalysisStream(
  request: AnalysisRequest,
  onStage: (stage: AnalysisStage) => void,
): Promise<AnalysisResponse> {
  let res: Response;
  try {
    // No timeout, for the same reason createAnalysis has none.
    res = await fetch(`${API_URL}/analysis`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(request),
    });
  } catch {
    throw new ApiError(
      TRANSPORT,
      "Could not reach the server — check your connection.",
    );
  }

  // Rejections that land before the stream opens (429, 413) are still statuses.
  if (!res.ok) await throwApiError(res);
  if (!res.body) throw new ApiError(TRANSPORT, INTERRUPTED);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // A frame ends at a blank line; whatever trails the last one is incomplete.
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const result = readFrame(frame, onStage);
      if (result) return result;
    }
  }

  // The backend always closes with `result` or `error`, so reaching here means
  // the connection dropped mid-pipeline.
  throw new ApiError(TRANSPORT, INTERRUPTED);
}

export async function getAnalysis(id: number): Promise<AnalysisResponse> {
  return fetchJson<AnalysisResponse>(`${API_URL}/analysis/${id}`);
}

export async function askFiling(
  id: number,
  question: string,
): Promise<AskResponse> {
  try {
    // No timeout: retrieval + generation is a two-call LLM round trip
    return await fetchJson<AskResponse>(
      `${API_URL}/analysis/${id}/ask`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      },
      null,
    );
  } catch (e) {
    // 404 here means "this filing was never indexed", not "no such analysis" —
    // filings analyzed before Q&A shipped have no chunks and can't get them.
    if (e instanceof ApiError && e.status === 404) {
      throw new ApiError(404, "Q&A isn't available for this filing.");
    }
    throw e;
  }
}

/** Polled by the Ask card while a filing's background index fills in. */
export async function getIndexStatus(id: number): Promise<IndexStatus> {
  return fetchJson<IndexStatus>(`${API_URL}/analysis/${id}/index-status`);
}

/** Re-runs indexing for a filing whose index is missing or short, resuming from the
 * chunks already stored. Analyzing the filing again cannot do this — one analysis per
 * filing, ever, so the cached row comes back without the indexer ever running. */
export async function reindexFiling(id: number): Promise<IndexStatus> {
  try {
    return await fetchJson<IndexStatus>(
      `${API_URL}/analysis/${id}/reindex`,
      { method: "POST" },
      null,
    );
  } catch (e) {
    // This endpoint's only 503 is the daily embedding budget, which resets on Google's
    // clock — the generic "try again in a minute" would send the user back 59 times.
    if (e instanceof ApiError && e.status === 503) {
      throw new ApiError(
        503,
        "Daily indexing budget spent — this filing can be indexed tomorrow.",
      );
    }
    throw e;
  }
}

export async function getFinancials(cik: string): Promise<FinancialsResponse> {
  return fetchJson<FinancialsResponse>(`${API_URL}/financials/${cik}`);
}

export async function listAnalyses(
  limit = 20,
  offset = 0,
  ticker?: string,
): Promise<AnalysisListResponse> {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });
  if (ticker) params.set("ticker", ticker);
  return fetchJson<AnalysisListResponse>(`${API_URL}/analysis?${params}`);
}
