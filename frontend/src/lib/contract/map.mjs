/**
 * The single place the backend's OpenAPI component schemas and the frontend's hand-written
 * interfaces in `src/lib/types.ts` are related (roadmap 11.3).
 *
 * `npm run contract` reads this twice: to emit one structural assertion per mapped pair, and
 * to prove every backend schema is accounted for. A backend model that is neither mapped nor
 * listed in UNMAPPED is an error — without that rule this would be a snapshot of today rather
 * than a gate, since the common drift is a model added on one side only.
 *
 * This is `.mjs` and not `.ts` because the generator is a plain Node script. The map is runtime
 * data rather than types, so one source keeps the generator, the coverage check and the Vitest
 * test from drifting apart.
 *
 * Frontend-local types are excluded by construction: `WatchItem` and `TrendPoint` are absent
 * because they are not API shapes at all.
 */

/** Backend component schema name to frontend interface name. Identity but for one rename. */
export const SCHEMA_MAP = {
  AnalysisListResponse: "AnalysisListResponse",
  AnalysisRequest: "AnalysisRequest",
  AnalysisResponse: "AnalysisResponse",
  AnnualFinancials: "AnnualFinancials",
  AskResponse: "AskResponse",
  AskSource: "AskSource",
  CompanyPeers: "CompanyPeers",
  CompanyProfile: "CompanyProfile",
  CompanySearchResult: "CompanySearchResult",
  Filing: "Filing",
  FinancialsResponse: "FinancialsResponse",
  IndexStatusResponse: "IndexStatus",
  Percentile: "Percentile",
  QuarterlyFinancials: "QuarterlyFinancials",
  Revision: "Revision",
  SectorCount: "SectorCount",
  SectorCountsResponse: "SectorCountsResponse",
  SimilarFiling: "SimilarFiling",
  SimilarFilingsResponse: "SimilarFilingsResponse",
};

/** Backend schemas deliberately without a frontend counterpart, each with its reason. */
export const UNMAPPED = {
  AskRequest:
    "lib/api.ts builds the /ask body inline, so there is no interface to compare it against.",
  HTTPValidationError:
    "FastAPI's own 422 envelope. lib/api.ts maps status codes to friendly copy and never reads the body.",
  ValidationError: "FastAPI's own, and only ever nested inside HTTPValidationError.",
};
