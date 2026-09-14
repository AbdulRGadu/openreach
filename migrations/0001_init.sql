-- Centrisec Outreach: initial schema
-- Lead lifecycle: new -> scored -> drafted -> approved -> queued -> sent
--   -> replied | bounced | unsubscribed | disqualified
-- A rejected draft returns the lead to 'scored'.

CREATE TABLE leads (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  domain      TEXT NOT NULL,
  first_name  TEXT,
  last_name   TEXT,
  role        TEXT,
  company     TEXT,
  company_website TEXT,
  industry    TEXT,
  segment     TEXT CHECK (segment IN ('fintech','healthcare','school','logistics','saas','enterprise','sme','other')),
  fit_score   INTEGER,
  fit_reason  TEXT,
  pain_points TEXT,                               -- JSON array string
  source      TEXT NOT NULL DEFAULT 'manual',     -- csv|sheets|form|directory|linkedin|referral|manual
  status      TEXT NOT NULL DEFAULT 'new' CHECK (status IN
    ('new','scored','drafted','approved','queued','sent','replied','bounced','unsubscribed','disqualified')),
  last_reply_classification TEXT,
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_leads_status  ON leads(status);
CREATE INDEX idx_leads_domain  ON leads(domain);
CREATE INDEX idx_leads_segment ON leads(segment);

-- Outbound and inbound share one table: one per-lead timeline, one status machine.
CREATE TABLE messages (
  id         TEXT PRIMARY KEY,
  lead_id    TEXT REFERENCES leads(id),           -- nullable: orphan inbound kept for manual review
  direction  TEXT NOT NULL CHECK (direction IN ('outbound','inbound')),
  status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN
    ('draft','approved','queued','sending','sent','failed','rejected','send_unknown','received')),
  subject    TEXT,
  body       TEXT,
  from_email TEXT,
  to_email   TEXT,
  classification  TEXT,                           -- inbound classification; taxonomy is versioned in src/ai/schemas.ts
  confidence      REAL,                           -- inbound, 0-1
  summary         TEXT,                           -- inbound, one-line AI summary for the team
  suggested_reply TEXT,                           -- inbound, positive classes only; never auto-sent
  ai_model   TEXT,
  prompt_version TEXT,
  zoho_message_id TEXT,                           -- inbound Message-ID for dedupe
  attempts   INTEGER NOT NULL DEFAULT 0,
  error      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at    TEXT
);
CREATE INDEX idx_messages_lead   ON messages(lead_id);
CREATE INDEX idx_messages_status ON messages(direction, status);
CREATE UNIQUE INDEX idx_messages_zoho_in ON messages(zoho_message_id)
  WHERE zoho_message_id IS NOT NULL AND direction = 'inbound';

CREATE TABLE suppression (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('email','domain')),
  value      TEXT NOT NULL,                       -- lowercased email or bare domain
  reason     TEXT NOT NULL,                       -- remove_me|not_interested|complaint|hard_bounce|unsubscribe|manual
  source_message_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_suppression_value ON suppression(kind, value);

-- Audit trail. detail holds small JSON with ids and codes only - never bodies or PII.
CREATE TABLE lead_events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id TEXT NOT NULL,
  event   TEXT NOT NULL,
  detail  TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_events_lead ON lead_events(lead_id, created_at);

-- Daily send counter, keyed by Africa/Lagos calendar day.
CREATE TABLE send_counters (
  day   TEXT PRIMARY KEY,                         -- 'YYYY-MM-DD'
  count INTEGER NOT NULL DEFAULT 0
);

-- Small key/value store: Zoho token cache, runtime overrides.
CREATE TABLE config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
