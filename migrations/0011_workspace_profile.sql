-- Workspace-level business context. This is deliberately additive so historical
-- messages remain untouched while new drafts can carry a profile snapshot.
CREATE TABLE IF NOT EXISTS workspace_profile (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  business_name TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  industry TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  services TEXT NOT NULL DEFAULT '[]',
  ideal_customer TEXT NOT NULL DEFAULT '',
  target_industries TEXT NOT NULL DEFAULT '[]',
  target_roles TEXT NOT NULL DEFAULT '[]',
  pain_points TEXT NOT NULL DEFAULT '[]',
  differentiators TEXT NOT NULL DEFAULT '[]',
  offer TEXT NOT NULL DEFAULT '',
  cta TEXT NOT NULL DEFAULT '',
  tone TEXT NOT NULL DEFAULT 'helpful, concise, and professional',
  geography TEXT NOT NULL DEFAULT '',
  claims_to_avoid TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1,
  demo_mode INTEGER NOT NULL DEFAULT 0 CHECK (demo_mode IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE leads ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0,1));
ALTER TABLE messages ADD COLUMN profile_snapshot TEXT;
ALTER TABLE messages ADD COLUMN relevance_context TEXT;

-- Never auto-send legacy unsent drafts generated for the retired fixed business context.
-- Sent mail and lead records remain untouched; these drafts must be regenerated and reviewed.
UPDATE messages
SET status = 'needs_review',
    draft_quality_status = 'needs_review',
    sendability_status = 'needs_review',
    status_reason = 'Legacy draft requires regeneration under the Workspace Profile',
    next_action = 'regenerate_under_workspace_profile',
    scheduled_at = NULL,
    updated_at = datetime('now')
WHERE direction = 'outbound'
  AND profile_snapshot IS NULL
  AND status IN ('draft','needs_review','approved','queued','failed');

-- Campaign automation used to bypass explicit approval. Park any queued items it left behind.
UPDATE messages
SET status = 'needs_review',
    sendability_status = 'needs_review',
    status_reason = 'Legacy automated queue blocked; human approval required',
    next_action = 'review_and_approve_draft',
    scheduled_at = NULL,
    updated_at = datetime('now')
WHERE direction = 'outbound'
  AND status = 'queued'
  AND status_reason IN ('Scheduled by campaign automation','Scheduled follow-up');
