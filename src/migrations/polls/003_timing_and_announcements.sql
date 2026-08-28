ALTER TABLE polls ADD COLUMN automation_policy_json TEXT
  CHECK (automation_policy_json IS NULL OR json_valid(automation_policy_json));
ALTER TABLE polls ADD COLUMN bypass_working_hours INTEGER NOT NULL DEFAULT 1
  CHECK (bypass_working_hours IN (0, 1));
ALTER TABLE polls ADD COLUMN working_hours_override_at TEXT;
ALTER TABLE polls ADD COLUMN working_hours_override_by_identity_id TEXT;

ALTER TABLE poll_rounds ADD COLUMN automation_policy_json TEXT
  CHECK (automation_policy_json IS NULL OR json_valid(automation_policy_json));
ALTER TABLE poll_rounds ADD COLUMN bypass_working_hours INTEGER NOT NULL DEFAULT 1
  CHECK (bypass_working_hours IN (0, 1));
ALTER TABLE poll_rounds ADD COLUMN publication_not_before TEXT;
ALTER TABLE poll_rounds ADD COLUMN activation_deadline_at TEXT;
ALTER TABLE poll_rounds ADD COLUMN activation_not_before TEXT;
ALTER TABLE poll_rounds ADD COLUMN activated_at TEXT;
ALTER TABLE poll_rounds ADD COLUMN activation_trigger_kind TEXT
  CHECK (activation_trigger_kind IS NULL OR activation_trigger_kind IN (
    'participant_response', 'creator_timeout', 'no_response_timeout'
  ));
ALTER TABLE poll_rounds ADD COLUMN activation_trigger_identity_id TEXT;
ALTER TABLE poll_rounds ADD COLUMN working_hours_override_at TEXT;
ALTER TABLE poll_rounds ADD COLUMN announcements_required INTEGER NOT NULL DEFAULT 0
  CHECK (announcements_required IN (0, 1));

UPDATE poll_rounds
   SET publication_not_before = created_at
 WHERE publication_not_before IS NULL;

CREATE INDEX poll_rounds_activation_recovery_idx
  ON poll_rounds(status, activation_not_before, activation_deadline_at, activated_at, id);

CREATE TABLE poll_deliveries_v3 (
  id TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  round_id TEXT NOT NULL REFERENCES poll_rounds(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN (
    'result', 'tie', 'cancelled', 'failure', 'announcement', 'activation'
  )),
  delivery_key TEXT NOT NULL UNIQUE,
  chat_id TEXT NOT NULL,
  text TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'uncertain')),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  claim_token TEXT,
  lease_expires_at TEXT,
  next_attempt_at TEXT,
  message_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT,
  delivery_batch_key TEXT,
  delivery_sequence INTEGER CHECK (delivery_sequence IS NULL OR delivery_sequence >= 0),
  CHECK (
    (status = 'sending' AND claim_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR status <> 'sending'
  )
);

INSERT INTO poll_deliveries_v3 (
  id, poll_id, round_id, kind, delivery_key, chat_id, text, idempotency_key,
  status, attempt, claim_token, lease_expires_at, next_attempt_at, message_id,
  last_error, created_at, updated_at, sent_at, delivery_batch_key, delivery_sequence
)
SELECT id, poll_id, round_id, kind, delivery_key, chat_id, text, idempotency_key,
       status, attempt, claim_token, lease_expires_at, next_attempt_at, message_id,
       last_error, created_at, updated_at, sent_at, delivery_batch_key, delivery_sequence
  FROM poll_deliveries;

DROP TABLE poll_deliveries;
ALTER TABLE poll_deliveries_v3 RENAME TO poll_deliveries;

CREATE INDEX poll_deliveries_recovery_idx
  ON poll_deliveries(status, lease_expires_at, next_attempt_at, created_at, id);
CREATE UNIQUE INDEX poll_deliveries_batch_sequence_idx
  ON poll_deliveries(delivery_batch_key, delivery_sequence)
  WHERE delivery_batch_key IS NOT NULL;
