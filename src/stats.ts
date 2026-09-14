import { intVar, type Env } from './env';
import { jsonResponse } from './http';
import { dayString } from './util/time';

const LEAD_STATUSES = [
  'new',
  'scored',
  'drafted',
  'approved',
  'queued',
  'sent',
  'replied_positive',
  'meeting_requested',
  'asked_for_more_info',
  'referred',
  'not_now',
  'not_interested',
  'suppressed',
  'unmatched_reply',
  'manual_review',
  'failed',
] as const;

export async function handleStats(env: Env): Promise<Response> {
  const pipeline: Record<string, number> = {};
  for (const s of LEAD_STATUSES) pipeline[s] = 0;
  const statusRows = await env.DB
    .prepare('SELECT status, COUNT(*) AS n FROM leads GROUP BY status')
    .all<{ status: string; n: number }>();
  for (const row of statusRows.results) pipeline[row.status] = row.n;

  const today = dayString(env.TIMEZONE);
  const counter = await env.DB
    .prepare('SELECT count FROM send_counters WHERE day = ?1')
    .bind(today)
    .first<{ count: number }>();

  const drafts = await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM messages WHERE direction = 'outbound' AND status IN ('draft','needs_review')`)
    .first<{ n: number }>();

  const sendUnknown = await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM messages WHERE direction = 'outbound' AND status = 'send_unknown'`)
    .first<{ n: number }>();

  const replies7 = await env.DB
    .prepare(
      `SELECT COALESCE(classification, 'unclear') AS classification, COUNT(*) AS n
       FROM messages
       WHERE direction = 'inbound' AND created_at > datetime('now','-7 days')
       GROUP BY classification`
    )
    .all<{ classification: string; n: number }>();
  const repliesLast7ByClass: Record<string, number> = {};
  for (const row of replies7.results) repliesLast7ByClass[row.classification] = row.n;

  const sent7 = await env.DB
    .prepare(
      `SELECT substr(sent_at, 1, 10) AS day, COUNT(*) AS n
       FROM messages
       WHERE direction = 'outbound' AND status = 'sent' AND sent_at > datetime('now','-7 days')
       GROUP BY day ORDER BY day`
    )
    .all<{ day: string; n: number }>();

  const queue = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
       SUM(CASE WHEN retry_at IS NOT NULL THEN 1 ELSE 0 END) AS retrying,
       SUM(CASE WHEN scheduled_at IS NOT NULL AND scheduled_at <= datetime('now') THEN 1 ELSE 0 END) AS due
     FROM messages WHERE direction='outbound' AND status='queued'`
  ).first<{ total: number; retrying: number; due: number }>();
  const blocked = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM messages WHERE direction='outbound' AND (sendability_status='blocked' OR status IN ('failed','send_unknown'))`
  ).first<{ n: number }>();
  const repliesNeedingAction = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM messages WHERE direction='inbound' AND status='received'
       AND COALESCE(next_action,'manual_review') NOT IN ('no_action','auto_reply')`
  ).first<{ n: number }>();
  const campaigns = await env.DB.prepare(
    `SELECT SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active,
       SUM(CASE WHEN status='paused' THEN 1 ELSE 0 END) AS paused FROM campaigns`
  ).first<{ active: number; paused: number }>();
  const nextQueued = await env.DB.prepare(
    `SELECT m.id, m.scheduled_at, m.status_reason, l.company AS lead_company, l.email AS lead_email
       FROM messages m LEFT JOIN leads l ON l.id=m.lead_id
      WHERE m.direction='outbound' AND m.status='queued'
      ORDER BY CASE WHEN m.scheduled_at IS NULL THEN 1 ELSE 0 END, m.scheduled_at ASC LIMIT 1`
  ).first<{ id: string; scheduled_at: string | null; status_reason: string | null; lead_company: string | null; lead_email: string | null }>();
  const attentionRows = await env.DB.prepare(
    `SELECT m.id, m.status, m.sendability_status, m.status_reason, m.error_code, m.error_detail,
       m.retry_at, m.scheduled_at, m.next_action, l.company AS lead_company, l.email AS lead_email,
       c.name AS campaign_name
      FROM messages m LEFT JOIN leads l ON l.id=m.lead_id LEFT JOIN campaigns c ON c.id=m.campaign_id
     WHERE m.direction='outbound' AND (
       m.status IN ('needs_review','failed','send_unknown') OR
       (m.status='queued' AND m.retry_at IS NOT NULL)
     ) ORDER BY COALESCE(m.retry_at,m.updated_at) ASC LIMIT 20`
  ).all();

  return jsonResponse({
    ok: true,
    pipeline,
    sendsToday: counter?.count ?? 0,
    dailyCap: intVar(env.DAILY_SEND_CAP, 10),
    draftsAwaiting: drafts?.n ?? 0,
    sendUnknown: sendUnknown?.n ?? 0,
    repliesLast7ByClass,
    sentLast7: sent7.results,
    queue: { total: queue?.total ?? 0, retrying: queue?.retrying ?? 0, due: queue?.due ?? 0, next: nextQueued ?? null },
    blocked: blocked?.n ?? 0,
    repliesNeedingAction: repliesNeedingAction?.n ?? 0,
    campaigns: { active: campaigns?.active ?? 0, paused: campaigns?.paused ?? 0 },
    attention: attentionRows.results,
  });
}

export async function handleOverview(env: Env): Promise<Response> {
  return handleStats(env);
}
