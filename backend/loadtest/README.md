# Load testing

Locust profile for the SECDigest API, plus the findings from the first real run.

The API serves from one Heroku dyno at `--workers 1`. Rate-limit headers, the TTL cache
and the request-ID logging all shipped without concurrent traffic ever going through
them, so this measures three read paths that each exercise a different layer:

| Path | Layer under test |
|---|---|
| `GET /api/companies/search` | in-memory ticker map, never leaves the process |
| `GET /api/filings/{cik}` | `filings_cache`, TTL 900s |
| `GET /api/analysis?limit=20` | Supabase, through `asyncio.to_thread`; the only uncached path |

## Why every user sends an X-Forwarded-For

Every endpoint is rate limited per IP, and slowapi keys on `request.client.host`. Fifty
Locust users on one machine share one bucket and spend the run being 429ed, which
measures the limiter instead of the API.

So each simulated user is assigned its own synthetic address and sends it as
`X-Forwarded-For`. uvicorn rewrites `request.client` from that header when it runs with
`--proxy-headers --forwarded-allow-ips="*"`, which is exactly what `backend/Dockerfile`
does in production. The load test therefore measures the deployed configuration rather
than a modified one, and no production code changes to support it.

Run uvicorn without those two flags and every user collapses onto `127.0.0.1` again.

## Running it

```bash
cd backend
pip install -r loadtest/requirements.txt
```

Locust is deliberately not in `requirements-dev.txt`: CI installs that file on every
backend run and locust pulls gevent, flask, werkzeug and pyzmq for a tool CI never
invokes. Same call roadmap 5.6 made for `@lhci/cli`.

Terminal 1, with production's flags rather than the `--reload` dev command:

```bash
uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1 \
  --proxy-headers --forwarded-allow-ips="*"
```

Terminal 2:

```bash
python -m loadtest.warm     # 8 CIKs, one EDGAR request each, fills filings_cache

# throughput: 50 users on distinct IPs
locust -f loadtest/locustfile.py --headless -u 50 -r 10 -t 60s \
  --host http://localhost:8000

# rate limiting: the same 50 users collapsed onto one IP
SHARED_IP=1 locust -f loadtest/locustfile.py --headless -u 50 -r 10 -t 30s \
  --host http://localhost:8000
```

The concurrency curve on the database path is its own harness, because the mixed load above
never stacks that path deeply enough to show it:

```bash
python -m loadtest.burst --target api        # through the API, concurrency 1 to 40
python -m loadtest.burst --target direct     # straight at PostgREST, every client variant
```

`--target direct` is the diagnosis: each variant changes one thing about the transport, so the
shape of the curve says which layer is responsible. It reads credentials from `.env` like the
app does, sends no writes, and never prints the key.

Warm first, always. Without it the first request per CIK goes to EDGAR and the run
measures SEC's latency plus the throttle in `services/edgar.py`.

`ENABLE_POST=1` adds `POST /api/analysis`, capped at 3 requests for the whole run. It
targets an already-analyzed filing, so it returns the cached row and spends no LLM
quota. Never point it at a filing the corpus does not already have.

### What to watch

- **p95 per endpoint**, not the aggregate: the three paths differ by two orders of
  magnitude and an aggregate p95 is a mix of them.
- **Failures must be zero** in the distinct-IP run. A 429 there means the pacing in
  `locustfile.py` drifted above the per-IP budget and the numbers are measuring slowapi.
- **The status breakdown** printed after each run, which splits 429 from 200. Locust's
  own table collapses everything non-2xx into "failures".

## Findings

First run: 2026-09-10, macOS, Python 3.12, one local uvicorn worker, live Supabase.

### Throughput, 50 users, distinct IPs, 60s

985 requests, **0 failures**, 16.45 req/s aggregate.

| Endpoint | reqs | fails | p50 | p95 | p99 | max |
|---|---|---|---|---|---|---|
| `/api/companies/search` | 486 | 0 | 7ms | 13ms | 25ms | 41ms |
| `/api/filings/{cik}` | 397 | 0 | 4ms | 21ms | 26ms | 27ms |
| `/api/analysis?limit=20` | 102 | 0 | 140ms | 210ms | 490ms | 524ms |

The two in-process paths are effectively free. Serving a filings response out of
`filings_cache` costs 4ms at p50 against 12 to 165ms for the EDGAR fetch it replaces,
measured by `loadtest.warm`'s cold-then-warm pair.

### Rate limiting, 50 users, one shared IP, 30s

| Endpoint | 200 | 429 | Note |
|---|---|---|---|
| `/api/companies/search` | 30 | 232 | exactly the 30/minute budget, then refused |
| `/api/filings/{cik}` | 187 | 0 | see the finding below |
| `/api/analysis?limit=20` | 42 | 0 | 42 requests against a 60/minute budget |

Every 429 carried `X-RateLimit-Remaining: 0` and an integer `Retry-After` between 31 and
57 seconds, consistent with the remaining time in a fixed 60s window.

### Finding 1: path-parameterized endpoints are limited per URL, not per route

`/api/filings/{cik}` took 187 requests from one IP in 30 seconds against a `30/minute`
limit and refused none of them.

slowapi's `key_style` defaults to `"url"`, so the limit key is the **concrete request
path**. `app/ratelimit.py` constructs `Limiter(key_func=..., headers_enabled=True)`
without overriding it. `/api/filings/320193` and `/api/filings/789019` are therefore
separate buckets, and a client gets 30 requests per minute *per CIK*, not per endpoint.

Confirmed directly, not just read out of the source:

```
same IP, one CIK,      34 requests  ->  30x 200, 4x 429    (limit works)
same IP, 8 CIKs x 25,  200 requests -> 200x 200, 0x 429    (limit bypassed)
same IP, 3 CIKs x 20 on /companies/{cik}/profile, 60 requests -> 60x 200, 0x 429
```

`/api/companies/search` and `/api/analysis` have fixed paths and behave as intended,
which is why the limit looked correct in every previous test.

Every path-parameterized route is affected: `/api/filings/{cik}`,
`/api/financials/{cik}`, `/api/companies/{cik}/profile` and `/peers`, and the whole
`/api/analysis/{id}/*` family. The one that matters most is
`POST /api/analysis/{id}/ask` at `6/minute`, which spends both LLM and embedding quota:
that budget is per analysis id, so walking ids multiplies it by the size of the corpus.
`DAILY_ANALYSIS_CAP` and `DAILY_EMBEDDING_CAP` still bound the day, so this is a much
weaker per-minute guard than it reads, not an unbounded one.

**Fixed** on this branch (roadmap 10.1): `app/ratelimit.py` now passes
`key_style="endpoint"`, so the key is the view function rather than the path. The three
experiments above, re-run against the fixed server:

```
same IP, one CIK,      34 requests  ->  30x 200,   4x 429
same IP, 8 CIKs x 25,  200 requests ->  30x 200, 170x 429
same IP, 3 CIKs x 20 on /companies/{cik}/profile, 60 requests -> 30x 200, 30x 429
```

`/api/companies/search` still answers 200 on the same IP after `/api/filings/{cik}` is
exhausted, so the fixed-path routes kept their own budgets.

### Finding 2: the uncached path degrades linearly with concurrency, well below the pool width

The 140ms p50 in the throughput run is **not** contention. Uncontended, the same request
costs 125ms at p50 (min 108ms), so 50 mixed users moved it by about 12%. That figure is
Supabase round-trip latency.

Stacking DB requests is a different story:

| Simultaneous requests | p50 | max |
|---|---|---|
| 1 | 125ms | 367ms |
| 5 | 346ms | 347ms |
| 10 | 496ms | 500ms |
| 20 | 723ms | 915ms |
| 40 | 1342ms | 1799ms |

Roughly linear, about 30ms of added latency per concurrent request. Linear is the
signature of serialization, not of a saturated pool: `asyncio.to_thread` uses the default
executor, 14 threads wide on this 10-core machine, and degradation is already 3x at
concurrency 5. Pool width is ruled out; the mechanism is not established by this
measurement. The shared sync Supabase client and its underlying `httpx.Client` are the
obvious suspects, and Supabase's own free-tier connection handling cannot be excluded
from a test run over the public internet. Separating those is the follow-up.

This does not bite at the traffic shape measured above, where the DB path drew 1.7 req/s
and never stacked. It would bite on a burst against `/history` or `/benchmark`.

### Finding 2, resolved (roadmap 10.2)

Reproduced with `python -m loadtest.burst`, which is the ad hoc burst from the first run made
repeatable. Run 2026-09-15, same machine, same live Supabase project.

**The mechanism is Supabase's, not ours.** Five variants of the client, each changing one thing,
bursting PostgREST directly with FastAPI out of the picture (`--target direct`):

| p50 by concurrency | 1 | 5 | 10 | 20 | 40 |
|---|---|---|---|---|---|
| `supabase-shared` (production shape, HTTP/2) | 91.5ms | 168.8ms | 266.8ms | 457.8ms | 877.0ms |
| `supabase-h1` (injected HTTP/1.1 client) | 60.9ms | 141.8ms | 217.2ms | 383.8ms | 681.0ms |
| `httpx-h2` (shared raw client) | 62.8ms | 148.7ms | 251.2ms | 438.6ms | 828.0ms |
| `httpx-h1` (shared raw client) | 59.6ms | 134.5ms | 221.1ms | 362.5ms | 691.2ms |
| `httpx-per-thread` (own connection per request) | 124.3ms | 196.8ms | 278.2ms | 457.3ms | 734.5ms |

Every arm degrades about 10x from 1 to 40, including a fresh client on a fresh TCP connection per
request. Two further controls:

- a 30 byte response (`select=id&limit=1`) degrades the same, 60.8ms to 617.8ms, so it is not
  client-side JSON parsing or the GIL;
- parallel `curl` **processes**, no Python at all, degrade the same: 110ms to 597ms.

So the connection pool, HTTP/2 multiplexing, `asyncio.to_thread` and the GIL are all ruled out.
The free-tier database serializes concurrent reads, and no client change fixes that. The
hypothesis this item started with, that httpcore's sync HTTP/2 read lock was the cause, is wrong,
and the measurement above is what killed it.

**What was fixed instead**, since the read path cannot be made faster:

1. `list_cache` (TTL 60s) in front of `database.list_analyses`, keyed on every filter. The three
   writers that can change a listed row clear it, so the TTL is only a backstop for writes from
   another process.
2. The count query is gone. PostgREST reports the match total in `Content-Range`, so the page and
   its total now arrive in one request instead of two.

`--target api`, 3 rounds per level, before and after:

| p50 by concurrency | 1 | 5 | 10 | 20 | 40 |
|---|---|---|---|---|---|
| before | 222.2ms | 394.9ms | 590.5ms | 963.5ms | 1544.0ms |
| after | 2.4ms | 4.2ms | 6.4ms | 7.3ms | 11.1ms |

**What is left, stated plainly.** That table is a warm cache, which is the steady state but not
the worst case. Measured on the same build:

- 40 identical requests arriving on an **expired** cache: 768.0ms p50. They all miss together, all
  reach Supabase, and the cache fills only after they return. A stampede is still slow, for about
  130ms once every 60 seconds.
- 40 **distinct** queries (walking `offset`): 533.5ms p50. Caching cannot help traffic that never
  repeats.

Both are roughly half the equivalent before-numbers, which is the count query no longer being
sent. Collapsing a stampede into one query needs single-flight locking per cache key, which is not
built.

### Finding 3: one dropped connection failed every request sharing it

Found while measuring the above. The before-run lost **24 of 120 requests to HTTP 500** at
concurrency 40, which the first load test never saw because it never stacked the DB path. The
traceback ends in `httpcore/_sync/http2.py` at `raise self._read_exception`.

postgrest builds its session with `http2=True`. HTTP/2 puts every request on one TCP connection,
so when Supabase drops that connection under load, every request in flight dies with it. The same
load over HTTP/1.1 uses a pool of independent connections and loses nothing:

| concurrency | HTTP/2 | HTTP/1.1 |
|---|---|---|
| 40 | 120 ok, 0 failed | 120 ok, 0 failed |
| 80 | 162 ok, **78 failed** (`RemoteProtocolError`) | 240 ok, 0 failed |
| 120 | 270 ok, **90 failed** | 360 ok, 0 failed |

HTTP/1.1 is also consistently faster here, by about 17% at every level above 1.

**Fixed**: `database._build_http_client` passes postgrest an `httpx.Client` with `http2=False`.
Injecting a client skips postgrest's own construction, so `base_url`, `follow_redirects` and its
**120s timeout** are restated there. That timeout is the trap: httpx defaults to 5s, which would
quietly start cutting off the paged reads in `sector_counts` and `match_chunks`.

### Tuning action taken (first run, 2026-09-10)

No tuning. The profile itself needed none: the acceptance criterion was that production
code changes only if the run reveals something, and the throughput numbers revealed
nothing to tune.

Finding 1 is fixed on this branch, with its own tests, because it is one argument and the
repro was already written. Finding 2 is not: its mechanism is not established, so it gets
its own item and a diagnosis step before any change.

The thing this run does establish: at 50 concurrent users and 16.5 req/s the API serves
985 requests with zero failures on one worker, and the two cached paths stay under 25ms
at p99.
