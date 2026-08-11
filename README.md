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
```

Note: free-tier projects pause after ~7 days of inactivity — unpause from the dashboard.

## Environment variables

### Backend (`backend/.env`)

| Variable | Description |
|---|---|
| `GEMINI_API_KEY` | From https://aistudio.google.com/apikey (free, no card) |
| `GEMINI_MODEL` | Default `gemini-2.5-flash`; `gemini-2.5-flash-lite` has higher free daily limits |
| `GEMINI_FALLBACK_MODEL` | Retried once on quota exhaustion of the primary model (default `gemini-2.5-flash-lite`; empty disables) |
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

## Testing & CI

```bash
# Backend: unit/API tests + type check + dependency audit
cd backend
pip install -r requirements.txt -r requirements-dev.txt
pytest              # 81 tests: EDGAR, section targeting, LLM parsing + fallback, XBRL, caching, API validation, security
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

- **Free-tier LLM quotas**: Gemini free limits are unpublished and shift; the analyze endpoint is rate-limited (6/min) and returns a friendly 503 when quota is exhausted. Google may use free-tier prompts for training (filings are public documents).
- **Single-period LLM extraction**: each analysis stores one period + YoY %; multi-year trends come from SEC XBRL instead.
- **Supabase free tier** pauses after ~7 days idle.
- **Roadmap**: Supabase keep-alive cron and persistent daily quota (both post-deploy); full backlog with implementation specs in [`tasks/roadmap.md`](tasks/roadmap.md).
