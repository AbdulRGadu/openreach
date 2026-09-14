-- Scheduled send pacing for manual batch approvals and campaign automation.
ALTER TABLE messages ADD COLUMN scheduled_at TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_scheduled ON messages(status, scheduled_at);

ALTER TABLE campaigns ADD COLUMN send_start_time TEXT NOT NULL DEFAULT '09:00';
ALTER TABLE campaigns ADD COLUMN send_interval_minutes INTEGER NOT NULL DEFAULT 2;
