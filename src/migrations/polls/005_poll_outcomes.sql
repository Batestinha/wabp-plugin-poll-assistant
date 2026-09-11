CREATE TABLE poll_outcome_configurations (
  poll_id TEXT PRIMARY KEY REFERENCES polls(id) ON DELETE CASCADE,
  configuration_json TEXT NOT NULL,
  configuration_digest TEXT NOT NULL,
  approved_at TEXT NOT NULL
);
CREATE TABLE poll_outcome_handoffs (
  poll_id TEXT PRIMARY KEY REFERENCES polls(id) ON DELETE CASCADE,
  round_id TEXT NOT NULL REFERENCES poll_rounds(id) ON DELETE CASCADE,
  result_json TEXT NOT NULL,
  result_digest TEXT NOT NULL,
  workflow_run_id TEXT,
  reported_digest TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX poll_outcome_handoffs_pending_idx ON poll_outcome_handoffs(workflow_run_id, updated_at);
CREATE TABLE poll_workflow_operations (
  operation_id TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL UNIQUE REFERENCES polls(id) ON DELETE CASCADE,
  scope_id TEXT NOT NULL,
  actor_identity_id TEXT NOT NULL,
  input_digest TEXT NOT NULL
);
