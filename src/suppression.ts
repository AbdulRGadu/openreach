import { recordEvent } from './db';
import type { Env } from './env';
import { htmlResponse, isValidEmail, jsonResponse, normalizeText } from './http';
import { safeEqualStrings } from './auth';
import { domainOf } from './util/text';
import type { LeadRow } from './types';

const encoder = new TextEncoder();

/** Returns the suppression reason, or null when the address is clear to contact. */
export async function isSuppressed(db: D1Database, email: string, domain: string): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT reason FROM suppression
       WHERE (kind = 'email' AND value = ?1) OR (kind = 'domain' AND value = ?2)
       LIMIT 1`
    )
    .bind(email, domain)
    .first<{ reason: string }>();
  return row?.reason ?? null;
}

export async function addSuppression(
  db: D1Database,
  kind: 'email' | 'domain',
  value: string,
  reason: string,
  sourceMessageId?: string
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO suppression (id, kind, value, reason, source_message_id)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(kind, value) DO NOTHING`
    )
    .bind(crypto.randomUUID(), kind, value.toLowerCase(), reason, sourceMessageId ?? null)
    .run();
}

// --- Unsubscribe tokens (HMAC-SHA256 over the lead id, first 32 hex chars) ---

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function unsubTokenFor(env: Env, leadId: string): Promise<string> {
  const hex = await hmacHex(env.UNSUB_SECRET, leadId);
  return hex.slice(0, 32);
}

// --- Public endpoints / handlers ---

export async function handleUnsubscribe(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const leadId = url.searchParams.get('l') ?? '';
  const token = url.searchParams.get('t') ?? '';
  const notFound = () => new Response('Not found', { status: 404 });

  if (!leadId || !token || leadId.length > 64 || token.length > 64) return notFound();
  const expected = await unsubTokenFor(env, leadId);
  if (!(await safeEqualStrings(token, expected))) return notFound();

  const lead = await env.DB.prepare('SELECT * FROM leads WHERE id = ?1').bind(leadId).first<LeadRow>();
  if (!lead) return notFound();

  await addSuppression(env.DB, 'email', lead.email, 'unsubscribe');
  if (lead.status !== 'suppressed') {
    await env.DB
      .prepare(`UPDATE leads SET status = 'suppressed', updated_at = datetime('now') WHERE id = ?1`)
      .bind(leadId)
      .run();
    await recordEvent(env.DB, leadId, 'unsubscribed');
  }

  return htmlResponse(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<title>Unsubscribed</title></head>` +
      `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#1a202c">` +
      `<h1 style="font-size:1.25rem">You're unsubscribed</h1>` +
      `<p>You won't receive any further emails from this sender. Sorry to have bothered you.</p>` +
      `</body></html>`
  );
}

export async function handleSuppressionList(env: Env): Promise<Response> {
  const rows = await env.DB
    .prepare('SELECT id, kind, value, reason, created_at FROM suppression ORDER BY created_at DESC LIMIT 500')
    .all();
  return jsonResponse({ ok: true, suppression: rows.results });
}

export async function handleSuppressionAdd(body: Record<string, unknown>, env: Env): Promise<Response> {
  const kind = body.kind === 'domain' ? 'domain' : body.kind === 'email' ? 'email' : null;
  const value = normalizeText(body.value, 200).toLowerCase();
  const reason = normalizeText(body.reason, 100) || 'manual';
  if (!kind || !value) {
    return jsonResponse({ ok: false, error: "Provide kind ('email'|'domain') and value" }, 400);
  }
  const cleaned = kind === 'email' ? value : value.replace(/^@/, '');
  if (kind === 'email' && !isValidEmail(cleaned)) {
    return jsonResponse({ ok: false, error: 'Provide a valid email address' }, 400);
  }
  if (kind === 'domain' && !/^(?=.{1,190}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(cleaned)) {
    return jsonResponse({ ok: false, error: 'Provide a valid domain name' }, 400);
  }
  await addSuppression(env.DB, kind, cleaned, reason);
  // Reflect immediately on any matching lead so it can't be drafted/approved.
  await env.DB
    .prepare(
      `UPDATE leads SET status = 'suppressed', updated_at = datetime('now')
       WHERE ${kind === 'email' ? 'email' : 'domain'} = ?1
         AND status != 'suppressed'`
    )
    .bind(cleaned)
    .run();
  return jsonResponse({ ok: true });
}

export async function handleSuppressionDelete(id: string, env: Env): Promise<Response> {
  await env.DB.prepare('DELETE FROM suppression WHERE id = ?1').bind(id).run();
  return jsonResponse({ ok: true });
}

/** Batch helper for intake: returns keys 'email:<x>' / 'domain:<y>' that are suppressed. */
export async function loadSuppressedKeys(
  db: D1Database,
  emails: string[],
  domains: string[]
): Promise<Set<string>> {
  const keys = new Set<string>();
  const values = [...new Set([...emails, ...domains])];
  if (values.length === 0) return keys;
  const placeholders = values.map(() => '?').join(',');
  const rows = await db
    .prepare(`SELECT kind, value FROM suppression WHERE value IN (${placeholders})`)
    .bind(...values)
    .all<{ kind: string; value: string }>();
  for (const r of rows.results) keys.add(`${r.kind}:${r.value}`);
  return keys;
}

export function suppressionKeyHit(keys: Set<string>, email: string): boolean {
  return keys.has(`email:${email}`) || keys.has(`domain:${domainOf(email)}`);
}
