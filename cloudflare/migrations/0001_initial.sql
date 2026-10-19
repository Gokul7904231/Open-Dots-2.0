CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL DEFAULT 'Dot',
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  research_allowed INTEGER NOT NULL DEFAULT 1 CHECK (research_allowed IN (0, 1)),
  memory_allowed INTEGER NOT NULL DEFAULT 1 CHECK (memory_allowed IN (0, 1)),
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO settings (id, name, paused, research_allowed, memory_allowed, updated_at)
VALUES (1, 'Dot', 0, 1, 1, unixepoch() * 1000);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 2000),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS memories_created_at ON memories (created_at DESC);

CREATE TABLE IF NOT EXISTS research_runs (
  id TEXT PRIMARY KEY,
  objective TEXT NOT NULL CHECK (length(objective) BETWEEN 3 AND 4000),
  status TEXT NOT NULL CHECK (status IN ('queued', 'searching', 'synthesizing', 'completed', 'failed')),
  sources_json TEXT NOT NULL DEFAULT '[]',
  result_text TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS research_runs_created_at ON research_runs (created_at DESC);
CREATE INDEX IF NOT EXISTS research_runs_status ON research_runs (status, updated_at);
