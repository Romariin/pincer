export const CONVERSATIONS_TABLE = `
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  branch TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'accepted', 'discarded')),
  harness_id TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  effort TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`;

export const TURNS_TABLE = `
CREATE TABLE turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  source TEXT,
  dom_context TEXT,
  harness_id TEXT NOT NULL,
  resume_token TEXT,
  checkpoint TEXT,
  parent_checkpoint TEXT,
  output TEXT,
  blocks TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'complete', 'error', 'cancelled', 'reverted')),
  created_at INTEGER NOT NULL,
  UNIQUE (conversation_id, seq),
  CHECK (resume_token IS NULL OR harness_id <> '')
)`;

export const INDEXES = `
CREATE INDEX IF NOT EXISTS conversations_updated_at_idx
  ON conversations(updated_at DESC);
CREATE INDEX IF NOT EXISTS turns_conversation_status_idx
  ON turns(conversation_id, status);
`;

export const META_TABLE = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`;

export const SCHEMA_VERSION = "3";
