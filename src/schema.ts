import type { Env } from './env';
import type { ProspectSegment } from './services/leadSegmentation';
import schemaConvergenceMigration from '../migrations/0007_production_schema_convergence.sql';
import campaignWorkspaceMigration from '../migrations/0008_campaign_workspace.sql';
import scheduledQueueMigration from '../migrations/0009_scheduled_send_queue.sql';
import operationalStateMigration from '../migrations/0010_operational_message_states.sql';
import workspaceProfileMigration from '../migrations/0011_workspace_profile.sql';
import { formatD1ExecScript } from './util/sql';

const MIGRATION_ID = 11;
const MIGRATION_NAME = '0011_workspace_profile.sql';
const REQUIRED_COLUMNS = {
  leads: {
    sub_industry: 'sub_industry TEXT',
    sales_stage: "sales_stage TEXT NOT NULL DEFAULT 'prospecting'",
    next_action: 'next_action TEXT',
    country: 'country TEXT',
    company_size: 'company_size TEXT',
    contact_profile_url: 'contact_profile_url TEXT',
    source_url: 'source_url TEXT',
    structured_notes: 'structured_notes TEXT',
    discovery_score: 'discovery_score INTEGER',
    data_confidence: 'data_confidence INTEGER',
    last_verified_at: 'last_verified_at TEXT',
    delivery_test: 'delivery_test INTEGER NOT NULL DEFAULT 0 CHECK (delivery_test IN (0,1))',
    is_demo: 'is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0,1))',
  },
  messages: {
    next_action: 'next_action TEXT',
    received_at: 'received_at TEXT',
    buyer_persona: 'buyer_persona TEXT',
    relevance_context: 'relevance_context TEXT',
    recommended_offer: 'recommended_offer TEXT',
    recommended_cta: 'recommended_cta TEXT',
    draft_quality_status: "draft_quality_status TEXT CHECK (draft_quality_status IN ('passed','needs_review'))",
    validation_warnings: 'validation_warnings TEXT',
    next_step_plan: 'next_step_plan TEXT',
    campaign_id: 'campaign_id TEXT',
    sender_profile_id: 'sender_profile_id TEXT',
    sequence_step: 'sequence_step INTEGER NOT NULL DEFAULT 1',
    settings_snapshot: 'settings_snapshot TEXT',
    quality_snapshot: 'quality_snapshot TEXT',
    scheduled_at: 'scheduled_at TEXT',
    sendability_status: "sendability_status TEXT NOT NULL DEFAULT 'needs_review'",
    status_reason: 'status_reason TEXT',
    error_code: 'error_code TEXT',
    error_detail: 'error_detail TEXT',
    retry_at: 'retry_at TEXT',
    last_attempt_at: 'last_attempt_at TEXT',
    sender_display_name: 'sender_display_name TEXT',
    provider_status: 'provider_status TEXT',
    stopped_at: 'stopped_at TEXT',
    stopped_reason: 'stopped_reason TEXT',
    profile_snapshot: 'profile_snapshot TEXT',
  },
} as const;

const OPERATIONAL_REQUIRED_COLUMNS = {
  sender_profiles: {
    display_name_verified: 'display_name_verified INTEGER NOT NULL DEFAULT 0',
  },
  campaign_leads: {
    status_reason: 'status_reason TEXT',
  },
} as const;

const CAMPAIGN_REQUIRED_COLUMNS = {
  send_start_time: "send_start_time TEXT NOT NULL DEFAULT '09:00'",
  send_interval_minutes: 'send_interval_minutes INTEGER NOT NULL DEFAULT 2',
} as const;

const REPLY_INGEST_SCHEMA = `
CREATE TABLE IF NOT EXISTS reply_ingest_logs (
  id TEXT PRIMARY KEY,
  from_email TEXT,
  message_id TEXT,
  in_reply_to TEXT,
  references_header TEXT,
  raw_payload TEXT,
  auth_status TEXT NOT NULL CHECK (auth_status IN ('authorized','unauthorized')),
  match_status TEXT CHECK (match_status IN (
    'matched_by_message_id','matched_by_in_reply_to','matched_by_sender_email',
    'matched_by_sender_domain','unmatched'
  )),
  classification_status TEXT NOT NULL DEFAULT 'pending' CHECK (classification_status IN
    ('pending','classified','failed','skipped')),
  classification TEXT,
  confidence REAL,
  lead_id TEXT,
  inbound_message_id TEXT,
  error TEXT,
  payload_received_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reply_ingest_created ON reply_ingest_logs(payload_received_at DESC);
CREATE INDEX IF NOT EXISTS idx_reply_ingest_message ON reply_ingest_logs(message_id);
`;

// Runtime convergence is idempotent. The checked-in migration still contains
// ALTER statements for Wrangler's migration runner, so omit those here after
// ensureColumn has made each message field safe to add concurrently.
const CAMPAIGN_RUNTIME_SCHEMA = formatD1ExecScript(campaignWorkspaceMigration)
  .split('\n')
  .filter((statement) => !/^ALTER TABLE messages ADD COLUMN /i.test(statement))
  .join('\n');
const SCHEDULED_QUEUE_RUNTIME_SCHEMA = formatD1ExecScript(scheduledQueueMigration)
  .split('\n')
  .filter((statement) => !/^ALTER TABLE /i.test(statement))
  .join('\n');
const OPERATIONAL_RUNTIME_SCHEMA = formatD1ExecScript(operationalStateMigration)
  .split('\n')
  .filter((statement) => !/^ALTER TABLE /i.test(statement))
  .join('\n');

let readiness: Promise<void> | null = null;

async function tableColumns(db: D1Database, table: string): Promise<Set<string>> {
  const rows = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return new Set(rows.results.map((row) => row.name));
}

async function coreSchemaIsReady(db: D1Database): Promise<boolean> {
  const [leadColumns, messageColumns] = await Promise.all([
    tableColumns(db, 'leads'),
    tableColumns(db, 'messages'),
  ]);
  const replyTable = await db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'reply_ingest_logs'"
  ).first<{ present: number }>();
  const definitions = await db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('leads','messages')"
  ).all<{ name: string; sql: string }>();
  const sql = new Map(definitions.results.map((row) => [row.name, row.sql ?? '']));
  return Object.keys(REQUIRED_COLUMNS.leads).every((name) => leadColumns.has(name))
    && Object.keys(REQUIRED_COLUMNS.messages).every((name) => messageColumns.has(name))
    && !!replyTable
    && (sql.get('leads') ?? '').includes("'replied_positive'")
    && (sql.get('messages') ?? '').includes("'needs_review'");
}

async function schemaIsReady(db: D1Database): Promise<boolean> {
  if (!(await coreSchemaIsReady(db))) return false;
  const tables = await db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('sender_profiles','campaigns','campaign_leads','campaign_templates','campaign_send_policies','campaign_send_counters','sequence_events')"
  ).all<{ name: string }>();
  if (tables.results.length !== 7) return false;
  const [profileColumns, campaignLeadColumns] = await Promise.all([
    tableColumns(db, 'sender_profiles'),
    tableColumns(db, 'campaign_leads'),
  ]);
  const workspace = await db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='workspace_profile'").first<{ present: number }>();
  return profileColumns.has('display_name_verified') && campaignLeadColumns.has('status_reason') && !!workspace;
}

async function recordMigration(db: D1Database): Promise<void> {
  await db.prepare(
    'INSERT OR IGNORE INTO d1_migrations (id, name) VALUES (?1, ?2)'
  ).bind(MIGRATION_ID, MIGRATION_NAME).run();
}

async function ensureColumn(db: D1Database, table: keyof typeof REQUIRED_COLUMNS, name: string, definition: string): Promise<void> {
  if ((await tableColumns(db, table)).has(name)) return;
  try {
    await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${definition}`).run();
  } catch (error) {
    // Concurrent isolates can race on the same additive migration.
    if (!(await tableColumns(db, table)).has(name)) throw error;
  }
}

async function applyRequiredSchema(env: Env): Promise<void> {
  const ensureColumns = async () => {
    for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
      for (const [name, definition] of Object.entries(columns)) {
        await ensureColumn(env.DB, table as keyof typeof REQUIRED_COLUMNS, name, definition);
      }
    }
  };
  await ensureColumns();
  await env.DB.exec(formatD1ExecScript(REPLY_INGEST_SCHEMA));
  if (!(await coreSchemaIsReady(env.DB))) {
    try {
      await env.DB.exec(formatD1ExecScript(schemaConvergenceMigration));
    } catch (error) {
      // Concurrent isolates can race while converging the same legacy schema.
      if (!(await coreSchemaIsReady(env.DB))) throw error;
    }
  }
  await ensureColumns();
  await env.DB.exec(CAMPAIGN_RUNTIME_SCHEMA);
  for (const [name, definition] of Object.entries(CAMPAIGN_REQUIRED_COLUMNS)) {
    await ensureColumn(env.DB, 'campaigns' as keyof typeof REQUIRED_COLUMNS, name, definition);
  }
  await env.DB.exec(SCHEDULED_QUEUE_RUNTIME_SCHEMA);
  for (const [table, columns] of Object.entries(OPERATIONAL_REQUIRED_COLUMNS)) {
    for (const [name, definition] of Object.entries(columns)) {
      const existing = await tableColumns(env.DB, table);
      if (existing.has(name)) continue;
      try {
        await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${definition}`).run();
      } catch (error) {
        if (!(await tableColumns(env.DB, table)).has(name)) throw error;
      }
    }
  }
  await env.DB.exec(OPERATIONAL_RUNTIME_SCHEMA);
  await env.DB.exec(formatD1ExecScript(workspaceProfileMigration).split('\n').filter((statement) => !/^ALTER TABLE /i.test(statement)).join('\n'));
  await ensureColumn(env.DB, 'leads', 'is_demo', "is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0,1))");
  if (!(await schemaIsReady(env.DB))) throw new Error('Campaign workspace schema remains incomplete');
  await recordMigration(env.DB);
}

/**
 * Git-based Worker deploys do not run D1 migrations. Ensure the schema required
 * by the deployed code exists before serving API, queue, or scheduled work.
 */
export async function ensureDraftingSchema(env: Env): Promise<void> {
  readiness ??= applyRequiredSchema(env).catch((error) => {
    readiness = null;
    throw error;
  });
  return readiness;
}

/** Store new strategy segments safely while a legacy D1 CHECK constraint exists. */
export async function compatibleLeadSegment(db: D1Database, segment: ProspectSegment): Promise<string> {
  const row = await db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'leads'"
  ).first<{ sql: string }>();
  if (row?.sql?.includes("'general_business'")) return segment;
  if (segment === 'education') return 'school';
  if (['ecommerce', 'professional_services', 'general_business'].includes(segment)) return 'other';
  return segment;
}
