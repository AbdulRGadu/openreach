-- Controlled cold-outreach state and draft review warnings.

ALTER TABLE leads ADD COLUMN sales_stage TEXT NOT NULL DEFAULT 'prospecting';
ALTER TABLE leads ADD COLUMN next_action TEXT;
CREATE INDEX idx_leads_sales_stage ON leads(sales_stage);

-- SQLite cannot extend an existing CHECK constraint in place. Rebuild messages
-- so quality-failed AI output can be retained as needs_review instead of lost.
ALTER TABLE messages RENAME TO messages_before_quality_review;

CREATE TABLE messages (
  id         TEXT PRIMARY KEY,
  lead_id    TEXT REFERENCES leads(id),
  direction  TEXT NOT NULL CHECK (direction IN ('outbound','inbound')),
  status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN
    ('draft','needs_review','approved','queued','sending','sent','failed','rejected','send_unknown','received')),
  subject    TEXT,
  body       TEXT,
  from_email TEXT,
  to_email   TEXT,
  classification  TEXT,
  confidence      REAL,
  summary         TEXT,
  suggested_reply TEXT,
  ai_model   TEXT,
  prompt_version TEXT,
  zoho_message_id TEXT,
  attempts   INTEGER NOT NULL DEFAULT 0,
  error      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at    TEXT
);

INSERT INTO messages (
  id, lead_id, direction, status, subject, body, from_email, to_email,
  classification, confidence, summary, suggested_reply, ai_model, prompt_version,
  zoho_message_id, attempts, error, created_at, updated_at, sent_at
)
SELECT
  id, lead_id, direction, status, subject, body, from_email, to_email,
  classification, confidence, summary, suggested_reply, ai_model, prompt_version,
  zoho_message_id, attempts, error, created_at, updated_at, sent_at
FROM messages_before_quality_review;

DROP TABLE messages_before_quality_review;

CREATE INDEX idx_messages_lead ON messages(lead_id);
CREATE INDEX idx_messages_status ON messages(direction, status);
CREATE UNIQUE INDEX idx_messages_zoho_in ON messages(zoho_message_id)
  WHERE zoho_message_id IS NOT NULL AND direction = 'inbound';
