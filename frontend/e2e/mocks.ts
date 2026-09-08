import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { Page } from "@playwright/test";

/** Shared API fixtures — every spec mocks the backend at the network layer. */

export const COMPANY = { cik: "320193", ticker: "AAPL", name: "Apple Inc." };

export const MSFT = {
  cik: "789019",
  ticker: "MSFT",
  name: "Microsoft Corporation",
};

export const COMPANY_PROFILE = {
  cik: "0000320193",
  sic: "3571",
  sic_description: "Electronic Computers",
  owner_org: "06 Technology",
};

/** The corpus by SEC review office. Deliberately not in office order — ordering is
 * `compareSectors`' job, and a pre-sorted fixture would test nothing. */
export const SECTORS = {
  sectors: [
    { owner_org: "06 Technology", count: 9 },
    { owner_org: null, count: 3 },
    { owner_org: "International Corp Fin", count: 1 },
    { owner_org: "02 Finance", count: 4 },
  ],
};

export const FILINGS = [
  {
    accession_number: "0000320193-26-000057",
    form_type: "10-Q",
    filing_date: "2026-05-02",
    primary_document: "aapl-q2.htm",
    primary_doc_description: "10-Q",
    items: [] as string[],
  },
];

/** 8-K rows, carried in the same response as FILINGS (roadmap 9.2). The amendment is newest
 * because AAPL's really is, and 7.02 is deliberately not in the label map — an item the SEC
 * adds later has to render as its code rather than disappear. */
export const EVENTS = [
  {
    accession_number: "0000320193-26-000071",
    form_type: "8-K/A",
    filing_date: "2026-09-01",
    primary_document: "aapl-8ka.htm",
    primary_doc_description: "8-K/A",
    items: ["5.02"],
  },
  {
    accession_number: "0000320193-26-000068",
    form_type: "8-K",
    filing_date: "2026-07-30",
    primary_document: "aapl-8k.htm",
    primary_doc_description: "8-K",
    items: ["2.02", "9.01"],
  },
  {
    accession_number: "0000320193-26-000064",
    form_type: "8-K",
    filing_date: "2026-07-01",
    primary_document: "aapl-8k-wide.htm",
    primary_doc_description: "8-K",
    // XOM's real 2026-07-01 filing, plus an unmapped code. Seven labels on one row is the
    // 375px case the middot line exists to survive.
    items: ["1.01", "2.01", "3.01", "3.03", "5.02", "5.03", "7.02", "9.01"],
  },
];

/** Serves the filing list and the 8-K rows out of one response, the way the backend does.
 * Honouring `form_type` is the point: a caller that never asks for 8-K must never see one. */
export function filingsFor(formType: string): typeof FILINGS {
  const wanted = new Set(formType.split(","));
  return [...FILINGS, ...EVENTS].filter((f) => wanted.has(f.form_type));
}

export const ANALYSIS = {
  id: 1,
  accession_number: "000032019326000057",
  cik: COMPANY.cik,
  ticker: COMPANY.ticker,
  company_name: COMPANY.name,
  form_type: "10-Q",
  filing_date: "2026-05-02",
  revenue_current: 1_000_000_000,
  revenue_yoy_change_pct: 5.5,
  net_income_current: 200_000_000,
  net_income_yoy_change_pct: -1.2,
  risk_factors: ["Supply chain concentration risk."],
  management_guidance: "Management expects continued growth.",
  summary: "Revenue grew 5.5% year over year.",
  sic: "3571",
  sic_description: "Electronic Computers",
  owner_org: "06 Technology",
  created_at: "2026-07-04T00:00:00+00:00",
};

/** Language peers for ANALYSIS (roadmap 9.1). AVGO and AMZN deliberately carry codes other
 * than ANALYSIS's own "3571": the feature's acceptance criterion is that it crosses SIC rather
 * than re-deriving it, so the fixture has to be able to fail that. */
export const SIMILAR = {
  pool: 56,
  available: true,
  peers: [
    {
      analysis_id: 2,
      accession_number: "000000248842",
      ticker: "AVGO",
      company_name: "Broadcom Inc",
      form_type: "10-Q",
      filing_date: "2026-06-05",
      sic: "3674",
      sic_description: "Semiconductors & Related Devices",
      similarity: 0.9469,
    },
    {
      analysis_id: 3,
      accession_number: "000000248843",
      ticker: "AMZN",
      company_name: "Amazon.com Inc",
      form_type: "10-Q",
      filing_date: "2026-05-01",
      sic: "5961",
      sic_description: "Retail-Catalog & Mail-Order Houses",
      similarity: 0.9434,
    },
    {
      analysis_id: 4,
      accession_number: "000000248844",
      ticker: "DELL",
      company_name: "Dell Technologies Inc",
      form_type: "10-K",
      filing_date: "2026-03-20",
      sic: "3571",
      sic_description: "Electronic Computers",
      similarity: 0.9401,
    },
  ],
};

/** The corpus can place this filing, but nothing is near enough to rank. */
export const SIMILAR_EMPTY = { pool: 1, available: true, peers: [] };

/** The subject has no centroid: never indexed, or indexed short. */
export const SIMILAR_UNAVAILABLE = { pool: 0, available: false, peers: [] };

export const FINANCIALS = {
  cik: COMPANY.cik,
  years: [
    {
      fiscal_year: 2023,
      revenue: 900_000_000,
      net_income: 150_000_000,
      eps_diluted: 5.89,
      operating_cash_flow: 300_000_000,
      cash: 60_000_000,
      total_assets: 1_800_000_000,
      stockholders_equity: 700_000_000,
    },
    {
      fiscal_year: 2024,
      revenue: 950_000_000,
      net_income: 180_000_000,
      eps_diluted: 6.11,
      operating_cash_flow: 320_000_000,
      cash: 65_000_000,
      total_assets: 1_900_000_000,
      stockholders_equity: 750_000_000,
    },
    {
      fiscal_year: 2025,
      revenue: 1_000_000_000,
      net_income: 200_000_000,
      eps_diluted: 6.42,
      operating_cash_flow: 350_000_000,
      cash: 70_000_000,
      total_assets: 2_000_000_000,
      stockholders_equity: 800_000_000,
    },
  ],
  quarters: [
    { period_end: "2025-03-29", revenue: 240_000_000, net_income: 45_000_000 },
    { period_end: "2025-06-28", revenue: 250_000_000, net_income: 48_000_000 },
    { period_end: "2025-09-27", revenue: 255_000_000, net_income: 50_000_000 },
    { period_end: "2025-12-27", revenue: 260_000_000, net_income: 52_000_000 },
  ],
  /** Revised figures (roadmap 9.3). The first row is GE's real FY2023 revenue — 67,954M in the
   * 2024 10-K, 35,348M by the 2026 one, as businesses moved to discontinued operations. The
   * second is upward and on another metric, so both arrows and both labels render, newest
   * fiscal year first. */
  revisions: [
    {
      fiscal_year: 2023,
      metric: "revenue",
      // The longest tag the revenue candidates can produce (50 characters), so the 375px
      // assertion measures the worst case rather than a comfortable one.
      concept: "RevenueFromContractWithCustomerExcludingAssessedTax",
      first_val: 67_954_000_000,
      latest_val: 35_348_000_000,
      delta_pct: -47.98,
      first_accn: "0000040545-24-000027",
      latest_accn: "0000040545-26-000008",
    },
    {
      fiscal_year: 2022,
      metric: "net_income",
      concept: "NetIncomeLoss",
      first_val: 200_000_000,
      latest_val: 245_000_000,
      delta_pct: 22.5,
      first_accn: "0000040545-23-000023",
      latest_accn: "0000040545-25-000015",
    },
    {
      fiscal_year: 2021,
      metric: "operating_cash_flow",
      // The longest tag any candidate list can produce (61 characters). A us-gaap tag is one
      // unbroken word, so this is what the 375px assertion has to fold.
      concept: "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
      first_val: 3_331_000_000,
      latest_val: 3_478_000_000,
      delta_pct: 4.41,
      first_accn: "0000040545-22-000012",
      latest_accn: "0000040545-24-000027",
    },
  ],
  /** Population percentiles (roadmap 9.4). Values are Apple's real CY2025 standing, and the
   * revenue row carries the union's longest concept tag so the 375px assertion measures the
   * worst case. `period_end` deliberately differs from the calendar year end: that mismatch is
   * the calendar-alignment fact the caption has to admit. */
  percentiles: [
    {
      metric: "revenue",
      concept: "RevenueFromContractWithCustomerExcludingAssessedTax",
      period: "CY2025",
      period_end: "2025-09-27",
      value: 416_161_000_000,
      percentile: 99.92,
      population: 4665,
    },
    {
      metric: "net_income",
      concept: "NetIncomeLoss",
      period: "CY2025",
      period_end: "2025-09-27",
      value: 112_010_000_000,
      percentile: 99.94,
      population: 5638,
    },
    {
      metric: "operating_cash_flow",
      // The longest tag any candidate list can produce (61 characters), so the 375px
      // assertion measures the worst case rather than a comfortable one.
      concept: "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
      period: "CY2025",
      period_end: "2025-09-27",
      value: 111_482_000_000,
      percentile: 99.92,
      population: 5736,
    },
  ],
};

/** Four fiscal years, so a 3-yr CAGR has both of its endpoints — the shared
 * FINANCIALS above has three and FINANCIALS_MSFT derives from that array, so a
 * fourth year there would move the compare overlay's numbers.
 *
 * Hand-checkable on purpose: FY2025 revenue 1331 over FY2022's 1000 is exactly
 * 10.0% a year; net income 266.2 is a 20.0% margin, OCF 399.3 a 30.0% one. */
export const BENCHMARK_FINANCIALS = {
  cik: COMPANY.cik,
  years: [
    {
      fiscal_year: 2022,
      revenue: 1_000_000_000,
      net_income: 150_000_000,
      eps_diluted: null,
      operating_cash_flow: 250_000_000,
      cash: null,
      total_assets: null,
      stockholders_equity: null,
    },
    {
      fiscal_year: 2023,
      revenue: 1_100_000_000,
      net_income: 180_000_000,
      eps_diluted: null,
      operating_cash_flow: 280_000_000,
      cash: null,
      total_assets: null,
      stockholders_equity: null,
    },
    {
      fiscal_year: 2024,
      revenue: 1_210_000_000,
      net_income: 220_000_000,
      eps_diluted: null,
      operating_cash_flow: 330_000_000,
      cash: null,
      total_assets: null,
      stockholders_equity: null,
    },
    {
      fiscal_year: 2025,
      revenue: 1_331_000_000,
      net_income: 266_200_000,
      eps_diluted: null,
      operating_cash_flow: 399_300_000,
      cash: null,
      total_assets: null,
      stockholders_equity: null,
    },
  ],
  quarters: [],
  revisions: [],
  percentiles: [
    {
      metric: "revenue",
      concept: "Revenues",
      period: "CY2025",
      period_end: "2025-12-31",
      value: 1331,
      percentile: 95.8,
      population: 4665,
    },
  ],
};

/** MSFT: a lower net margin (10.0%) so the default net-margin sort has a known
 * order, and no FY2022 at all so its 3-yr CAGR is honestly blank. */
export const BENCHMARK_FINANCIALS_MSFT = {
  cik: MSFT.cik,
  years: [
    {
      fiscal_year: 2024,
      revenue: 2_000_000_000,
      net_income: 190_000_000,
      eps_diluted: null,
      operating_cash_flow: 400_000_000,
      cash: null,
      total_assets: null,
      stockholders_equity: null,
    },
    {
      fiscal_year: 2025,
      revenue: 2_000_000_000,
      net_income: 200_000_000,
      eps_diluted: null,
      operating_cash_flow: 500_000_000,
      cash: null,
      total_assets: null,
      stockholders_equity: null,
    },
  ],
  quarters: [],
  revisions: [],
  percentiles: [
    {
      metric: "revenue",
      concept: "Revenues",
      period: "CY2025",
      period_end: "2025-12-31",
      value: 2_000_000_000,
      percentile: 70.4,
      population: 4665,
    },
  ],
};

export const ASK_ANSWER = {
  answer: "Revenue grew on iPhone demand (excerpt 1).",
  sources: [
    {
      chunk_index: 4,
      excerpt: "iPhone net sales increased 6% year over year.",
    },
    { chunk_index: 9, excerpt: "Services revenue reached an all-time high." },
  ],
  unit_scale: "Amounts in millions, except per share data.",
};

/** A filing that never declares a scale — the caption is omitted, not blanked. */
export const ASK_ANSWER_NO_SCALE = { ...ASK_ANSWER, unit_scale: null };

/** Filing reports in thousands; model converted 931,767 to "$932 million" instead
 * of restating it — caption must read as a filing fact, not contradict the answer. */
export const ASK_ANSWER_CONVERTED = {
  ...ASK_ANSWER,
  answer: "Total revenue increased by $932 million, or 93% (excerpt 2).",
  unit_scale: "In thousands.",
};

export const INDEX_COMPLETE = {
  state: "complete",
  chunks_indexed: 102,
  chunks_total: 102,
};

export const INDEX_IN_PROGRESS = {
  state: "indexing",
  chunks_indexed: 24,
  chunks_total: 102,
};

/** One SSE frame, exactly as `backend/app/routers/analysis.py` writes it. */
export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** The full stream a successful analysis produces, as one string. */
export const SSE_ANALYSIS =
  ["cache_check", "fetching_filing", "extracting", "storing"]
    .map((stage) => sseFrame("stage", { stage }))
    .join("") + sseFrame("result", ANALYSIS);

/** A real chunked SSE server, because `route.fulfill` sends one body in one chunk
 * and so can never show the checklist advancing — which is the whole feature.
 * Tests that need stages to arrive separately point the analyze POST here. */
/** `stopAfter` holds the connection open once that stage has been sent, instead
 * of finishing the stream. An audit of the checklist needs it: axe's own runtime
 * varies with machine load, and a stream that completes mid-analyze navigates
 * away, leaving axe on a document that has no <title> yet. That surfaced as a
 * `document-title` violation failing roughly one full suite run in three. */
export async function startStageServer(gapMs = 250, stopAfter?: string) {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, accept",
  };
  const server = createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors).end();
      return;
    }
    res.writeHead(200, {
      ...cors,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    });
    for (const stage of ["cache_check", "fetching_filing", "extracting", "storing"]) {
      res.write(sseFrame("stage", { stage }));
      // Held open deliberately; `close()` in the caller's finally tears it down.
      if (stage === stopAfter) return;
      await new Promise((r) => setTimeout(r, gapMs));
    }
    res.write(sseFrame("result", ANALYSIS));
    res.end();
  });
  // `server.close()` waits for open connections to end, and a held stream never
  // does, so the sockets have to be destroyed by hand or close() hangs until the
  // test times out.
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

export async function mockApi(page: Page) {
  // Later registrations win in Playwright, so go general → specific.
  await page.route("**/api/analysis*", async (route) => {
    if (route.request().method() === "POST") {
      // The client asks for SSE first and falls back to JSON, so both shapes of
      // the same response have to be here or every analyze test breaks.
      const accept = route.request().headers()["accept"] ?? "";
      if (accept.includes("text/event-stream")) {
        await route.fulfill({
          contentType: "text/event-stream",
          body: SSE_ANALYSIS,
        });
      } else {
        await route.fulfill({ json: ANALYSIS });
      }
    } else {
      await route.fulfill({ json: { analyses: [ANALYSIS], total: 1 } });
    }
  });
  await page.route("**/api/analysis/1", (route) =>
    route.fulfill({ json: ANALYSIS }),
  );
  // Its own pattern for the same reason as /ask below: `**/api/analysis*` stops at the
  // slash, so without this the homepage's sector call reaches the real network.
  await page.route("**/api/analysis/sectors", (route) =>
    route.fulfill({ json: SECTORS }),
  );
  // `*` does not cross `/` in Playwright globs, so the routes above never see
  // this path — the ask endpoint needs its own pattern.
  await page.route("**/api/analysis/*/ask", (route) =>
    route.fulfill({ json: ASK_ANSWER }),
  );
  // Fully indexed by default; tests that care about the ramp-up re-route this.
  await page.route("**/api/analysis/*/index-status", (route) =>
    route.fulfill({ json: INDEX_COMPLETE }),
  );
  // Its own pattern for the same reason as /ask: `*` does not cross `/`. The trailing `*`
  // catches the `?limit=` the client always sends.
  await page.route("**/api/analysis/*/similar*", (route) =>
    route.fulfill({ json: SIMILAR }),
  );
  await page.route("**/api/companies/search*", (route) =>
    route.fulfill({ json: [COMPANY] }),
  );
  // Distinct glob from search — an unrouted profile request goes to the real network.
  await page.route("**/api/companies/*/profile", (route) =>
    route.fulfill({ json: COMPANY_PROFILE }),
  );
  await page.route("**/api/filings/**", (route) =>
    route.fulfill({
      json: filingsFor(
        new URL(route.request().url()).searchParams.get("form_type") ?? "",
      ),
    }),
  );
  await page.route("**/api/financials/**", (route) =>
    route.fulfill({ json: FINANCIALS }),
  );
}

/** A seeded two-company watchlist. AAPL's latest filing matches its stored
 * analysis (no badge); MSFT has a filing but nothing analyzed (badge). Shared
 * by the watchlist page and the homepage strip, which read the same lookups. */
export async function mockWatchlistApi(page: Page) {
  await page.addInitScript(
    ([aapl, msft]) => {
      window.localStorage.setItem(
        "secdigest.watchlist",
        JSON.stringify([aapl, msft]),
      );
    },
    [COMPANY, MSFT],
  );
  await page.route("**/api/filings/**", async (route) => {
    const isMsft = route.request().url().includes(MSFT.cik);
    await route.fulfill({
      json: isMsft ? [{ ...FILINGS[0], filing_date: "2026-06-15" }] : FILINGS,
    });
  });
  await page.route("**/api/analysis?*", async (route) => {
    const ticker = new URL(route.request().url()).searchParams.get("ticker");
    const analyses = ticker === COMPANY.ticker ? [ANALYSIS] : [];
    await route.fulfill({ json: { analyses, total: analyses.length } });
  });
}

/** Two watched companies with four- and two-year XBRL series. Financials only —
 * the benchmark table needs no analyses and makes no filings request. */
export async function mockBenchmarkApi(page: Page) {
  await page.addInitScript(
    ([aapl, msft]) => {
      window.localStorage.setItem(
        "secdigest.watchlist",
        JSON.stringify([aapl, msft]),
      );
    },
    [COMPANY, MSFT],
  );
  await page.route("**/api/companies/search*", (route) =>
    route.fulfill({ json: [MSFT] }),
  );
  await page.route("**/api/financials/**", async (route) => {
    const isMsft = route.request().url().includes(MSFT.cik);
    await route.fulfill({
      json: isMsft ? BENCHMARK_FINANCIALS_MSFT : BENCHMARK_FINANCIALS,
    });
  });
}

/** The peer response for AAPL's industry (roadmap 8.4). Twelve companies against the
 * page's cap of ten, so the truncation note is exercised; AAPL leads, which is the
 * subject-first guarantee the backend makes. The description is a long real one on
 * purpose — the caption has to wrap at 375px rather than overflow. */
export const PEERS = {
  cik: COMPANY.cik,
  sic: "7372",
  sic_description: "Services-Computer Programming, Data Processing, Etc.",
  peers: [
    COMPANY,
    MSFT,
    ...Array.from({ length: 10 }, (_, i) => ({
      cik: String(900000 + i),
      ticker: `PEER${i}`,
      name: `Peer Company ${i}`,
    })),
  ],
};

/** A peer-seeded benchmark. Deliberately seeds a watchlist too: a peer seed replacing
 * it rather than merging with it is only observable when there is one to ignore. */
export async function mockPeersApi(page: Page) {
  await page.addInitScript(
    ([aapl, msft]) => {
      window.localStorage.setItem(
        "secdigest.watchlist",
        JSON.stringify([aapl, msft]),
      );
    },
    [COMPANY, MSFT],
  );
  await page.route("**/api/companies/*/peers", (route) =>
    route.fulfill({ json: PEERS }),
  );
  await page.route("**/api/companies/search*", (route) => {
    const q = new URL(route.request().url()).searchParams.get("q") ?? "";
    const match = [COMPANY, MSFT].find(
      (c) => c.ticker === q.toUpperCase(),
    );
    return route.fulfill({ json: match ? [match] : [] });
  });
  await page.route("**/api/financials/**", async (route) => {
    const isMsft = route.request().url().includes(MSFT.cik);
    await route.fulfill({
      json: isMsft ? BENCHMARK_FINANCIALS_MSFT : BENCHMARK_FINANCIALS,
    });
  });
}

/** MSFT's XBRL series, doubled off the shared one. Compare was the only
 * two-company surface when this lived in compare.spec.ts; the a11y audit is
 * the second, so the fixture and its routes moved here. */
export const FINANCIALS_MSFT = {
  cik: MSFT.cik,
  years: FINANCIALS.years.map((y) => ({
    ...y,
    revenue: (y.revenue ?? 0) * 2,
    net_income: (y.net_income ?? 0) * 2,
  })),
  quarters: [],
  revisions: [],
  percentiles: [],
};

/** Search resolves either company; only AAPL has a stored analysis. */
export async function mockCompareApi(page: Page) {
  await page.route("**/api/companies/search*", async (route) => {
    const q = new URL(route.request().url()).searchParams.get("q") ?? "";
    const matches = [COMPANY, MSFT].filter((c) =>
      c.ticker.startsWith(q.toUpperCase()),
    );
    await route.fulfill({ json: matches });
  });
  await page.route("**/api/analysis?*", async (route) => {
    const ticker = new URL(route.request().url()).searchParams.get("ticker");
    const analyses = ticker === COMPANY.ticker ? [ANALYSIS] : [];
    await route.fulfill({ json: { analyses, total: analyses.length } });
  });
  // XBRL is independent of the analysis: MSFT has a series despite having none stored.
  await page.route("**/api/financials/**", async (route) => {
    const cik = route.request().url().split("/").pop();
    await route.fulfill({
      json: cik === MSFT.cik ? FINANCIALS_MSFT : FINANCIALS,
    });
  });
}
