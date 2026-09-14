-- Operational state details for actionable queue and delivery UX.
ALTER TABLE messages ADD COLUMN sendability_status TEXT NOT NULL DEFAULT 'needs_review';
ALTER TABLE messages ADD COLUMN status_reason TEXT;
ALTER TABLE messages ADD COLUMN error_code TEXT;
ALTER TABLE messages ADD COLUMN error_detail TEXT;
ALTER TABLE messages ADD COLUMN retry_at TEXT;
ALTER TABLE messages ADD COLUMN last_attempt_at TEXT;
ALTER TABLE messages ADD COLUMN sender_display_name TEXT;
ALTER TABLE messages ADD COLUMN provider_status TEXT;
ALTER TABLE messages ADD COLUMN stopped_at TEXT;
ALTER TABLE messages ADD COLUMN stopped_reason TEXT;
ALTER TABLE sender_profiles ADD COLUMN display_name_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE campaign_leads ADD COLUMN status_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_messages_retry_at ON messages(status, retry_at);
CREATE INDEX IF NOT EXISTS idx_messages_sendability ON messages(direction, sendability_status);
CREATE INDEX IF NOT EXISTS idx_messages_sender_profile ON messages(sender_profile_id, direction, status);

UPDATE messages
   SET sendability_status = CASE
     WHEN status IN ('failed','rejected','send_unknown') THEN 'blocked'
     WHEN draft_quality_status = 'passed' OR status IN ('approved','queued','sending','sent') THEN 'sendable'
     ELSE 'needs_review'
   END
 WHERE sendability_status = 'needs_review';
