-- Reliable reply ingestion, debug audit data, and the explicit sales workflow.
PRAGMA defer_foreign_keys = on;

ALTER TABLE messages ADD COLUMN next_action TEXT;
ALTER TABLE messages ADD COLUMN received_at TEXT;

CREATE TABLE reply_ingest_logs (
  id                    TEXT PRIMARY KEY,
  from_email            TEXT,
  message_id            TEXT,
  in_reply_to           TEXT,
  references_header     TEXT,
  raw_payload           TEXT,
  auth_status           TEXT NOT NULL CHECK (auth_status IN ('authorized','unauthorized')),
  match_status          TEXT CHECK (match_status IN (
    'matched_by_message_id','matched_by_in_reply_to','matched_by_sender_email',
    'matched_by_sender_domain','unmatched'
  )),
  classification_status TEXT NOT NULL DEFAULT 'pending' CHECK (classification_status IN
    ('pending','classified','failed','skipped')),
  classification        TEXT,
  confidence            REAL,
  lead_id               TEXT,
  inbound_message_id    TEXT,
  error                  TEXT,
  payload_received_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_reply_ingest_created ON reply_ingest_logs(payload_received_at DESC);
CREATE INDEX idx_reply_ingest_message ON reply_ingest_logs(message_id);

-- Rebuild leads so the database enforces the sales statuses used by the Worker.
CREATE TABLE leads_next (
  id                    TEXT PRIMARY KEY,
  email                 TEXT NOT NULL UNIQUE,
  domain                TEXT NOT NULL,
  first_name            TEXT,
  last_name             TEXT,
  role                   TEXT,
  company                TEXT,
  company_website        TEXT,
  industry               TEXT,
  segment                TEXT CHECK (segment IN ('fintech','healthcare','school','logistics','saas','enterprise','sme','other')),
  fit_score              INTEGER,
  fit_reason             TEXT,
  pain_points            TEXT,
  source                 TEXT NOT NULL DEFAULT 'manual',
  status                 TEXT NOT NULL DEFAULT 'new' CHECK (status IN (
    'new','scored','drafted','approved','queued','sent','replied_positive',
    'meeting_requested','asked_for_more_info','referred','not_now','not_interested',
    'suppressed','unmatched_reply','manual_review','failed'
  )),
  last_reply_classification TEXT,
  notes                  TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
  sales_stage            TEXT NOT NULL DEFAULT 'prospecting',
  next_action            TEXT,
  country                TEXT,
  company_size           TEXT,
  contact_profile_url    TEXT,
  source_url             TEXT,
  structured_notes       TEXT,
  discovery_score        INTEGER,
  data_confidence        INTEGER,
  last_verified_at       TEXT
);

INSERT INTO leads_next SELECT
  id, email, domain, first_name, last_name, role, company, company_website,
  industry, segment, fit_score, fit_reason, pain_points, source,
  CASE status
    WHEN 'replied' THEN 'manual_review'
    WHEN 'bounced' THEN 'failed'
    WHEN 'unsubscribed' THEN 'suppressed'
    WHEN 'disqualified' THEN 'not_interested'
    ELSE status
  END,
  last_reply_classification, notes, created_at, updated_at, sales_stage, next_action,
  country, company_size, contact_profile_url, source_url, structured_notes,
  discovery_score, data_confidence, last_verified_at
FROM leads;

-- Child references are temporarily deferred while the table name changes.
DROP TABLE leads;
ALTER TABLE leads_next RENAME TO leads;
CREATE INDEX idx_leads_status ON leads(status);
CREATE INDEX idx_leads_domain ON leads(domain);
CREATE INDEX idx_leads_segment ON leads(segment);
CREATE INDEX idx_leads_sales_stage ON leads(sales_stage);

PRAGMA defer_foreign_keys = off;
