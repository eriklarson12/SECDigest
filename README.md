# SECDigest

AI-powered SEC filing analysis. Search a stock ticker, pick a 10-K or 10-Q, and SECDigest fetches the filing from SEC EDGAR, runs it through Google Gemini, and renders a dark financial dashboard — revenue and net income with YoY deltas, key risk factors, management guidance, a plain-English summary, and a trend chart across past analyses. Every analysis is cached in Supabase, so the app builds a historical record over time.

<!-- TODO: dashboard screenshot -->

## Features

- **Ticker search** — typeahead over the full SEC company list (10,000+ tickers), keyboard-navigable, with recent selections offered on focus
- **EDGAR integration** — official SEC APIs, no key required; polite fetching (throttled, retried, identified, response-cached); every dashboard links back to the original filing on SEC.gov
- **Structured LLM extraction** — Gemini with a JSON schema (Pydantic-enforced): revenue, net income, YoY changes, top risk factors, guidance, summary — with Risk Factors + MD&A section targeting so the token budget lands on the parts that matter, and automatic model fallback when the free-tier quota runs dry
- **Dark dashboard** — Recharts visualizations, skeleton loading, empty states, reduced-motion support
- **Cached forever** — one analysis per filing (`accession_number` UNIQUE); repeat requests are instant and cost nothing
- **Exact multi-period trends** — annual *and* quarterly revenue/net income straight from SEC's XBRL API (no LLM extraction error) with an Annual/Quarterly chart toggle, plus a per-year metrics table with diluted EPS and operating cash flow
- **Company comparison** — two tickers' latest analyses side by side at `/compare`, shareable as a URL (`/compare?a=AAPL&b=MSFT`)
- **Company page** — `/company/{ticker}` aggregates one company's trend chart, recent filings (analyze straight from here), and past analyses in one place; linked from watchlist cards, history rows, and every dashboard's ticker
- **Watchlist** — star companies (stored in your browser, no account) and see at a glance when EDGAR has a filing newer than the latest analysis
- **Risk-factor drift** — each dashboard flags risks that are new versus the company's prior analyzed filing and lists ones no longer highlighted
- **"Ask this filing"** — retrieval-augmented Q&A over the filing's own text: chunked and embedded with `gemini-embedding-001` into Postgres pgvector, then answered from the six nearest excerpts with those excerpts shown as sources
- **History + CSV export** — every analysis is stored, browsable with pagination, and downloadable as CSV

## Architecture

```
┌──────────────┐     ┌───────────────┐     ┌─────────────────────┐
│   Next.js    │ ──► │    FastAPI    │ ──► │  SEC EDGAR (free)   │
│   (Vercel)   │     │   (Heroku)    │ ──► │  Gemini (free tier) │
└──────────────┘     └───────────────┘ ──► │  Supabase Postgres  │
                                           └─────────────────────┘
```

| Choice | Why (one line — full rationale in `docs/decisions.md`) |
|---|---|
| Gemini free tier | Only $0 LLM with a 1M-token context (whole 10-K in one call) + native Pydantic structured output |
| Heroku Basic dyno | GitHub Student Pack credit ($13/mo × 24 mo) covers an always-on $7 dyno — $0 for two years |
| Supabase | Free Postgres with a REST client; one table is all this needs |
| Vercel | Free Next.js hosting, zero config |

## Local development

### Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate  # .venv\Scripts\activate on Windows
pip install -r requirements.txt -r requirements-dev.txt
cp .env.example .env       # fill in your keys (see Environment variables)
uvicorn app.main:app --reload
```

API docs at http://localhost:8000/docs

### Frontend

```bash
cd frontend
npm install
cp .env.local.example .env.local
npm run dev
```

App at http://localhost:3000

## Supabase setup

Create a free project at supabase.com, then run this in the SQL Editor:

```sql
CREATE TABLE analyses (
    id                        BIGSERIAL PRIMARY KEY,
    accession_number          TEXT NOT NULL UNIQUE,
    cik                       TEXT NOT NULL,
    ticker                    TEXT NOT NULL,
    company_name              TEXT NOT NULL,
    form_type                 TEXT NOT NULL,
    filing_date               DATE,
    revenue_current           DOUBLE PRECISION,
    revenue_yoy_change_pct    DOUBLE PRECISION,
    net_income_current        DOUBLE PRECISION,
    net_income_yoy_change_pct DOUBLE PRECISION,
    risk_factors              JSONB NOT NULL DEFAULT '[]',
    management_guidance       TEXT,
    summary                   TEXT,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_analyses_ticker     ON analyses(ticker);
CREATE INDEX idx_analyses_created_at ON analyses(created_at DESC);
ALTER TABLE analyses ENABLE ROW LEVEL SECURITY;  -- no policies: only the backend's service_role key can touch it

-- "Ask this filing" Q&A: filing text chunked and embedded for vector search
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE filing_chunks (
    id               BIGSERIAL PRIMARY KEY,
    accession_number TEXT NOT NULL,
    chunk_index      INTEGER NOT NULL,
    content          TEXT NOT NULL,
    embedding        VECTOR(768),
    UNIQUE (accession_number, chunk_index)
);
CREATE INDEX idx_chunks_accession ON filing_chunks(accession_number);
-- No ivfflat index: search is always scoped to one filing (~150 chunks), so an
-- exact scan is both faster and more accurate than an approximate index.
ALTER TABLE filing_chunks ENABLE ROW LEVEL SECURITY;  -- deny-all, backend only

CREATE OR REPLACE FUNCTION match_chunks(p_accession TEXT, p_embedding VECTOR(768), p_k INT)
RETURNS TABLE (chunk_index INT, content TEXT, similarity FLOAT)
LANGUAGE sql STABLE AS $$
  -- Columns must be alias-qualified: bare `chunk_index` / `content` would be
  -- ambiguous against the RETURNS TABLE output names.
  SELECT c.chunk_index, c.content, 1 - (c.embedding <=> p_embedding)
  FROM filing_chunks c
  WHERE c.accession_number = p_accession
  ORDER BY c.embedding <=> p_embedding
  LIMIT p_k;
$$;
-- CREATE FUNCTION grants EXECUTE to PUBLIC, so revoking per-role is not enough
REVOKE EXECUTE ON FUNCTION match_chunks(TEXT, VECTOR(768), INT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION match_chunks(TEXT, VECTOR(768), INT) TO service_role;

-- match_chunks is SECURITY INVOKER, so it reads the table as the *caller*.
-- Without these the backend gets "permission denied for table filing_chunks".
-- (service_role has BYPASSRLS, so the deny-all RLS above still blocks anon.)
GRANT SELECT, INSERT ON TABLE public.filing_chunks TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.filing_chunks_id_seq TO service_role;
```

Note: free-tier projects pause after ~7 days of inactivity — unpause from the dashboard.

## Environment variables

### Backend (`backend/.env`)

| Variable | Description |
|---|---|
| `GEMINI_API_KEY` | From https://aistudio.google.com/apikey (free, no card) |
| `GEMINI_MODEL` | Default `gemini-2.5-flash`; `gemini-2.5-flash-lite` has higher free daily limits |
| `GEMINI_FALLBACK_MODEL` | Retried once on quota exhaustion of the primary model (default `gemini-2.5-flash-lite`; empty disables) |
| `GEMINI_QA_MODEL` | Model that answers "Ask this filing" questions (default `gemini-3.5-flash-lite`). Gemini meters requests per day *per model*, so Q&A draws on its own pool instead of the analysis budget; empty routes it back to `GEMINI_MODEL` |
| `GEMINI_EMBED_MODEL` | Embedding model for filing Q&A (default `gemini-embedding-001`, 768 dims) |
| `MAX_FILING_CHARS` | Filing text cap before the LLM (default 600000 ≈ 150K tokens) |
| `SUPABASE_URL` | Project Settings → API → Project URL |
| `SUPABASE_KEY` | **service_role** secret — server-only, never expose to the frontend |
| `SEC_USER_AGENT` | Required by SEC fair-access policy, e.g. `SECDigest you@email.com` |
| `FRONTEND_URL` | CORS origin (prod: your Vercel URL) |
| `DAILY_ANALYSIS_CAP` | Global LLM analyses per day, default 200 (protects the Gemini free quota) |
| `MAX_REQUEST_BYTES` | Request body cap, default 10000 |

### Frontend (`frontend/.env.local`)

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_API_URL` | Backend base URL, e.g. `http://localhost:8000/api` |

## Deployment

Full step-by-step runbook: [`docs/deployment.md`](docs/deployment.md). Short version:

1. **Backend → Heroku**: container stack (`heroku stack:set container`); the root `heroku.yml` builds `backend/Dockerfile`. Set the env vars above as config vars, deploy from GitHub, scale to a Basic dyno (always-on, covered by the [GitHub Student Pack credit](https://www.heroku.com/github-students/)).
2. **Frontend → Vercel**: import the repo with Root Directory = `frontend`, set `NEXT_PUBLIC_API_URL` to the Heroku URL.
3. Set `FRONTEND_URL` on Heroku to the Vercel URL to close the CORS loop.

## API reference

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | Liveness check |
| GET | `/api/companies/search?q=` | Ticker/name typeahead (rate limit 30/min) |
| GET | `/api/filings/{cik}?form_type=&limit=` | Recent 10-K/10-Q filings (30/min) |
| GET | `/api/financials/{cik}` | Exact annual (incl. diluted EPS, op. cash flow) + quarterly figures from SEC XBRL (30/min) |
| POST | `/api/analysis` | Analyze a filing — cache-first, then EDGAR → Gemini → Supabase (6/min, 200/day globally) |
| GET | `/api/analysis?limit=&offset=&ticker=` | List analyses, optional ticker filter (60/min) |
| GET | `/api/analysis/{id}` | Single analysis (60/min) |
| POST | `/api/analysis/{id}/ask` | "Ask this filing" — vector search over the filing's chunks → cited answer + the filing's `unit_scale` (6/min, shares the daily cap) |
| GET | `/api/analysis/{id}/index-status` | Q&A coverage: `{state, chunks_indexed, chunks_total}` — polled by the Ask card while background indexing runs (60/min) |

## Maintenance scripts

Filings analyzed before Q&A shipped have no chunks. `scripts/backfill_chunks.py` indexes them in place — it re-fetches the filing text and embeds it without re-running the LLM analysis, so nothing in `analyses` changes (no lost history, no new IDs, no generation quota spent):

```bash
cd backend
python -m scripts.backfill_chunks --dry-run        # list what would be indexed
python -m scripts.backfill_chunks --limit 5        # index 5, then stop
python -m scripts.backfill_chunks --ticker AAPL    # one company
```

Background indexing already takes each newly analyzed filing to completion, so this script is the **repair** path: it re-indexes filings whose background job was cut short by a deploy or dyno restart, and filings analyzed before Q&A shipped. It paces itself against the 30k tokens/minute cap with a rolling-window meter and resumes from whatever is already stored — so a filing stuck at 16/102 chunks gets topped up rather than re-embedded. Budget about a minute per 25 chunks. It's also the way to guarantee full coverage ahead of a demo: analyze the filings you plan to show, then run this once. Every stored analysis is re-checked (completeness can't be known without the filing text), so a run costs one EDGAR fetch per analysis even when nothing needs indexing. Manual only — it consumes real EDGAR bandwidth and Gemini quota, so it's never wired into CI.

## Testing & CI

```bash
# Backend: unit/API tests + type check + dependency audit
cd backend
pip install -r requirements.txt -r requirements-dev.txt
pytest              # 121 tests: EDGAR, section targeting, LLM parsing + fallback, chunking/embedding, XBRL, caching, API validation, security
npx pyright         # type check
pip-audit -r requirements.txt

# Frontend: unit + E2E
cd frontend
npm test            # Vitest — formatters, CSV, risk-diff, API error mapping, watchlist, recents
npm run test:e2e    # Playwright — analyze flow, compare, company page, history/CSV, watchlist, errors, mobile; API mocked
```

CI (`.github/workflows/ci.yml`) runs all of the above plus `npm audit` on every push/PR; Dependabot proposes weekly dependency updates.

## Security

Strict allowlist validation on everything that reaches an EDGAR URL, per-IP rate limits plus a global daily LLM cap, request-body size limits, security headers + CSP on both the API and the frontend, deny-all RLS on Supabase, a non-root container, and secret scanning via gitleaks pre-commit hook (`pre-commit install`).

## Design notes

Dark-only financial dashboard: semantic color tokens (deep-navy surfaces, `#4D8DFF` primary, desaturated green/red for deltas), Geist Sans + Geist Mono with tabular numerals for all figures, Lucide icons, content-shaped skeletons, and `prefers-reduced-motion` support throughout. Token reference and UX rules: [`docs/design-system.md`](docs/design-system.md). Built with guidance from the [ui-ux-pro-max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) design skill.

## Limitations & roadmap

- **Free-tier LLM quotas**: Gemini free limits are unpublished and shift; the analyze endpoint is rate-limited (6/min) and returns a friendly 503 when quota is exhausted. Google may use free-tier prompts for training — filings are public documents, but note this also covers the **questions you type into "Ask this filing"**.
- **Q&A coverage ramps up after an analysis**: `gemini-embedding-001` is capped at **30,000 input tokens per minute** on the free tier (confirmed in AI Studio's rate-limit page; RPM and RPD are nowhere near their caps, so tokens are the only binding constraint). A 2000-char filing chunk is ~1.1k tokens, so one minute buys ~25 chunks and a ~100-chunk filing takes 4–5 minutes to index in full. `POST /api/analysis` therefore embeds **nothing** synchronously: it returns immediately and hands the filing to a background task that indexes it to completion. The Ask card polls `GET /api/analysis/{id}/index-status` and says "still indexing" until it's done — questions about already-indexed passages work throughout. Jobs share one token pacer and a lock, so analyzing two filings a minute apart no longer leaves the second one empty. Because `fetch_filing_text` prioritizes Risk Factors and MD&A, Q&A answers narrative questions well but generally can't retrieve figures from the financial statement tables — the XBRL charts cover those. The suggested questions in the Ask card steer toward what's actually indexed. Filings analyzed before this feature shipped have no chunks and answer "Q&A isn't available for this filing" — re-analyzing won't fix it (`POST /api/analysis` is cache-first on `accession_number` and never re-fetches the text); run the backfill script above instead.
- **Q&A figures need their scale supplied out of band**: a filing declares its unit scale once, in a statement or MD&A header — "(amounts in millions, except per share data)" — and never repeats it beside the numbers. Vector search returns the prose that answers the question, which almost never includes that header, so an otherwise correct answer quotes "$11,133" with no hint that it means $11.1 billion. `services/units.py` looks up the declaration governing the top-matching chunk (nearest one at or above it, so an MD&A answer gets the MD&A header) and passes it to the model *and* back as `unit_scale`, rendered as a caption under the answer. The exceptions are carried through verbatim rather than reduced to "millions" — "except per share data" is what stops a $1.30 dividend being reported as $1.30 million. Filings that never declare a scale get no caption and the model is told not to invent one.
- **Background indexing doesn't survive a restart**: a deploy or dyno restart kills in-flight indexing, leaving a filing partially indexed (accepted, not solved — persisting a job queue would mean infrastructure this app doesn't have). `scripts/backfill_chunks.py` resumes by stored chunk count, so the next run completes it. The pacer and lock that hold the 30k/minute cap are process-local, which is why `backend/Dockerfile` pins `--workers 1`; don't raise it without replacing them with a cross-process throttle.
- **Single-period LLM extraction**: each analysis stores one period + YoY %; multi-year trends come from SEC XBRL instead.
- **Supabase free tier** pauses after ~7 days idle.
- **Roadmap**: Supabase keep-alive cron and persistent daily quota (both post-deploy); full backlog with implementation specs in [`tasks/roadmap.md`](tasks/roadmap.md).
