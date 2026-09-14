import type { Env } from './env';
import { isDryRun } from './env';

export type ZohoErrorKind = 'auth' | 'rate' | 'transient' | 'permanent';
export type ZohoErrorCode =
  | 'auth_failed'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'invalid_recipient'
  | 'sender_not_verified'
  | 'provider_rejected'
  | 'unknown_provider_error';

export class ZohoError extends Error {
  kind: ZohoErrorKind;
  status: number;
  code: ZohoErrorCode;
  retryAfterSeconds: number | null;
  providerDescription: string;
  constructor(kind: ZohoErrorKind, status: number, message: string, code: ZohoErrorCode = 'unknown_provider_error', retryAfterSeconds: number | null = null, providerDescription = message) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
    this.providerDescription = providerDescription;
  }
}

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
}

// Per-isolate memo; D1 config row 'zoho_token' shares the cache across isolates.
let memo: CachedToken | null = null;

const REFRESH_MARGIN_MS = 120_000;

function tokenValid(t: CachedToken | null): t is CachedToken {
  return !!t && t.expiresAt - REFRESH_MARGIN_MS > Date.now();
}

async function refreshAccessToken(env: Env): Promise<CachedToken> {
  const body = new URLSearchParams({
    refresh_token: env.ZOHO_REFRESH_TOKEN,
    grant_type: 'refresh_token',
    client_id: env.ZOHO_CLIENT_ID,
    client_secret: env.ZOHO_CLIENT_SECRET,
  });
  const res = await fetch(`${env.ZOHO_ACCOUNTS_BASE}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = (await res.json().catch(() => null)) as
    | { access_token?: string; expires_in?: number; error?: string }
    | null;
  if (!res.ok || !json?.access_token) {
    const description = json?.error ?? `HTTP ${res.status}`;
    throw new ZohoError('auth', res.status, `Zoho token refresh failed: ${description}`, 'auth_failed', null, description);
  }
  return {
    token: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
}

export async function getAccessToken(env: Env, force = false): Promise<string> {
  if (!force && tokenValid(memo)) return memo.token;

  if (!force) {
    const row = await env.DB
      .prepare(`SELECT value FROM config WHERE key = 'zoho_token'`)
      .first<{ value: string }>();
    if (row) {
      try {
        const cached = JSON.parse(row.value) as CachedToken;
        if (tokenValid(cached)) {
          memo = cached;
          return cached.token;
        }
      } catch {
        // fall through to refresh
      }
    }
  }

  const fresh = await refreshAccessToken(env);
  memo = fresh;
  await env.DB
    .prepare(
      `INSERT INTO config (key, value, updated_at) VALUES ('zoho_token', ?1, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(JSON.stringify(fresh))
    .run();
  return fresh.token;
}

function classifyStatus(status: number, zohoCode: string | number | undefined): ZohoErrorKind {
  if (status === 401 || zohoCode === 'INVALID_OAUTHTOKEN') return 'auth';
  if (status === 429) return 'rate';
  if (status >= 500) return 'transient';
  return 'permanent';
}

function normalizeZohoCode(status: number, zohoCode: string | number | undefined, description: string): ZohoErrorCode {
  const code = String(zohoCode ?? '').toLowerCase();
  const text = `${code} ${description}`.toLowerCase();
  if (status === 401 || text.includes('oauth') || text.includes('token')) return 'auth_failed';
  if (status === 429 || text.includes('rate')) return 'rate_limited';
  if (status >= 500 || text.includes('internal error') || text.includes('temporarily')) return 'provider_unavailable';
  if (text.includes('recipient') || text.includes('invalid email') || text.includes('mail address')) return 'invalid_recipient';
  if (text.includes('from') || text.includes('sender') || text.includes('permission') || text.includes('not allowed')) return 'sender_not_verified';
  if (status >= 400) return 'provider_rejected';
  return 'unknown_provider_error';
}

export interface SendMailResult {
  dryRun: boolean;
  providerMessageId: string | null;
  internetMessageId: string | null;
}

export interface SendMailArgs {
  to: string;
  subject: string;
  content: string;
  cc?: string;
  bcc?: string;
  from?: string;
}

/**
 * Keeps the provider payload explicit and testable. Zoho documents ccAddress
 * for its send-message endpoint; omit it when no internal mailbox is set.
 */
export function buildSendMailPayload(env: Env, args: SendMailArgs): Record<string, string> {
  return {
    fromAddress: args.from?.trim() || env.FROM_EMAIL,
    toAddress: args.to,
    ...(args.cc?.trim() ? { ccAddress: args.cc.trim() } : {}),
    ...(args.bcc?.trim() ? { bccAddress: args.bcc.trim() } : {}),
    subject: args.subject,
    content: args.content,
    mailFormat: 'html',
    askReceipt: 'no',
  };
}

/**
 * Send one HTML email via the Zoho Mail API.
 * With DRY_RUN=true it logs and succeeds without touching the network -
 * used for local testing and safe production rehearsal.
 */
export async function sendMail(
  env: Env,
  args: SendMailArgs
): Promise<SendMailResult> {
  if (isDryRun(env)) {
    const domain = args.to.slice(args.to.lastIndexOf('@'));
    console.log(`[dry-run] would send email to=***${domain} subject-length=${args.subject.length}`);
    return { dryRun: true, providerMessageId: null, internetMessageId: null };
  }

  const token = await getAccessToken(env);
  let res: Response;
  try {
    res = await fetch(`${env.ZOHO_MAIL_BASE}/api/accounts/${env.ZOHO_ACCOUNT_ID}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildSendMailPayload(env, args)),
    });
  } catch (err) {
    const description = err instanceof Error ? err.message : String(err);
    throw new ZohoError('transient', 0, 'Zoho is temporarily unreachable', 'provider_unavailable', null, description);
  }

  if (res.ok) {
    const json = (await res.json().catch(() => null)) as
      | { data?: { messageId?: string | number; mailId?: string } }
      | null;
    return {
      dryRun: false,
      providerMessageId: json?.data?.messageId ? String(json.data.messageId) : null,
      internetMessageId: json?.data?.mailId ? String(json.data.mailId) : null,
    };
  }

  const raw = await res.text().catch(() => '');
  type ZohoErrorResponse = { status?: { code?: number | string; description?: string }; data?: { errorCode?: string }; message?: string; error?: string };
  let json: ZohoErrorResponse | null = null;
  try { json = raw ? JSON.parse(raw) as ZohoErrorResponse : null; } catch { /* preserve raw provider response below */ }
  const zohoCode = json?.data?.errorCode ?? json?.status?.code;
  const description = json?.status?.description ?? json?.message ?? json?.error ?? (raw.trim().slice(0, 180) || `HTTP ${res.status}`);
  const kind = classifyStatus(res.status, zohoCode);
  const code = normalizeZohoCode(res.status, zohoCode, description);
  const retryAfter = Number.parseInt(res.headers.get('Retry-After') ?? '', 10);
  throw new ZohoError(kind, res.status, `Zoho send failed: ${description}`, code, Number.isFinite(retryAfter) ? retryAfter : null, description);
}
