-- Converge databases that received 0001/0002 plus additive drafting columns
-- through Git-based Worker deploys, but missed the state-machine migrations.
-- The temporary backup removes the messages -> leads foreign key while leads
-- is rebuilt, then restores the relationship in the final messages table.
PRAGMA defer_foreign_keys = on;

DROP TABLE IF EXISTS messages_v7_backup;
DROP TABLE IF EXISTS leads_v7;

CREATE TABLE messages_v7_backup AS SELECT * FROM messages;
DROP TABLE messages;

CREATE TABLE leads_v7 (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  domain TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  role TEXT,
  company TEXT,
  company_website TEXT,
  industry TEXT,
  sub_industry TEXT,
  segment TEXT CHECK (segment IN (
    'fintech','healthcare','education','logistics','saas','ecommerce',
    'professional_services','general_business'
  )),
  fit_score INTEGER,
  fit_reason TEXT,
  pain_points TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN (
    'new','scored','drafted','approved','queued','sent','replied_positive',
    'meeting_requested','asked_for_more_info','referred','not_now','not_interested',
    'suppressed','unmatched_reply','manual_review','failed'
  )),
  last_reply_classification TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  sales_stage TEXT NOT NULL DEFAULT 'prospecting',
  next_action TEXT,
  country TEXT,
  company_size TEXT,
  contact_profile_url TEXT,
  source_url TEXT,
  structured_notes TEXT,
  discovery_score INTEGER,
  data_confidence INTEGER,
  last_verified_at TEXT,
  delivery_test INTEGER NOT NULL DEFAULT 0 CHECK (delivery_test IN (0,1))
);

INSERT INTO leads_v7 (
  id, email, domain, first_name, last_name, role, company, company_website,
  industry, sub_industry, segment, fit_score, fit_reason, pain_points, source,
  status, last_reply_classification, notes, created_at, updated_at, sales_stage,
  next_action, country, company_size, contact_profile_url, source_url,
  structured_notes, discovery_score, data_confidence, last_verified_at, delivery_test
)
SELECT
  id, email, domain, first_name, last_name, role, company, company_website,
  industry, sub_industry,
  CASE segment
    WHEN 'school' THEN 'education'
    WHEN 'enterprise' THEN 'general_business'
    WHEN 'sme' THEN 'general_business'
    WHEN 'other' THEN 'general_business'
    ELSE segment
  END,
  fit_score, fit_reason, pain_points, source,
  CASE status
    WHEN 'replied' THEN 'manual_review'
    WHEN 'bounced' THEN 'failed'
    WHEN 'unsubscribed' THEN 'suppressed'
    WHEN 'disqualified' THEN 'not_interested'
    ELSE status
  END,
  last_reply_classification, notes, created_at, updated_at, sales_stage,
  next_action, country, company_size, contact_profile_url, source_url,
  structured_notes, discovery_score, data_confidence, last_verified_at, 0
FROM leads;

DROP TABLE leads;
ALTER TABLE leads_v7 RENAME TO leads;
CREATE INDEX idx_leads_status ON leads(status);
CREATE INDEX idx_leads_domain ON leads(domain);
CREATE INDEX idx_leads_segment ON leads(segment);
CREATE INDEX idx_leads_sales_stage ON leads(sales_stage);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  lead_id TEXT REFERENCES leads(id),
  direction TEXT NOT NULL CHECK (direction IN ('outbound','inbound')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft','needs_review','approved','queued','sending','sent','failed',
    'rejected','send_unknown','received'
  )),
  subject TEXT,
  body TEXT,
  from_email TEXT,
  to_email TEXT,
  classification TEXT,
  confidence REAL,
  summary TEXT,
  suggested_reply TEXT,
  ai_model TEXT,
  prompt_version TEXT,
  zoho_message_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT,
  next_action TEXT,
  received_at TEXT,
  buyer_persona TEXT,
  security_context TEXT,
  recommended_offer TEXT,
  recommended_cta TEXT,
  draft_quality_status TEXT CHECK (draft_quality_status IN ('passed','needs_review')),
  validation_warnings TEXT,
  next_step_plan TEXT
);

INSERT INTO messages (
  id, lead_id, direction, status, subject, body, from_email, to_email,
  classification, confidence, summary, suggested_reply, ai_model, prompt_version,
  zoho_message_id, attempts, error, created_at, updated_at, sent_at, next_action,
  received_at, buyer_persona, security_context, recommended_offer, recommended_cta,
  draft_quality_status, validation_warnings, next_step_plan
)
SELECT
  id, lead_id, direction, status, subject, body, from_email, to_email,
  classification, confidence, summary, suggested_reply, ai_model, prompt_version,
  zoho_message_id, attempts, error, created_at, updated_at, sent_at, next_action,
  received_at, buyer_persona, security_context, recommended_offer, recommended_cta,
  draft_quality_status, validation_warnings, next_step_plan
FROM messages_v7_backup;

DROP TABLE messages_v7_backup;
CREATE INDEX idx_messages_lead ON messages(lead_id);
CREATE INDEX idx_messages_status ON messages(direction, status);
CREATE UNIQUE INDEX idx_messages_zoho_in ON messages(zoho_message_id)
  WHERE zoho_message_id IS NOT NULL AND direction = 'inbound';

PRAGMA defer_foreign_keys = off;
