-- Deterministic outreach strategy and review metadata.
PRAGMA defer_foreign_keys = on;

-- Expand the lead segment taxonomy used by the deterministic drafting engine.
CREATE TABLE leads_with_draft_strategy (
  id                    TEXT PRIMARY KEY,
  email                 TEXT NOT NULL UNIQUE,
  domain                TEXT NOT NULL,
  first_name            TEXT,
  last_name             TEXT,
  role                   TEXT,
  company                TEXT,
  company_website        TEXT,
  industry               TEXT,
  sub_industry           TEXT,
  segment                TEXT CHECK (segment IN (
    'fintech','healthcare','education','logistics','saas','ecommerce',
    'professional_services','general_business'
  )),
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

INSERT INTO leads_with_draft_strategy (
  id, email, domain, first_name, last_name, role, company, company_website,
  industry, sub_industry, segment, fit_score, fit_reason, pain_points, source,
  status, last_reply_classification, notes, created_at, updated_at, sales_stage,
  next_action, country, company_size, contact_profile_url, source_url,
  structured_notes, discovery_score, data_confidence, last_verified_at
)
SELECT
  id, email, domain, first_name, last_name, role, company, company_website,
  industry, NULL,
  CASE segment
    WHEN 'school' THEN 'education'
    WHEN 'enterprise' THEN 'general_business'
    WHEN 'sme' THEN 'general_business'
    WHEN 'other' THEN 'general_business'
    ELSE segment
  END,
  fit_score, fit_reason, pain_points, source, status, last_reply_classification,
  notes, created_at, updated_at, sales_stage, next_action, country, company_size,
  contact_profile_url, source_url, structured_notes, discovery_score,
  data_confidence, last_verified_at
FROM leads;

DROP TABLE leads;
ALTER TABLE leads_with_draft_strategy RENAME TO leads;
CREATE INDEX idx_leads_status ON leads(status);
CREATE INDEX idx_leads_domain ON leads(domain);
CREATE INDEX idx_leads_segment ON leads(segment);
CREATE INDEX idx_leads_sales_stage ON leads(sales_stage);

ALTER TABLE messages ADD COLUMN buyer_persona TEXT;
ALTER TABLE messages ADD COLUMN security_context TEXT;
ALTER TABLE messages ADD COLUMN recommended_offer TEXT;
ALTER TABLE messages ADD COLUMN recommended_cta TEXT;
ALTER TABLE messages ADD COLUMN draft_quality_status TEXT CHECK (draft_quality_status IN ('passed','needs_review'));
ALTER TABLE messages ADD COLUMN validation_warnings TEXT;
ALTER TABLE messages ADD COLUMN next_step_plan TEXT;

PRAGMA defer_foreign_keys = off;
