ALTER TABLE polls ADD COLUMN source_lifecycle_kind TEXT NOT NULL DEFAULT 'none'
  CHECK (source_lifecycle_kind IN ('none', 'automation', 'survey'));
ALTER TABLE polls ADD COLUMN presentation_owner TEXT NOT NULL DEFAULT 'poll_assistant'
  CHECK (presentation_owner IN ('poll_assistant', 'source_plugin'));

UPDATE polls
   SET source_lifecycle_kind = 'automation'
 WHERE source_plugin_id IS NOT NULL;

CREATE TABLE poll_lifecycle_actions (
  poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('finalize', 'cancel')),
  idempotency_key TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  PRIMARY KEY (poll_id, kind),
  UNIQUE (poll_id, kind, idempotency_key)
);

CREATE TABLE poll_lifecycle_snapshots (
  round_id TEXT PRIMARY KEY REFERENCES poll_rounds(id) ON DELETE CASCADE,
  poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  snapshot_sha256 TEXT NOT NULL,
  cutoff_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (round_id, poll_id)
);
