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
