ALTER TABLE polls ADD COLUMN source_plugin_id TEXT;
ALTER TABLE polls ADD COLUMN source_idempotency_key TEXT;
ALTER TABLE polls ADD COLUMN source_request_sha256 TEXT;
ALTER TABLE polls ADD COLUMN rolling_membership_observed_at TEXT;
ALTER TABLE polls ADD COLUMN rolling_membership_next_review_at TEXT;

CREATE UNIQUE INDEX polls_source_idempotency_idx
  ON polls(scope_id, source_plugin_id, source_idempotency_key)
  WHERE source_plugin_id IS NOT NULL AND source_idempotency_key IS NOT NULL;

CREATE INDEX polls_rolling_membership_review_idx
  ON polls(status, rolling_membership_next_review_at, created_at, id);

ALTER TABLE poll_deliveries ADD COLUMN delivery_batch_key TEXT;
ALTER TABLE poll_deliveries ADD COLUMN delivery_sequence INTEGER
  CHECK (delivery_sequence IS NULL OR delivery_sequence >= 0);

CREATE UNIQUE INDEX poll_deliveries_batch_sequence_idx
  ON poll_deliveries(delivery_batch_key, delivery_sequence)
  WHERE delivery_batch_key IS NOT NULL;

CREATE TABLE poll_private_issuances (
  id TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  round_id TEXT NOT NULL REFERENCES poll_rounds(id) ON DELETE CASCADE,
  voter_identity_id TEXT NOT NULL,
  voter_wid TEXT NOT NULL,
  publish_idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'publishing', 'sent', 'uncertain', 'failed')),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  claim_token TEXT,
  lease_expires_at TEXT,
  next_attempt_at TEXT,
  publication_started_at TEXT,
  poll_wa_message_id TEXT UNIQUE,
  remote_chat_id TEXT,
  accepted_at TEXT,
  publication_audit_sent_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (round_id, voter_identity_id),
  CHECK (
    (status = 'publishing' AND claim_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR status <> 'publishing'
  )
);

CREATE INDEX poll_private_issuances_recovery_idx
  ON poll_private_issuances(status, lease_expires_at, next_attempt_at, created_at, id);
CREATE INDEX poll_private_issuances_round_idx
  ON poll_private_issuances(round_id, status, voter_identity_id);

CREATE TABLE poll_membership_transitions (
  poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  voter_identity_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('present', 'absent')),
  occurred_at TEXT NOT NULL,
  event_id TEXT NOT NULL,
  PRIMARY KEY (poll_id, voter_identity_id)
);

CREATE TABLE poll_automation_actions (
  poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('resolve_outcome', 'cancel')),
  idempotency_key TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (poll_id, kind),
  UNIQUE (poll_id, kind, idempotency_key)
);

CREATE TABLE poll_random_draw_audits (
  round_id TEXT PRIMARY KEY REFERENCES poll_results(round_id) ON DELETE CASCADE,
  event_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent')),
  created_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE INDEX poll_random_draw_audits_recovery_idx
  ON poll_random_draw_audits(status, created_at, round_id);
