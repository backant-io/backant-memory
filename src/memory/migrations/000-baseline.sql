CREATE TABLE IF NOT EXISTS memory (
  id              TEXT PRIMARY KEY,
  repo            TEXT NOT NULL DEFAULT '',
  tier            TEXT NOT NULL CHECK (tier IN ('stm','ltm')),
  type            TEXT NOT NULL,
  content         TEXT NOT NULL,
  sources         TEXT NOT NULL,
  weight          REAL NOT NULL,
  created         TEXT NOT NULL,
  last_reinforced TEXT NOT NULL,
  dream_citations INTEGER NOT NULL DEFAULT 0,
  act_citations   INTEGER NOT NULL DEFAULT 0,
  revision_count  INTEGER NOT NULL DEFAULT 0,
  verdict_boost   REAL NOT NULL DEFAULT 0,
  valid_from      TEXT,
  valid_to        TEXT,
  embedding       BLOB
);
CREATE INDEX IF NOT EXISTS idx_memory_tier_type      ON memory(tier, type);
CREATE INDEX IF NOT EXISTS idx_memory_weight         ON memory(weight DESC);
CREATE INDEX IF NOT EXISTS idx_memory_reinforce      ON memory(last_reinforced DESC);
CREATE INDEX IF NOT EXISTS idx_memory_repo_tier_type ON memory(repo, tier, type);

CREATE TABLE IF NOT EXISTS memory_state (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  change_seq INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO memory_state (id, change_seq) VALUES (1, 0);

CREATE TRIGGER IF NOT EXISTS bump_seq_on_memory_insert
AFTER INSERT ON memory
BEGIN
  UPDATE memory_state SET change_seq = change_seq + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS bump_seq_on_memory_update
AFTER UPDATE ON memory
BEGIN
  UPDATE memory_state SET change_seq = change_seq + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS bump_seq_on_memory_delete
AFTER DELETE ON memory
BEGIN
  UPDATE memory_state SET change_seq = change_seq + 1 WHERE id = 1;
END;

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  content,
  tokenize='porter unicode61'
);

CREATE TABLE IF NOT EXISTS ltm_history (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  ltm_id               TEXT NOT NULL,
  version              INTEGER NOT NULL,
  old_content          TEXT NOT NULL,
  new_content          TEXT NOT NULL,
  dream_source_id      TEXT,
  judge_decision_cycle TEXT,
  reason               TEXT NOT NULL,
  timestamp            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ltm_history_ltm ON ltm_history(ltm_id);

CREATE TABLE IF NOT EXISTS memory_edges (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  repo            TEXT NOT NULL DEFAULT '',
  from_id         TEXT NOT NULL,
  to_id           TEXT NOT NULL,
  edge_type       TEXT NOT NULL,
  weight          REAL NOT NULL DEFAULT 1.0,
  status          TEXT NOT NULL,
  reason          TEXT,
  dream_source_id TEXT,
  created         TEXT NOT NULL,
  approved_cycle  TEXT,
  last_used       TEXT
);
CREATE INDEX IF NOT EXISTS idx_edges_from   ON memory_edges(from_id, status);
CREATE INDEX IF NOT EXISTS idx_edges_to     ON memory_edges(to_id, status);
CREATE INDEX IF NOT EXISTS idx_edges_weight ON memory_edges(weight DESC);

CREATE TABLE IF NOT EXISTS dream_bucket (
  id              TEXT PRIMARY KEY,
  repo            TEXT NOT NULL DEFAULT '',
  hypothesis      TEXT NOT NULL,
  sources         TEXT NOT NULL,
  score           REAL NOT NULL,
  score_breakdown TEXT NOT NULL,
  generator       TEXT NOT NULL,
  strategy_level  TEXT NOT NULL,
  parent_id       TEXT,
  child_ids       TEXT,
  tier_target     TEXT,
  ttl             INTEGER NOT NULL DEFAULT 14,
  created         TEXT NOT NULL,
  verdict         TEXT,
  verdict_cycle   TEXT,
  verdict_reason  TEXT
);
CREATE INDEX IF NOT EXISTS idx_bucket_verdict ON dream_bucket(verdict, score DESC);

CREATE TABLE IF NOT EXISTS dream_rejected (
  id          TEXT PRIMARY KEY,
  hypothesis  TEXT NOT NULL,
  sources     TEXT NOT NULL,
  score       REAL NOT NULL,
  reason      TEXT NOT NULL,
  rejected_at TEXT NOT NULL,
  rejected_by TEXT NOT NULL
);

-- dream_revise_lock — per-cycle conflict guard for REVISE verdicts.
-- First REVISE for a given (cycle_id, tier_target) wins; subsequent attempts
-- in the same cycle are downgraded to KEEP. Cross-cycle conflicts are allowed.
-- Rows accumulate at ~1 per REVISE per cycle; cleanup is not currently implemented
-- (harmless, since the conflict check filters by current cycle_id).
CREATE TABLE IF NOT EXISTS dream_revise_lock (
  cycle_id         TEXT NOT NULL,
  tier_target      TEXT NOT NULL,
  winner_bucket_id TEXT NOT NULL,
  applied_at       TEXT NOT NULL,
  UNIQUE(cycle_id, tier_target)
);

CREATE TABLE IF NOT EXISTS recall_cache (
  cue_hash             TEXT PRIMARY KEY,
  result               TEXT NOT NULL,
  memory_seq_at_recall INTEGER NOT NULL,
  created              TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_ops_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_id       TEXT NOT NULL,
  op             TEXT NOT NULL,
  args           TEXT NOT NULL,
  result_summary TEXT,
  timestamp      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ops_log_cycle ON memory_ops_log(cycle_id);

-- memory_meta — per-namespace key/value (e.g. the embedding model+dim the
-- namespace was built with, so a device using a different model is rejected
-- rather than silently corrupting vector recall).
CREATE TABLE IF NOT EXISTS memory_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- recall_trace — recall observability log (Memory v2 Layer 0).
-- Lives OUTSIDE the memory table and has no change_seq trigger, so writing a
-- trace never invalidates recall_cache (traces don't change ranking).
-- miss=1 rows are recall-miss flags written by dream's curate step.
CREATE TABLE IF NOT EXISTS recall_trace (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  repo      TEXT NOT NULL DEFAULT '',
  cycle_id  TEXT,
  caller    TEXT NOT NULL,
  cue       TEXT NOT NULL,
  k         INTEGER NOT NULL,
  filters   TEXT,
  results   TEXT NOT NULL,   -- JSON: per-result component scores, rank, injected flag
  misses    TEXT,            -- JSON: ranks k+1..k+10 with the same breakdown
  miss      INTEGER NOT NULL DEFAULT 0,  -- recall-miss flag rows (curate step)
  timestamp TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trace_cycle ON recall_trace(cycle_id);
CREATE INDEX IF NOT EXISTS idx_trace_repo_time ON recall_trace(repo, timestamp DESC);
