<div align="center">

<img src="frontend/src/app/opengraph-image.png" alt="SECDigest" width="640">

# SECDigest

**Turn a 300-page SEC filing into a financial dashboard in under a minute.**

[![CI](https://github.com/eriklarson12/SECDigest/actions/workflows/ci.yml/badge.svg)](https://github.com/eriklarson12/SECDigest/actions/workflows/ci.yml)
[![Live demo](https://img.shields.io/badge/demo-secdigest.tech-A6300E)](https://secdigest.tech)
[![Tests](https://img.shields.io/badge/tests-534%20passing-3E4A5C)](#development--testing)
[![Python](https://img.shields.io/badge/Python-3.12-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![Next.js](https://img.shields.io/badge/Next.js-16-000000?logo=nextdotjs&logoColor=white)](https://nextjs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[**Live app →**](https://secdigest.tech) · [API health](https://secdigest-api-4cea35f62561.herokuapp.com/api/health) · [API docs](https://secdigest-api-4cea35f62561.herokuapp.com/docs)

</div>

---

Search a ticker, pick a 10-K or 10-Q, and SECDigest pulls the filing straight from SEC EDGAR, extracts the numbers and narrative with Google Gemini, and renders it as a financial dashboard: revenue and net income with YoY deltas, key risk factors, management guidance, a plain-English summary, and multi-year trend charts. You can also ask the filing questions in plain English and get answers cited back to the passages they came from.

Every analysis is cached permanently, so the app accumulates a searchable historical record. The whole stack runs on free tiers.

<img src="assets/dashboard.png" alt="SECDigest dashboard: Meta's 10-Q with revenue and net income, YoY deltas, and an eight-year XBRL trend chart" width="900">

## Features

- **Ticker search:** typeahead over the full SEC company list (10,000+ tickers), fully keyboard-navigable
- **Structured LLM extraction:** Gemini with a Pydantic-enforced JSON schema pulls revenue, net income, YoY changes, top risk factors, guidance, and a summary out of the raw filing
- **"Ask this filing":** retrieval-augmented Q&A over the filing's own text (pgvector), answered from the nearest excerpts with those excerpts shown as sources
- **Risk-factor drift:** each dashboard flags risks that are new versus the company's previous filing, and risks that were dropped
- **Company pages and comparison:** per-company trend history at `/company/{ticker}`, two companies side by side at `/compare?a=AAPL&b=MSFT`
- **Peer benchmarking:** net margin, operating cash flow margin, and three-year revenue CAGR for every company you follow, computed from XBRL and sortable by any column, at `/benchmark`
- **Watchlist:** star companies (browser-local, no account) and see when EDGAR has a filing newer than your latest analysis
- **History and CSV export:** every analysis stored, paginated, and downloadable

<details>
<summary><b>Screenshot: risk drift and cited Q&A</b></summary>

<img src="assets/risk-drift-and-qa.png" alt="Key Risk Factors with new and dropped risks flagged against the prior filing, and a Q&A answer with its source excerpts" width="900">

</details>

## Engineering Highlights

A few problems that shaped the design:

- **Exact numbers where exactness is available.** LLMs misread financial tables, so no chart or table figure comes from the model. Annual and quarterly revenue and net income, diluted EPS, and operating cash flow all come from SEC's XBRL API. The LLM is reserved for what only it can do: summarizing narrative and identifying risks.
- **Token budgets, spent where they matter.** A 10-K can exceed the model's practical input budget, so filing text is truncated section-aware. Risk Factors and MD&A take priority over exhibits and boilerplate, putting the budget on the parts an analyst actually reads.
- **Two rate limits, two different responses.** The embedding API caps tokens-per-minute and requests-per-day, where a "request" is one text, not one HTTP call. The per-minute ceiling is paceable, so a rolling-window pacer smooths work under it; the daily ceiling is not, so hitting it raises a distinct error that stops the run cleanly.
- **Indexing that doesn't block the user.** Embedding a filing takes minutes, so `POST /api/analysis` embeds nothing synchronously; it returns immediately and hands off to a background task. The UI shows a fourth state beyond loading, empty, and error: partial. Q&A stays enabled throughout, because what's already indexed is already answerable.
- **A long wait that explains itself.** Analysis takes 10 to 60 seconds, and a silent spinner is indistinguishable from a hung request, so the endpoint streams its pipeline stages over Server-Sent Events. `EventSource` cannot issue a POST, so the stream is read off `fetch` directly, and a dropped stream falls back to the plain request once.
- **Units resolved out of band.** A filing declares "(in millions, except per share data)" once, in a header that vector search almost never returns. The scale governing the matched passage is looked up separately and surfaced with the answer, so `$11,133` isn't silently read as eleven thousand dollars.

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS v4, Recharts |
| Backend | Python 3.12, FastAPI, Pydantic v2, `httpx` |
| AI | Google Gemini (`google-genai` SDK) for extraction and Q&A; `gemini-embedding-001` for retrieval |
| Database | Supabase Postgres with pgvector |
| Data source | SEC EDGAR REST and XBRL APIs |
| Testing | pytest, pyright, Vitest, Playwright |
| Infrastructure | Vercel (frontend), Heroku container dyno (backend), GitHub Actions CI |

## Architecture

```
┌──────────────┐      ┌───────────────┐      ┌─────────────────────┐
│   Next.js    │ ───► │    FastAPI    │ ───► │  SEC EDGAR          │
│   (Vercel)   │      │   (Heroku)    │ ───► │  Google Gemini      │
└──────────────┘      └───────────────┘ ───► │  Supabase + pgvector│
                                             └─────────────────────┘
```

A request for a filing is cache-first: the backend checks Supabase by accession number, and only on a miss does it fetch from EDGAR, truncate the text to a token budget weighted toward Risk Factors and MD&A, call Gemini with a response schema, and persist the result. Filing text is chunked and embedded in the background so Q&A becomes available while the dashboard is already usable.

## Getting Started

### Prerequisites

- Python 3.12+
- Node.js 22+
- A [Gemini API key](https://aistudio.google.com/apikey) (free, no card required)
- A [Supabase](https://supabase.com) project (free tier)

### Installation

```bash
git clone https://github.com/eriklarson12/SECDigest.git
cd SECDigest
```

**Database.** Create a Supabase project, open the SQL Editor, and run [`backend/schema.sql`](backend/schema.sql).

**Backend**

```bash
cd backend
python -m venv .venv && source .venv/bin/activate   # .venv\Scripts\activate on Windows
pip install -r requirements.txt
cp .env.example .env                                 # fill in your keys
uvicorn app.main:app --reload
```

**Frontend** (in a second terminal)

```bash
cd frontend
npm install
cp .env.local.example .env.local
npm run dev
```

### Usage

Open <http://localhost:3000>, search a ticker (`AAPL`), pick a filing, and hit **Analyze**. The first analysis of a filing takes 10 to 60 seconds; every view after that is served from cache.

Interactive API docs are at <http://localhost:8000/docs>.

## Configuration

Every value is an environment variable; nothing is hardcoded. Only the four marked required have no default.

<details>
<summary><b>Backend (<code>backend/.env</code>)</b>, 14 variables</summary>

| Variable | Required | Description |
|---|:--:|---|
| `GEMINI_API_KEY` | ✅ | From [AI Studio](https://aistudio.google.com/apikey) |
| `SUPABASE_URL` | ✅ | Project Settings → API → Project URL |
| `SUPABASE_KEY` | ✅ | Project Settings → API Keys → **secret key** (`sb_secret_…`). Server-only; never expose to the frontend |
| `SEC_USER_AGENT` | ✅ | Required by SEC fair-access policy, e.g. `SECDigest you@email.com` |
| `FRONTEND_URL` | | CORS origin (default `http://localhost:3000`) |
| `GEMINI_MODEL` | | Analysis model (default `gemini-3.6-flash`) |
| `GEMINI_FALLBACK_MODEL` | | Retried once when the primary model's quota is exhausted (default `gemini-3.5-flash-lite`) |
| `GEMINI_QA_MODEL` | | Model for "Ask this filing" (default `gemini-3.5-flash-lite`). Gemini meters requests per model, so Q&A draws on its own quota pool |
| `GEMINI_EMBED_MODEL` | | Embedding model (default `gemini-embedding-001`, 768 dims) |
| `MAX_FILING_CHARS` | | Filing text cap sent to the LLM (default `600000`, roughly 150K tokens) |
| `DAILY_ANALYSIS_CAP` | | Global analyses per day (default `200`) |
| `DAILY_EMBEDDING_CAP` | | Global Q&A embedding requests per day (default `950`). Metered per chunk, so this is roughly 5 to 8 filings and is the ceiling that binds first |
| `MAX_REQUEST_BYTES` | | Request body cap (default `10000`) |
| `LOG_FORMAT` | | `text` (default) or `json` for one-line structured logs carrying the request ID |

</details>

<details>
<summary><b>Frontend (<code>frontend/.env.local</code>)</b>, 2 variables</summary>

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_API_URL` | Backend base URL, e.g. `http://localhost:8000/api` |
| `NEXT_PUBLIC_SITE_URL` | Public origin of the site (default `http://localhost:3000`), used for `robots.txt`, `sitemap.xml`, and social card URLs |

</details>

## Development & Testing

```bash
# Backend: 300 tests, type check, dependency audit
cd backend
pip install -r requirements.txt -r requirements-dev.txt
pytest
npx pyright
pip-audit -r requirements.txt

# Frontend: 150 unit tests, 84 E2E tests
cd frontend
npm test          # Vitest
npm run test:e2e  # Playwright (API mocked)
npm run lint
npm run build
npm run lhci     # Lighthouse budgets against a production build
```

The E2E suite runs an axe-core audit of every page and fails the build on any serious or critical WCAG 2.1 A/AA violation. GitHub Actions runs all of the above on every push and pull request, plus `npm audit` and a Lighthouse pass with performance, accessibility, and layout-stability budgets. Dependabot proposes weekly dependency updates, and gitleaks scans for secrets as a pre-commit hook (`pre-commit install`).

<details>
<summary><b>Maintenance scripts</b>: backfilling Q&A chunks, running the extraction eval</summary>

Filings analyzed before Q&A shipped, or whose indexing a restart cut short, can be indexed in place without re-running the LLM:

```bash
cd backend
python -m scripts.backfill_chunks --dry-run   # preview
python -m scripts.backfill_chunks --limit 5
```

The extraction eval (see [Extraction accuracy](#extraction-accuracy)) sits outside the test suite because it spends real LLM quota:

```bash
cd backend
python -m evals.eval_extraction run            # ~10 LLM calls, then scores and writes the report
python -m evals.eval_extraction run --resume   # reuse what already succeeded; only re-spend the rest
python -m evals.eval_extraction score          # re-score a saved run against XBRL (free)
```

</details>

## API Reference

<details>
<summary><b>Ten endpoints</b>: health, company and filing lookup, XBRL financials, analysis, cited Q&A, indexing</summary>

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Liveness check |
| `GET` | `/api/companies/search?q=` | Ticker/name typeahead |
| `GET` | `/api/filings/{cik}` | Recent 10-K/10-Q filings |
| `GET` | `/api/financials/{cik}` | Exact annual and quarterly figures from SEC XBRL |
| `POST` | `/api/analysis` | Analyze a filing: cache-first, then EDGAR → Gemini → Supabase. Streams stage progress as Server-Sent Events when the client sends `Accept: text/event-stream` |
| `GET` | `/api/analysis` | List analyses, optional ticker filter and pagination |
| `GET` | `/api/analysis/{id}` | Single analysis |
| `POST` | `/api/analysis/{id}/ask` | Ask a question about the filing: vector search → cited answer |
| `GET` | `/api/analysis/{id}/index-status` | Q&A indexing progress for a filing |
| `POST` | `/api/analysis/{id}/reindex` | Re-run Q&A indexing for a filing whose index is missing or incomplete, resuming from the chunks already stored |

</details>

All endpoints are per-IP rate limited and advertise the limit in `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset`; a 429 carries `Retry-After`. Analysis endpoints additionally share a global daily cap.

## Extraction accuracy

The LLM reads revenue and net income out of a filing's prose. SEC publishes what the filer *tagged* for the same period in XBRL. That makes free, authoritative ground truth available for exactly the numbers the model extracts, with no labelling required, so extraction accuracy is measured rather than assumed.

`backend/evals/` scores the real pipeline (section-aware truncation and all) against XBRL across a golden set of ten diverse 10-Ks: mega-cap tech, a bank, a retailer, two companies posting net losses. A figure counts correct within ±1%. Misses are classified rather than just counted: `scale` (the filing said "in thousands" and the model didn't apply it), `sign`, or `period` (it read the comparative column). Classifying them is what turns a percentage into something actionable.

<!-- ACCURACY_TABLE -->

| Run | Model | Filings | Fields scored | Correct |
|---|---|---|---|---|
| 2026-08-14 | `gemini-3.6-flash` | 10 | 40 | 100.0% |

<!-- /ACCURACY_TABLE -->

The eval splits into `run`, the only step that spends LLM quota, and `score`, which is free and re-runnable against saved extractions. Re-scoring after a rule change therefore costs nothing, and the comparison logic is unit-tested in CI with no network. Ground truth is pinned on disk, because a company restating its financials would otherwise silently move a months-old baseline.

## Deployment

Live at **[secdigest.tech](https://secdigest.tech)** on a $0 infrastructure budget.

- **Backend → Heroku**, container stack: the root `heroku.yml` builds `backend/Dockerfile`. Pinned to **one dyno, one worker**, because the embedding rate limiter is process-local by design.
- **Frontend → Vercel**, with Root Directory set to `frontend/` and `NEXT_PUBLIC_API_URL` pointed at the backend.
- Set `FRONTEND_URL` on the backend to the frontend's origin to close the CORS loop.

## Limitations

- **Free-tier LLM quotas.** Gemini's free limits shift and are enforced per model. The analyze endpoint is rate limited and returns a friendly 503 when quota is exhausted. Note that free-tier prompts may be used for training. Filings are public, but this also covers questions typed into "Ask this filing".
- **Q&A coverage ramps up.** Indexing runs for minutes after an analysis, and the daily embedding budget covers roughly 5 to 8 filings, so a busy day defers the rest until quota resets. Prioritizing Risk Factors and MD&A also means Q&A answers narrative questions well but rarely retrieves figures from statement tables; the XBRL charts cover those.
- **Background indexing doesn't survive a restart.** A deploy leaves a filing partially indexed, so the Ask card reports how many passages it actually has and offers to finish the job, resuming from stored progress. Persisting a job queue would mean infrastructure this project deliberately doesn't have.
- **Single-period LLM extraction.** Each analysis stores one period plus YoY change; multi-year trends come from XBRL instead.
- **Supabase free tier pauses** after roughly 7 days of inactivity. A scheduled GitHub Actions job pings a database backed endpoint twice a week to keep the project awake.

## License

Released under the [MIT License](LICENSE).

---

Built by [Erik Larson](https://github.com/eriklarson12). Not investment advice. Always verify figures against the original filing, linked from every dashboard.
