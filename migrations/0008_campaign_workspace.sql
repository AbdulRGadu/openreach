-- Campaign workspace: additive tables and message snapshots. Legacy outreach
-- remains unassigned instead of being rewritten into a campaign.
CREATE TABLE IF NOT EXISTS sender_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  display_name TEXT,
  sender_email TEXT NOT NULL UNIQUE,
  reply_email TEXT NOT NULL,
  cc_email TEXT,
  bcc_email TEXT,
  greeting TEXT NOT NULL DEFAULT 'Hi',
  fallback_greeting TEXT NOT NULL DEFAULT 'Hello',
  signoff TEXT NOT NULL DEFAULT 'Best regards',
  sender_name TEXT,
  cta TEXT NOT NULL DEFAULT 'Would it be useful if I sent it over?',
  footer_html TEXT NOT NULL DEFAULT '',
  quality_policy TEXT NOT NULL DEFAULT 'balanced' CHECK (quality_policy IN ('balanced','strict','custom')),
  is_verified INTEGER NOT NULL DEFAULT 0 CHECK (is_verified IN (0,1)),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','archived','completed')),
  objective TEXT,
  owner_label TEXT,
  notes TEXT,
  sender_profile_id TEXT REFERENCES sender_profiles(id),
  timezone TEXT NOT NULL DEFAULT 'Africa/Lagos',
  start_date TEXT,
  end_date TEXT,
  auto_send INTEGER NOT NULL DEFAULT 1 CHECK (auto_send IN (0,1)),
  follow_up_enabled INTEGER NOT NULL DEFAULT 1 CHECK (follow_up_enabled IN (0,1)),
  follow_up_delay_business_days INTEGER NOT NULL DEFAULT 4,
  send_window TEXT NOT NULL DEFAULT '09:00-16:00',
  send_days TEXT NOT NULL DEFAULT '1,2,3,4,5',
  daily_cap INTEGER NOT NULL DEFAULT 10,
  domain_weekly_cap INTEGER NOT NULL DEFAULT 2,
  maximum_volume INTEGER,
  quality_policy TEXT NOT NULL DEFAULT 'balanced' CHECK (quality_policy IN ('balanced','strict','custom')),
  tone TEXT,
  offer TEXT,
  cta TEXT,
  sector_angle TEXT,
  initial_template TEXT,
  follow_up_template TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);

CREATE TABLE IF NOT EXISTS campaign_leads (
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  lead_id TEXT NOT NULL REFERENCES leads(id),
  status TEXT NOT NULL DEFAULT 'eligible' CHECK (status IN ('eligible','excluded','queued','sent','replied','suppressed','failed','paused')),
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (campaign_id, lead_id)
);
CREATE INDEX IF NOT EXISTS idx_campaign_leads_lead ON campaign_leads(lead_id, status);

CREATE TABLE IF NOT EXISTS campaign_templates (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  step INTEGER NOT NULL CHECK (step IN (1,2)),
  subject_template TEXT,
  body_template TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(campaign_id, step)
);

CREATE TABLE IF NOT EXISTS campaign_send_policies (
  campaign_id TEXT PRIMARY KEY REFERENCES campaigns(id),
  send_days TEXT NOT NULL DEFAULT '1,2,3,4,5',
  send_window TEXT NOT NULL DEFAULT '09:00-16:00',
  daily_cap INTEGER NOT NULL DEFAULT 10,
  domain_weekly_cap INTEGER NOT NULL DEFAULT 2,
  maximum_volume INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS campaign_send_counters (
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  counter_day TEXT NOT NULL,
  counter_week TEXT NOT NULL,
  sent_today INTEGER NOT NULL DEFAULT 0,
  sent_this_week INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (campaign_id, counter_day)
);

CREATE TABLE IF NOT EXISTS sequence_events (
  id TEXT PRIMARY KEY,
  campaign_id TEXT REFERENCES campaigns(id),
  lead_id TEXT NOT NULL REFERENCES leads(id),
  message_id TEXT REFERENCES messages(id),
  event TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sequence_events_campaign ON sequence_events(campaign_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sequence_events_lead ON sequence_events(lead_id, created_at DESC);

ALTER TABLE messages ADD COLUMN campaign_id TEXT;
ALTER TABLE messages ADD COLUMN sender_profile_id TEXT;
ALTER TABLE messages ADD COLUMN sequence_step INTEGER NOT NULL DEFAULT 1;
ALTER TABLE messages ADD COLUMN settings_snapshot TEXT;
ALTER TABLE messages ADD COLUMN quality_snapshot TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_campaign ON messages(campaign_id, direction, status);
