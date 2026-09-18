CREATE TABLE poll_message_lifecycle (
  round_id TEXT PRIMARY KEY REFERENCES poll_rounds(id) ON DELETE CASCADE,
  pin_message_id TEXT,
  pinned_until TEXT,
  closed_edit_done INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT
);
