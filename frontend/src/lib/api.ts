import type {
  CompanySearchResult,
  Filing,
  AnalysisRequest,
  AnalysisResponse,
  AnalysisListResponse,
  FinancialsResponse,
} from "./types";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000/api";

const GET_TIMEOUT_MS = 30_000;

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Users never see raw backend errors — every status maps to friendly copy. */
function friendlyMessage(status: number, detail: string | null): string {
  switch (status) {
    case 404:
      return "That analysis could not be found.";
    case 422:
      return detail ?? "The request was invalid — try a different filing.";
    case 429:
      return "Rate limit reached — try again in a minute.";
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
  timeoutMs: number | null = GET_TIMEOUT_MS
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
    throw new ApiError(0, "Could not reach the server — check your connection.");
  }

  if (!res.ok) {
    let detail: string | null = null;
    try {
      const body = await res.json();
      if (typeof body?.detail === "string") detail = body.detail;
    } catch {
      // non-JSON error body — fall through to the generic message
    }
    throw new ApiError(res.status, friendlyMessage(res.status, detail));
  }
  return res.json();
}

export async function searchCompanies(
  query: string
): Promise<CompanySearchResult[]> {
  return fetchJson<CompanySearchResult[]>(
    `${API_URL}/companies/search?q=${encodeURIComponent(query)}`
  );
}

export async function getFilings(
  cik: string,
  formType = "10-K,10-Q",
  limit = 10
): Promise<Filing[]> {
  return fetchJson<Filing[]>(
    `${API_URL}/filings/${cik}?form_type=${encodeURIComponent(formType)}&limit=${limit}`
  );
}

export async function createAnalysis(
  request: AnalysisRequest
): Promise<AnalysisResponse> {
  // No timeout: analyzing a large filing legitimately runs 10–60s
  return fetchJson<AnalysisResponse>(
    `${API_URL}/analysis`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    },
    null
  );
}

export async function getAnalysis(id: number): Promise<AnalysisResponse> {
  return fetchJson<AnalysisResponse>(`${API_URL}/analysis/${id}`);
}

export async function getFinancials(cik: string): Promise<FinancialsResponse> {
  return fetchJson<FinancialsResponse>(`${API_URL}/financials/${cik}`);
}

export async function listAnalyses(
  limit = 20,
  offset = 0,
  ticker?: string
): Promise<AnalysisListResponse> {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });
  if (ticker) params.set("ticker", ticker);
  return fetchJson<AnalysisListResponse>(`${API_URL}/analysis?${params}`);
}
