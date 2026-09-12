CREATE TABLE polls (
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  group_id TEXT,
  creator_identity_id TEXT NOT NULL,
  creator_wid TEXT NOT NULL,
  creator_label TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('decide', 'measure', 'count')),
  definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
  status TEXT NOT NULL CHECK (status IN ('active', 'tie_pending', 'resolved', 'cancelled', 'failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  cancelled_at TEXT,
  cancelled_by_identity_id TEXT,
  cancelled_by_wid TEXT,
  cancel_reason TEXT,
  ballots_purged_at TEXT,
  cleanup_next_review_at TEXT,
  last_error TEXT
);

CREATE INDEX polls_scope_status_idx ON polls(scope_id, status, created_at, id);
CREATE INDEX polls_cleanup_recovery_idx
  ON polls(status, ballots_purged_at, cleanup_next_review_at, updated_at, id);

CREATE TABLE poll_rounds (
  id TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  round_number INTEGER NOT NULL CHECK (round_number >= 1),
  status TEXT NOT NULL CHECK (status IN (
    'publish_pending', 'publishing', 'open', 'finalizing', 'finalized', 'tie_pending', 'cancelled', 'failed'
  )),
  question TEXT NOT NULL,
  allow_multiple_answers INTEGER NOT NULL CHECK (allow_multiple_answers IN (0, 1)),
  publish_idempotency_key TEXT NOT NULL UNIQUE,
  poll_wa_message_id TEXT UNIQUE,
  closes_at TEXT,
  published_at TEXT,
  publication_attempt INTEGER NOT NULL DEFAULT 0 CHECK (publication_attempt >= 0),
  publication_claim_token TEXT,
  publication_lease_expires_at TEXT,
  publication_next_attempt_at TEXT,
  electorate_captured_at TEXT,
  publication_started_at TEXT,
  publication_outcome TEXT NOT NULL DEFAULT 'not_attempted'
    CHECK (publication_outcome IN ('not_attempted', 'unknown', 'accepted')),
  finalization_attempt INTEGER NOT NULL DEFAULT 0 CHECK (finalization_attempt >= 0),
  finalization_claim_token TEXT,
  finalization_lease_expires_at TEXT,
  finalization_next_attempt_at TEXT,
  finalized_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_error TEXT,
  UNIQUE (poll_id, round_number),
  UNIQUE (id, poll_id),
  CHECK (
    (status = 'finalizing' AND finalization_claim_token IS NOT NULL AND finalization_lease_expires_at IS NOT NULL)
    OR status <> 'finalizing'
  ),
  CHECK (
    (status = 'publishing' AND publication_claim_token IS NOT NULL AND publication_lease_expires_at IS NOT NULL)
    OR status <> 'publishing'
  )
);

CREATE INDEX poll_rounds_publication_recovery_idx
  ON poll_rounds(status, publication_lease_expires_at, publication_next_attempt_at, created_at, id);
CREATE INDEX poll_rounds_due_idx
  ON poll_rounds(status, closes_at, finalization_next_attempt_at, id);
CREATE INDEX poll_rounds_claim_idx
  ON poll_rounds(status, finalization_lease_expires_at, id);

CREATE TABLE poll_options (
  poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  label TEXT NOT NULL,
  wire_label TEXT NOT NULL,
  numeric_value INTEGER,
  PRIMARY KEY (poll_id, id),
  UNIQUE (poll_id, ordinal),
  UNIQUE (poll_id, wire_label)
);

CREATE TABLE poll_round_options (
  round_id TEXT NOT NULL,
  poll_id TEXT NOT NULL,
  option_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  PRIMARY KEY (round_id, option_id),
  UNIQUE (round_id, ordinal),
  FOREIGN KEY (round_id, poll_id) REFERENCES poll_rounds(id, poll_id) ON DELETE CASCADE,
  FOREIGN KEY (poll_id, option_id) REFERENCES poll_options(poll_id, id) ON DELETE CASCADE
);

CREATE TABLE poll_electorate (
  poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  voter_identity_id TEXT NOT NULL,
  voter_wid TEXT NOT NULL,
  display_label TEXT,
  captured_at TEXT NOT NULL,
  PRIMARY KEY (poll_id, voter_identity_id)
);

CREATE TABLE poll_vote_events (
  round_id TEXT NOT NULL REFERENCES poll_rounds(id) ON DELETE CASCADE,
  source_wa_message_id TEXT NOT NULL,
  voter_identity_id TEXT NOT NULL,
  voter_wid TEXT NOT NULL,
  selected_option_ids_json TEXT NOT NULL CHECK (json_valid(selected_option_ids_json)),
  interacted_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (round_id, source_wa_message_id)
);

CREATE INDEX poll_vote_events_voter_idx
  ON poll_vote_events(round_id, voter_identity_id, interacted_at, source_wa_message_id);

CREATE TABLE poll_readbacks (
  round_id TEXT NOT NULL REFERENCES poll_rounds(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  ballots_json TEXT NOT NULL CHECK (json_valid(ballots_json)),
  ballots_sha256 TEXT NOT NULL,
  read_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (round_id, id)
);

CREATE TABLE poll_ballots (
  round_id TEXT NOT NULL REFERENCES poll_rounds(id) ON DELETE CASCADE,
  voter_identity_id TEXT NOT NULL,
  voter_wid TEXT NOT NULL,
  selected_option_ids_json TEXT NOT NULL CHECK (json_valid(selected_option_ids_json)),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('transport_event', 'transport_readback')),
  source_id TEXT NOT NULL,
  interacted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (round_id, voter_identity_id)
);

CREATE TABLE poll_results (
  round_id TEXT PRIMARY KEY REFERENCES poll_rounds(id) ON DELETE CASCADE,
  poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  input_sha256 TEXT NOT NULL,
  cutoff_at TEXT NOT NULL,
  readback_source TEXT NOT NULL CHECK (readback_source IN ('events', 'transport_readback')),
  created_at TEXT NOT NULL,
  UNIQUE (round_id, poll_id)
);

CREATE TABLE poll_deliveries (
  id TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  round_id TEXT NOT NULL REFERENCES poll_rounds(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('result', 'tie', 'cancelled', 'failure')),
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
  CHECK (
    (status = 'sending' AND claim_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR status <> 'sending'
  )
);

CREATE INDEX poll_deliveries_recovery_idx
  ON poll_deliveries(status, lease_expires_at, next_attempt_at, created_at, id);

CREATE TABLE poll_resolutions (
  round_id TEXT PRIMARY KEY REFERENCES poll_rounds(id) ON DELETE CASCADE,
  poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind = 'manual_tie_break'),
  selected_option_ids_json TEXT NOT NULL CHECK (json_valid(selected_option_ids_json)),
  resolver_identity_id TEXT NOT NULL,
  resolver_wid TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (round_id, poll_id)
);
