-- Reader compatibility must be deployed before producers use these fields.
-- Existing deliveries keep their original text and have no mention recipients.
ALTER TABLE poll_deliveries ADD COLUMN mentioned_wids_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(mentioned_wids_json) AND json_type(mentioned_wids_json) = 'array');

ALTER TABLE poll_rounds ADD COLUMN activation_announcement_suppressed_at TEXT;
