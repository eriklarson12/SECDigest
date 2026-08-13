FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN useradd --create-home appuser
USER appuser

EXPOSE 8000

# Shell form so Heroku's dynamic $PORT expands; proxy flags for the Heroku router.
#
# --workers 1 is load-bearing, not a default. Background Q&A indexing
# (app/services/indexing.py) holds the free-tier 30k tokens/minute embedding cap
# with a module-level TokenPacer and asyncio.Lock, which coordinate within one
# process only: a second worker would meter its own window and the two would
# silently blow the project-wide cap. uvicorn otherwise takes its worker count
# from $WEB_CONCURRENCY, so leaving this unset makes the invariant one
# `heroku config:set` away from breaking. Raising it requires replacing that
# pacer with a cross-process throttle first.
CMD uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1 --proxy-headers --forwarded-allow-ips="*"
