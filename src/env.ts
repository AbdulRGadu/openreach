import type { SendJob } from './types';

export interface Env {
  // Bindings
  DB: D1Database;
  SEND_QUEUE: Queue<SendJob>;
  ASSETS: Fetcher;

  // Vars (wrangler.jsonc)
  CF_ACCOUNT_ID: string;
  AI_GATEWAY_ID: string;
  AI_PROVIDER: string;
  DEFAULT_AI_MODEL: string;
  AVAILABLE_AI_MODELS: string;
  ZOHO_MAIL_BASE: string;
  ZOHO_ACCOUNTS_BASE: string;
  ZOHO_ACCOUNT_ID: string;
  FROM_EMAIL: string;
  FROM_NAME: string;
  /** A visible internal copy on every outbound outreach email. */
  OUTREACH_CC_EMAIL: string;
  PUBLIC_BASE_URL: string;
  PHYSICAL_ADDRESS: string;
  DAILY_SEND_CAP: string;
  DOMAIN_WEEKLY_CAP: string;
  SEND_WINDOW: string;
  SEND_DAYS: string;
  TIMEZONE: string;
  SCORE_BATCH: string;
  DRAFT_BATCH: string;
  FIT_THRESHOLD: string;
  DRY_RUN: string;
  VISIBLE_UNSUBSCRIBE_URL_ENABLED: string;
  REPLY_BASED_OPT_OUT_ENABLED: string;

  // Secrets (wrangler secret / .dev.vars)
  API_KEY: string;
  DASHBOARD_PIN?: string;
  CF_AI_TOKEN: string;
  ZOHO_CLIENT_ID: string;
  ZOHO_CLIENT_SECRET: string;
  ZOHO_REFRESH_TOKEN: string;
  N8N_WEBHOOK_SECRET: string;
  UNSUB_SECRET: string;
}

export function intVar(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function isDryRun(env: Env): boolean {
  return env.DRY_RUN === 'true' || env.DRY_RUN === '1';
}
