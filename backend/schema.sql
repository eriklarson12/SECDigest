-- SECDigest database schema (Supabase Postgres)
-- Apply by pasting into the Supabase SQL Editor, or:
--   psql "$SUPABASE_DB_URL" -f backend/schema.sql

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
    -- Chunks the filing text splits into. Written at analysis time so index coverage
    -- survives a dyno restart; without it a partial index reports itself complete.
    chunks_expected           INTEGER,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_analyses_ticker     ON analyses(ticker);
CREATE INDEX idx_analyses_created_at ON analyses(created_at DESC);
ALTER TABLE analyses ENABLE ROW LEVEL SECURITY;  -- no policies: only the backend's secret key (service_role) can touch it

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
-- No ivfflat index: search is always scoped to one filing (a few hundred chunks), so an
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

-- Global daily LLM budget (roadmap 3.3). In-memory before this, so a Heroku dyno
-- cycle reset the counter and the real cap ran to roughly 2x DAILY_ANALYSIS_CAP.
CREATE TABLE daily_usage (day DATE PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0);
ALTER TABLE daily_usage ENABLE ROW LEVEL SECURITY;  -- deny-all, backend only

-- Increments and checks in one statement, so concurrent requests cannot both
-- sneak under the cap the way two reads of an in-process counter could.
CREATE OR REPLACE FUNCTION increment_daily_usage(p_day DATE, p_cap INTEGER)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE new_count INTEGER;
BEGIN
  INSERT INTO daily_usage (day, count) VALUES (p_day, 1)
  ON CONFLICT (day) DO UPDATE SET count = daily_usage.count + 1
  -- Alias-qualified: bare `count` reads as the aggregate, not the column.
  RETURNING daily_usage.count INTO new_count;
  RETURN new_count <= p_cap;
END $$;

-- Same grant rules as match_chunks above: CREATE FUNCTION grants EXECUTE to
-- PUBLIC, and a SECURITY INVOKER function touches the table as its caller.
REVOKE EXECUTE ON FUNCTION increment_daily_usage(DATE, INTEGER) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION increment_daily_usage(DATE, INTEGER) TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.daily_usage TO service_role;

-- Daily embedding-request budget. Gemini meters embeddings per *text*, not per HTTP call, so one
-- analysis spends 1 unit of daily_usage but 50-330 of this one — the analysis cap cannot protect it.
-- Reserved before each batch, so a filing that cannot finish is deferred rather than half-indexed.
CREATE TABLE embedding_usage (day DATE PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0);
ALTER TABLE embedding_usage ENABLE ROW LEVEL SECURITY;  -- deny-all, backend only

-- Reserves p_amount and reports whether it fit, in one statement (see increment_daily_usage).
-- A refused reservation still counts: the day's budget is spent either way, and the overcount
-- is discarded at midnight.
CREATE OR REPLACE FUNCTION increment_embedding_usage(p_day DATE, p_cap INTEGER, p_amount INTEGER)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE new_count INTEGER;
BEGIN
  INSERT INTO embedding_usage (day, count) VALUES (p_day, p_amount)
  ON CONFLICT (day) DO UPDATE SET count = embedding_usage.count + p_amount
  RETURNING embedding_usage.count INTO new_count;
  RETURN new_count <= p_cap;
END $$;

REVOKE EXECUTE ON FUNCTION increment_embedding_usage(DATE, INTEGER, INTEGER) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION increment_embedding_usage(DATE, INTEGER, INTEGER) TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.embedding_usage TO service_role;

-- --- Migration for databases created before the two features above ---------
-- ALTER TABLE analyses ADD COLUMN IF NOT EXISTS chunks_expected INTEGER;
-- Backfill it from stored chunk counts where the index is known complete:
--   UPDATE analyses a SET chunks_expected = c.n FROM (
--     SELECT accession_number, COUNT(*) AS n FROM filing_chunks GROUP BY accession_number
--   ) c WHERE c.accession_number = a.accession_number AND a.chunks_expected IS NULL;
-- Rows left NULL report as "complete" while any chunk exists, matching the old behaviour;
-- scripts/backfill_chunks.py recomputes the true total from the filing text.
