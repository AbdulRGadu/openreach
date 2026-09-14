import { inPlaceholders, recordEvent, recordEventStmt } from './db';
import type { Env } from './env';
import { HttpError, isValidEmail, jsonResponse, normalizeMultiline, normalizeText } from './http';
import { addSuppression, loadSuppressedKeys, suppressionKeyHit } from './suppression';
import type { LeadRow, MessageRow } from './types';
import { buildFooter, domainOf } from './util/text';
import { getOutreachSettings } from './services/outreachSettings.ts';

const SOURCES = new Set(['csv', 'sheets', 'form', 'directory', 'linkedin', 'referral', 'manual']);

interface PreparedLead {
  email: string;
  valid: boolean;
  firstName: string | null;
  lastName: string | null;
  role: string | null;
  company: string | null;
  companyWebsite: string | null;
  contactProfileUrl: string | null;
  industry: string | null;
  subIndustry: string | null;
  country: string | null;
  source: string;
  notes: string | null;
}

function prepareLead(raw: unknown): PreparedLead {
  const rec = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const email = normalizeText(rec.email, 180).toLowerCase();
  const source = normalizeText(rec.source, 40).toLowerCase();
  return {
    email,
    valid: !!email && isValidEmail(email),
    firstName: normalizeText(rec.firstName, 80) || null,
    lastName: normalizeText(rec.lastName, 80) || null,
    role: normalizeText(rec.role, 120) || null,
    company: normalizeText(rec.company, 160) || null,
    companyWebsite: normalizeText(rec.companyWebsite, 200) || null,
    contactProfileUrl: normalizeText(rec.contactProfileUrl, 300) || null,
    industry: normalizeText(rec.industry, 120) || null,
    subIndustry: normalizeText(rec.subIndustry, 120) || null,
    country: normalizeText(rec.country, 100) || null,
    source: SOURCES.has(source) ? source : 'manual',
    notes: normalizeMultiline(rec.notes, 2000) || null,
  };
}

export async function handleLeadsPost(body: Record<string, unknown>, env: Env): Promise<Response> {
  const rawLeads = body.leads;
  if (!Array.isArray(rawLeads) || rawLeads.length === 0) {
    throw new HttpError(400, 'Provide a non-empty leads array');
  }
  if (rawLeads.length > 100) {
    throw new HttpError(400, 'Max 100 leads per batch');
  }
  const allowDuplicates = body.allowDuplicates === true;

  const prepared = rawLeads.map(prepareLead);
  const validEmails = [...new Set(prepared.filter((p) => p.valid).map((p) => p.email))];
  const validDomains = [...new Set(validEmails.map(domainOf))];

  const suppressed = await loadSuppressedKeys(env.DB, validEmails, validDomains);

  const existingEmails = new Set<string>();
  if (validEmails.length > 0) {
    const rows = await env.DB
      .prepare(`SELECT email FROM leads WHERE email IN (${inPlaceholders(validEmails.length)})`)
      .bind(...validEmails)
      .all<{ email: string }>();
    for (const r of rows.results) existingEmails.add(r.email);
  }
  const existingDomains = new Set<string>();
  if (validDomains.length > 0) {
    const rows = await env.DB
      .prepare(`SELECT DISTINCT domain FROM leads WHERE domain IN (${inPlaceholders(validDomains.length)})`)
      .bind(...validDomains)
      .all<{ domain: string }>();
    for (const r of rows.results) existingDomains.add(r.domain);
  }

  const results: Array<Record<string, unknown>> = [];
  const stmts: D1PreparedStatement[] = [];
  const seenInBatch = new Set<string>();

  for (const p of prepared) {
    if (!p.valid) {
      results.push({ email: p.email || null, result: 'invalid' });
      continue;
    }
    if (suppressionKeyHit(suppressed, p.email)) {
      results.push({ email: p.email, result: 'suppressed' });
      continue;
    }
    if ((!allowDuplicates && existingEmails.has(p.email)) || seenInBatch.has(p.email)) {
      results.push({ email: p.email, result: 'duplicate_email' });
      continue;
    }
    seenInBatch.add(p.email);
    const id = crypto.randomUUID();
    const domain = domainOf(p.email);
    stmts.push(
      env.DB
        .prepare(
          `INSERT INTO leads (
             id, email, domain, first_name, last_name, role, company, company_website,
             industry, sub_industry, country, contact_profile_url, source, notes
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`
        )
        .bind(
          id,
          p.email,
          domain,
          p.firstName,
          p.lastName,
          p.role,
          p.company,
          p.companyWebsite,
          p.industry,
          p.subIndustry,
          p.country,
          p.contactProfileUrl,
          p.source,
          p.notes
        )
    );
    stmts.push(recordEventStmt(env.DB, id, 'created', { source: p.source }));
    results.push({
      email: p.email,
      result: 'inserted',
      id,
      ...(existingDomains.has(domain) ? { domainExists: true } : {}),
    });
    existingDomains.add(domain);
  }

  if (stmts.length > 0) await env.DB.batch(stmts);
  return jsonResponse({ ok: true, results });
}

export async function handleLeadsList(url: URL, env: Env): Promise<Response> {
  const status = normalizeText(url.searchParams.get('status'), 30);
  const segment = normalizeText(url.searchParams.get('segment'), 30);
  const q = normalizeText(url.searchParams.get('q'), 100);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
  const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);

  const where: string[] = [];
  const binds: unknown[] = [];
  if (status) {
    where.push(`status = ?${binds.length + 1}`);
    binds.push(status);
  }
  if (segment) {
    where.push(`segment = ?${binds.length + 1}`);
    binds.push(segment);
  }
  if (q) {
    const like = `%${q}%`;
    where.push(
      `(email LIKE ?${binds.length + 1} OR company LIKE ?${binds.length + 2} OR first_name LIKE ?${binds.length + 3} OR last_name LIKE ?${binds.length + 4})`
    );
    binds.push(like, like, like, like);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const totalRow = await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM leads ${whereSql}`)
    .bind(...binds)
    .first<{ n: number }>();
  const rows = await env.DB
    .prepare(
      `SELECT * FROM leads ${whereSql} ORDER BY updated_at DESC LIMIT ?${binds.length + 1} OFFSET ?${binds.length + 2}`
    )
    .bind(...binds, limit, offset)
    .all<LeadRow>();

  return jsonResponse({ ok: true, total: totalRow?.n ?? 0, leads: rows.results });
}

export async function getLead(env: Env, id: string): Promise<LeadRow> {
  const lead = await env.DB.prepare('SELECT * FROM leads WHERE id = ?1').bind(id).first<LeadRow>();
  if (!lead) throw new HttpError(404, 'Lead not found');
  return lead;
}

export async function handleLeadGet(id: string, env: Env): Promise<Response> {
  const lead = await getLead(env, id);
  const messages = await env.DB
    .prepare('SELECT * FROM messages WHERE lead_id = ?1 ORDER BY created_at ASC')
    .bind(id)
    .all<MessageRow>();
  const events = await env.DB
    .prepare('SELECT event, detail, created_at FROM lead_events WHERE lead_id = ?1 ORDER BY id DESC LIMIT 100')
    .bind(id)
    .all();
  const footerPreview = (await getOutreachSettings(env.DB)).footerHtml || buildFooter();
  return jsonResponse({
    ok: true,
    lead,
    messages: messages.results,
    events: events.results,
    footerPreview,
  });
}

export async function handleLeadPatch(id: string, body: Record<string, unknown>, env: Env): Promise<Response> {
  const lead = await getLead(env, id);

  if (typeof body.notes === 'string') {
    await env.DB
      .prepare(`UPDATE leads SET notes = ?1, updated_at = datetime('now') WHERE id = ?2`)
      .bind(normalizeMultiline(body.notes, 2000) || null, id)
      .run();
  }

  const action = typeof body.action === 'string' ? body.action : '';
  if (action === 'disqualify') {
    if (lead.status === 'suppressed') throw new HttpError(409, 'Lead is suppressed');
    await env.DB
      .prepare(`UPDATE leads SET status = 'not_interested', sales_stage = 'do_not_contact', next_action = 'suppress', updated_at = datetime('now') WHERE id = ?1`)
      .bind(id)
      .run();
    await recordEvent(env.DB, id, 'status_changed', { to: 'not_interested', by: 'manual' });
  } else if (action === 'reactivate') {
    // The only way a non-replier re-enters the pipeline (no automatic follow-ups).
    if (!['sent', 'replied_positive', 'meeting_requested', 'asked_for_more_info', 'referred', 'not_now', 'not_interested', 'manual_review', 'failed'].includes(lead.status)) {
      throw new HttpError(409, `Cannot reactivate a lead in status '${lead.status}'`);
    }
    await env.DB
      .prepare(`UPDATE leads SET status = 'scored', updated_at = datetime('now') WHERE id = ?1`)
      .bind(id)
      .run();
    await recordEvent(env.DB, id, 'status_changed', { to: 'scored', by: 'manual_reactivate' });
  } else if (action === 'create_demo_task') {
    await updateSalesAction(env, id, 'meeting_requested', 'demo_task_created', 'ask_availability', action);
  } else if (action === 'mark_demo_interested') {
    await updateSalesAction(env, id, 'meeting_requested', 'demo_interested', 'create_demo_task', action);
  } else if (action === 'draft_reply') {
    await updateSalesAction(env, id, lead.status, 'reply_draft_ready', lead.next_action ?? 'manual_review', action);
  } else if (action === 'mark_sales_qualified') {
    await updateSalesAction(env, id, 'replied_positive', 'sales_qualified', 'book_demo', action);
  } else if (action === 'add_second_batch') {
    await updateSalesAction(env, id, lead.status, 'second_batch_selected', 'manual_review', action);
  } else if (action === 'mark_not_interested') {
    await updateSalesAction(env, id, 'not_interested', 'do_not_contact', 'do_not_contact', action);
  } else if (action === 'suppress') {
    await addSuppression(env.DB, 'email', lead.email, 'manual');
    await updateSalesAction(env, id, 'suppressed', 'do_not_contact', 'suppress', action);
  } else if (action === 'manual_review') {
    await updateSalesAction(env, id, 'manual_review', 'manual_review', 'manual_review', action);
  } else if (action === 'enable_delivery_test') {
    const confirmation = normalizeText(body.confirmEmail, 180).toLowerCase();
    if (confirmation !== lead.email) {
      throw new HttpError(400, 'confirmEmail must exactly match the lead email');
    }
    if (lead.status === 'suppressed' || await isLeadSuppressed(env, lead)) {
      throw new HttpError(409, 'Suppressed leads cannot be enabled for delivery tests');
    }
    await env.DB.prepare(
      `UPDATE leads SET delivery_test = 1, status = 'scored',
         sales_stage = 'delivery_test', next_action = 'draft_test_email',
         updated_at = datetime('now') WHERE id = ?1`
    ).bind(id).run();
    await recordEvent(env.DB, id, 'delivery_test_enabled', { confirmation: 'exact_email_match' });
  } else if (action) {
    throw new HttpError(400, `Unknown action '${action}'`);
  }

  return jsonResponse({ ok: true, lead: await getLead(env, id) });
}

async function isLeadSuppressed(env: Env, lead: LeadRow): Promise<boolean> {
  const keys = await loadSuppressedKeys(env.DB, [lead.email], [lead.domain]);
  return suppressionKeyHit(keys, lead.email);
}

async function updateSalesAction(
  env: Env,
  leadId: string,
  status: LeadRow['status'],
  salesStage: string,
  nextAction: string,
  action: string
): Promise<void> {
  await env.DB.prepare(
    `UPDATE leads SET status = ?1, sales_stage = ?2, next_action = ?3, updated_at = datetime('now') WHERE id = ?4`
  ).bind(status, salesStage, nextAction, leadId).run();
  await recordEvent(env.DB, leadId, 'sales_action', { action, status, sales_stage: salesStage });
}
