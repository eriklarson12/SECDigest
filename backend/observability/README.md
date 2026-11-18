# Observability

Local Prometheus for the backend's `GET /metrics`. Nothing in this folder is deployed, and it
needs no account: Prometheus runs in Docker on your machine.

| File | Purpose |
|---|---|
| `docker-compose.yml` | `prom/prometheus`, pinned, on `127.0.0.1:9090` |
| `prometheus.yml` | scrapes `host.docker.internal:8000/metrics` every 5 s with a bearer token |
| `alerts.yml` | three alert rules |
| `alerts_test.yml` | `promtool` unit tests for those rules |

## Metrics

| Metric | Labels | What it counts |
|---|---|---|
| `http_request_duration_seconds` | `method`, `route`, `status` | request start to last body byte |
| `edgar_requests_total` | `outcome`, `status` | one per EDGAR attempt, retries included |
| `edgar_pace_wait_seconds` | | time a request waited for its pacing slot |
| `llm_requests_total` | `model`, `outcome` | Gemini generate calls |
| `analysis_cache_total` | `result` | `POST /api/analysis` cache hits and misses |

`route` is the route template (`/api/filings/{cik}`), never the raw path, and anything that
matches no route is `unmatched`. A raw path would make one series per company.

`status` on `edgar_requests_total` is a class (`2xx`, `4xx`, `5xx`, `transport`) except for
`403` and `429`, which are SEC's throttling answers and stay distinct.

## Running it

The endpoint answers 404 unless `METRICS_TOKEN` is set and the request carries it, so pick a token
and give the same value to both sides:

```bash
cd backend
python -c "import secrets; print(secrets.token_urlsafe(32))" > observability/.metrics_token
METRICS_TOKEN="$(cat observability/.metrics_token)" uvicorn app.main:app --port 8000

# another terminal
cd backend/observability
docker compose up -d
```

`.metrics_token` is gitignored. Open http://localhost:9090/targets and the `secdigest-api` target
should read UP. `docker compose down` stops it and discards the data.

Check the endpoint by hand:

```bash
curl -H "Authorization: Bearer $(cat observability/.metrics_token)" localhost:8000/metrics
```

## Alerts

| Alert | Fires when |
|---|---|
| `EdgarRequestRateHigh` | EDGAR attempts average over 9/s for a minute, which means a path is bypassing the 8/s pacer |
| `EdgarBlocked` | any 403 or 429 from SEC in the last 5 minutes |
| `ApiLatencyHigh` | GET `/api` p95 over 1 s for 5 minutes, while traffic is above 0.2 requests/s |

The latency threshold comes from the load run in `../loadtest/README.md`.

Test the rules with the `promtool` that ships in the same image:

```bash
cd backend/observability
docker run --rm -v "$PWD":/rules -w /rules --entrypoint promtool \
  prom/prometheus:v3.15.1 test rules alerts_test.yml
```

The tests replay a 62 req/s EDGAR series (the rate that got the dyno blocked) and assert the rate
alert fires, and replay 6 req/s and the pacer's own 8.1 req/s and assert it does not. They also
cover a routine 404 against a 429, and a busy slow API against four cold company pages on a
quiet one.
