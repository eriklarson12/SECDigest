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
    -- The filer's SEC classification, copied from the submissions feed at analysis time.
    -- TEXT, not INTEGER: SIC codes are zero-padded four-character identifiers ('0700'
    -- is Agricultural Services) and 0700 -> 700 is a different code. All three are
    -- independently absent for roughly a quarter of listed filers.
    sic                       TEXT,
    sic_description           TEXT,
    owner_org                 TEXT,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_analyses_ticker     ON analyses(ticker);
CREATE INDEX idx_analyses_created_at ON analyses(created_at DESC);
CREATE INDEX idx_analyses_sic        ON analyses(sic);
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

-- Language peers (roadmap 9.1): one centroid per filing, averaged over the chunk embeddings
-- above. Nothing new is embedded -- this is the Q&A corpus read a second way.

CREATE TABLE filing_vectors (
    accession_number TEXT PRIMARY KEY,
    centroid         VECTOR(768) NOT NULL,
    -- Chunks the centroid averages. Compared against the filing's stored chunk count to
    -- tell a current centroid from one predating a reindex.
    chunks           INTEGER NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- No ivfflat index here either, for a different reason than filing_chunks above: that scan is
-- narrow because it is scoped to one filing, this one is narrow because the whole corpus is a
-- few hundred rows. An ivfflat probe list small enough to suit that size costs recall and buys
-- nothing. Revisit past roughly 50k filings, not before.
-- Centroids are stored unnormalized on purpose: `<=>` is cosine distance, which normalizes at
-- comparison time, and the chunk vectors' own norms span under 3% (measured 2026-09-06), so a
-- plain mean cannot skew the ordering. Do not add a normalization step.
ALTER TABLE filing_vectors ENABLE ROW LEVEL SECURITY;  -- deny-all, backend only

-- Recomputes one filing's centroid from its stored chunks, entirely server-side. The backend
-- never reads an embedding back over the wire: PostgREST renders VECTOR as a JSON string, and a
-- filing's chunks are ~1.4 MB of them. Deriving the value from the table rather than from a
-- caller's memory also makes this idempotent, so the index hook, /reindex and the backfill script
-- can share one path -- and matters because embeddings.index_filing(resume=True) only ever holds
-- the tail of a resumed filing.
CREATE OR REPLACE FUNCTION upsert_filing_vector(p_accession TEXT)
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE n INTEGER;
BEGIN
  INSERT INTO filing_vectors (accession_number, centroid, chunks)
  SELECT c.accession_number, AVG(c.embedding), COUNT(*)::INT
  FROM filing_chunks c
  WHERE c.accession_number = p_accession AND c.embedding IS NOT NULL
  GROUP BY c.accession_number
  ON CONFLICT (accession_number) DO UPDATE
    SET centroid = EXCLUDED.centroid, chunks = EXCLUDED.chunks, created_at = NOW()
  -- Alias-qualified: bare `chunks` reads as the excluded row's column here.
  RETURNING filing_vectors.chunks INTO n;
  -- A filing with no chunks yields no source row, so nothing is inserted and n stays NULL.
  RETURN COALESCE(n, 0);
END $$;

REVOKE EXECUTE ON FUNCTION upsert_filing_vector(TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION upsert_filing_vector(TEXT) TO service_role;

-- Filings whose language sits nearest this one's. Two exclusions, and they are different rules:
-- `a.cik <> s.cik` drops the subject's *own* filings, which are each other's nearest neighbour by
-- a wide margin; DISTINCT ON (cik) then keeps one filing per *peer*, because 15 of 57 companies
-- have more than one analysis stored and without it 31% of subjects saw a company listed twice
-- (measured 2026-09-06). cik is stored unpadded and one ticker maps to one cik, so the plain
-- string comparison holds -- EDGAR's padding is inconsistent across surfaces (docs/edgar.md) but
-- this column is ours.
CREATE OR REPLACE FUNCTION match_companies(p_accession TEXT, p_k INT)
RETURNS TABLE (
  analysis_id      BIGINT,
  accession_number TEXT,
  ticker           TEXT,
  company_name     TEXT,
  form_type        TEXT,
  filing_date      DATE,
  sic              TEXT,
  sic_description  TEXT,
  similarity       FLOAT,
  pool             INT
)
LANGUAGE sql STABLE AS $$
  WITH subject AS (
    SELECT v.centroid AS centroid, a.cik AS cik
    FROM filing_vectors v
    JOIN analyses a ON a.accession_number = v.accession_number
    WHERE v.accession_number = p_accession
  ),
  candidates AS (
    -- Columns must be alias-qualified throughout: bare `ticker` / `similarity` would be
    -- ambiguous against the RETURNS TABLE output names.
    SELECT a.id AS id, a.accession_number AS accession_number, a.ticker AS ticker,
           a.company_name AS company_name, a.form_type AS form_type,
           a.filing_date AS filing_date, a.sic AS sic, a.sic_description AS sic_description,
           a.cik AS cik, 1 - (v.centroid <=> s.centroid) AS sim
    FROM filing_vectors v
    JOIN analyses a ON a.accession_number = v.accession_number
    CROSS JOIN subject s
    WHERE a.cik <> s.cik
  ),
  best AS (
    SELECT DISTINCT ON (c.cik) c.* FROM candidates c ORDER BY c.cik, c.sim DESC
  )
  -- `pool` counts companies, not filings: after the de-dup above that is what the ranking chose
  -- among, and it is what the card's caption names.
  SELECT b.id, b.accession_number, b.ticker, b.company_name, b.form_type, b.filing_date,
         b.sic, b.sic_description, b.sim, (SELECT COUNT(*)::INT FROM best)
  FROM best b
  ORDER BY b.sim DESC
  LIMIT p_k;
$$;

REVOKE EXECUTE ON FUNCTION match_companies(TEXT, INT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION match_companies(TEXT, INT) TO service_role;

-- Both functions are SECURITY INVOKER, so they read their tables as the caller (see match_chunks).
-- No sequence grant: filing_vectors is keyed on accession_number, not a BIGSERIAL.
GRANT SELECT, INSERT, UPDATE ON TABLE public.filing_vectors TO service_role;
GRANT SELECT ON TABLE public.analyses TO service_role;

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

-- --- Migration for databases created before industry classification (roadmap 8.1) ----
-- ALTER TABLE analyses ADD COLUMN IF NOT EXISTS sic             TEXT;
-- ALTER TABLE analyses ADD COLUMN IF NOT EXISTS sic_description TEXT;
-- ALTER TABLE analyses ADD COLUMN IF NOT EXISTS owner_org       TEXT;
-- CREATE INDEX IF NOT EXISTS idx_analyses_sic ON analyses(sic);
-- There is nothing already in the database to derive these from — the classification
-- lives only in EDGAR's submissions feed. Populate stored rows with:
--   cd backend && .venv/bin/python -m scripts.backfill_sic --dry-run
--   cd backend && .venv/bin/python -m scripts.backfill_sic
-- Rows left NULL simply render without an industry badge.

-- --- Migration for databases created before language peers (roadmap 9.1) -------------
-- Run the `filing_vectors` block above in the SQL Editor: the CREATE TABLE, both
-- CREATE OR REPLACE FUNCTIONs, and all six REVOKE/GRANT statements. Then check
-- pgvector is new enough to average a vector (0.5.0+; Supabase is well past it):
--   select vector_dims(avg(embedding)) from (select embedding from filing_chunks limit 10) s;
-- expects 768. Then sanity-check both functions against an accession that does not exist:
--   select upsert_filing_vector('nosuch');        -- 0, no error
--   select * from match_companies('nosuch', 5);   -- zero rows, no error
-- Populate centroids for stored analyses (pure database work, no EDGAR or Gemini quota):
--   cd backend && .venv/bin/python -m scripts.backfill_vectors --dry-run
--   cd backend && .venv/bin/python -m scripts.backfill_vectors
-- A filing whose index is incomplete is skipped, so it never contributes a centroid built
-- from part of its language; scripts/backfill_chunks.py completes it first.
-- Filings without a centroid simply render the card's empty state.
