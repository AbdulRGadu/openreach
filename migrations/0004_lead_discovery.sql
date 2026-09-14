-- Human-reviewed lead discovery and enrichment.
-- Candidates are staged here before they can enter the outbound lead pipeline.

ALTER TABLE leads ADD COLUMN country TEXT;
ALTER TABLE leads ADD COLUMN company_size TEXT;
ALTER TABLE leads ADD COLUMN contact_profile_url TEXT;
ALTER TABLE leads ADD COLUMN source_url TEXT;
ALTER TABLE leads ADD COLUMN structured_notes TEXT;          -- JSON research brief
ALTER TABLE leads ADD COLUMN discovery_score INTEGER;
ALTER TABLE leads ADD COLUMN data_confidence INTEGER;
ALTER TABLE leads ADD COLUMN last_verified_at TEXT;

CREATE TABLE discovery_candidates (
  id                    TEXT PRIMARY KEY,
  company               TEXT,
  company_domain        TEXT,
  company_website       TEXT,
  industry              TEXT,
  country               TEXT,
  company_size          TEXT,
  contact_email         TEXT,
  contact_first_name    TEXT,
  contact_last_name     TEXT,
  contact_role          TEXT,
  contact_profile_url   TEXT,
  source_type           TEXT NOT NULL CHECK (source_type IN (
    'company_website','public_business_directory','business_registry',
    'event_or_membership_list','public_news','professional_profile',
    'partner_referral','customer_referral','inbound_request',
    'manual_research','csv_import','official_api'
  )),
  raw_notes             TEXT,
  structured_notes      TEXT,                    -- JSON; see StructuredDiscoveryNotes in src/types.ts
  company_fit_score     INTEGER,
  role_relevance_score  INTEGER,
  timing_signal_score   INTEGER,
  discovery_score       INTEGER,
  data_confidence       INTEGER,
  score_reason          TEXT,
  status                TEXT NOT NULL DEFAULT 'new' CHECK (status IN
    ('new','enriched','needs_research','accepted','rejected','failed')),
  lead_id               TEXT REFERENCES leads(id),
  last_error            TEXT,
  discovered_at         TEXT NOT NULL DEFAULT (datetime('now')),
  last_verified_at      TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_discovery_status ON discovery_candidates(status, updated_at);
CREATE INDEX idx_discovery_company_domain ON discovery_candidates(company_domain);
CREATE INDEX idx_discovery_contact_email ON discovery_candidates(contact_email);
CREATE INDEX idx_discovery_source_type ON discovery_candidates(source_type);

-- Keep source evidence separate so one candidate/lead can have multiple public references.
CREATE TABLE discovery_sources (
  id             TEXT PRIMARY KEY,
  candidate_id   TEXT NOT NULL REFERENCES discovery_candidates(id) ON DELETE CASCADE,
  lead_id        TEXT REFERENCES leads(id),
  source_type    TEXT NOT NULL,
  source_url     TEXT,
  source_title   TEXT,
  evidence       TEXT,
  observed_at    TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_discovery_sources_candidate ON discovery_sources(candidate_id);
CREATE INDEX idx_discovery_sources_lead ON discovery_sources(lead_id);
