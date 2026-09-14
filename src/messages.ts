import { recordEvent } from './db';
import type { Env } from './env';
import { HttpError, jsonResponse, normalizeMultiline, normalizeText } from './http';
import { getLead } from './leads';
import { autoRepairStoredDraft } from './pipeline';
import { processSend } from './sending';
import { deliveryTestEnabled, priorOutboundBlocksDelivery } from './services/deliveryTest';
import { validateDraftQuality } from './services/draftQuality';
import { normalizeDraftSubject, renderDraftEmail } from './services/emailRenderer';
import { buildPersonalizationPlan } from './services/personalization';
import { readDraftCampaignBrief, readDraftWorkspaceSnapshot } from './services/draftSnapshot';
import { DEFAULT_OUTREACH_SETTINGS, effectiveSenderDisplayName, getOutreachSettings, type OutreachSettings } from './services/outreachSettings';
import { assertProfileReady, getWorkspaceProfile } from './services/workspaceProfile.ts';
import { isSuppressed } from './suppression';
import type { LeadRow, MessageRow, QualityPolicy } from './types';

export async function getMessage(env: Env, id: string): Promise<MessageRow> {
  const row = await env.DB.prepare('SELECT * FROM messages WHERE id = ?1').bind(id).first<MessageRow>();
  if (!row) throw new HttpError(404, 'Message not found');
  return row;
}

/** Message list with lead context - powers the dashboard's Drafts (and review) views. */
export async function handleMessagesList(url: URL, env: Env): Promise<Response> {
  const status = normalizeText(url.searchParams.get('status'), 30);
  const direction = normalizeText(url.searchParams.get('direction'), 10) === 'inbound' ? 'inbound' : 'outbound';
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
  const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);

  const where: string[] = ['m.direction = ?1'];
  const binds: unknown[] = [direction];
  if (status === 'review') {
    where.push(`m.status IN ('draft','needs_review')`);
  } else if (status) {
    where.push(`m.status = ?${binds.length + 1}`);
    binds.push(status);
  }
  const rows = await env.DB
    .prepare(
      `SELECT m.*, l.company AS lead_company, l.first_name AS lead_first_name,
              l.last_name AS lead_last_name, l.email AS lead_email,
              l.segment AS lead_segment, l.fit_score AS lead_fit_score,
              l.role AS lead_role, l.industry AS lead_industry,
              l.sub_industry AS lead_sub_industry
       FROM messages m LEFT JOIN leads l ON l.id = m.lead_id
       WHERE ${where.join(' AND ')}
       ORDER BY m.updated_at DESC
       LIMIT ?${binds.length + 1} OFFSET ?${binds.length + 2}`
    )
    .bind(...binds, limit, offset)
    .all();
  return jsonResponse({ ok: true, messages: rows.results });
}

function snapshotSettings(message: MessageRow, fallback: OutreachSettings): { settings: OutreachSettings; policy: QualityPolicy } {
  try {
    const parsed = message.settings_snapshot ? JSON.parse(message.settings_snapshot) as Record<string, unknown> : {};
    const policy = parsed.qualityPolicy === 'strict' || parsed.qualityPolicy === 'custom' ? parsed.qualityPolicy : 'balanced';
    return {
      settings: {
        ...fallback,
        greeting: typeof parsed.greeting === 'string' ? parsed.greeting : fallback.greeting,
        fallbackGreeting: typeof parsed.fallbackGreeting === 'string' ? parsed.fallbackGreeting : fallback.fallbackGreeting,
        signoff: typeof parsed.signoff === 'string' ? parsed.signoff : fallback.signoff,
        senderName: typeof parsed.senderName === 'string' ? parsed.senderName : fallback.senderName,
        senderEmail: typeof parsed.senderEmail === 'string' ? parsed.senderEmail : fallback.senderEmail,
        senderDisplayName: typeof parsed.senderDisplayName === 'string' ? parsed.senderDisplayName : fallback.senderDisplayName,
        cta: typeof parsed.cta === 'string' ? parsed.cta : fallback.cta,
        footerHtml: typeof parsed.footerHtml === 'string' ? parsed.footerHtml : fallback.footerHtml,
      },
      policy,
    };
  } catch {
    return { settings: fallback, policy: 'balanced' };
  }
}

export async function handleMessagePatch(id: string, body: Record<string, unknown>, env: Env): Promise<Response> {
  const message = await getMessage(env, id);
  if (message.direction !== 'outbound' || !['draft', 'needs_review'].includes(message.status)) {
    throw new HttpError(409, 'Only drafts can be edited');
  }
  const subject = typeof body.subject === 'string' ? normalizeDraftSubject(normalizeText(body.subject, 150)) : null;
  const lead = message.lead_id ? await getLead(env, message.lead_id) : null;
  const globalSettings = lead ? await getOutreachSettings(env.DB) : null;
  const snapshot = globalSettings ? snapshotSettings(message, globalSettings) : null;
  const settings = snapshot?.settings ?? globalSettings ?? DEFAULT_OUTREACH_SETTINGS;
  const newBody = typeof body.body === 'string' && lead
    ? renderDraftEmail(normalizeMultiline(body.body, 5000), lead, settings ?? undefined)
    : typeof body.body === 'string' ? normalizeMultiline(body.body, 5000) : null;
  if (subject === null && newBody === null) throw new HttpError(400, 'Provide subject and/or body');
  if (subject !== null && subject.length < 3) throw new HttpError(400, 'Subject is too short');
  if (newBody !== null && newBody.length < 40) throw new HttpError(400, 'Body is too short');

  const finalSubject = subject ?? message.subject ?? '';
  const finalBody = newBody ?? message.body ?? '';
  const workspace = readDraftWorkspaceSnapshot(message.profile_snapshot) ?? await getWorkspaceProfile(env);
  const strategy = lead ? savedDraftStrategy(message, lead, settings, workspace) : null;
  const quality = lead
    ? validateDraftQuality(
        finalSubject,
        finalBody,
        lead,
        strategy ?? undefined,
        typeof body.body === 'string' ? normalizeMultiline(body.body, 5000) : finalBody,
        settings,
        snapshot?.policy ?? 'balanced', workspace
      )
    : { valid: false, status: 'needs_review' as const, warnings: ['Draft has no lead.'], word_count: 0, question_count: 0, checks: [] };
  const nextStatus = quality.valid ? 'draft' : 'needs_review';
  const warning = quality.valid ? null : `Draft quality warning: ${quality.warnings.join(' ')}`.slice(0, 500);
  let savedPlan: Record<string, unknown> = {};
  try {
    const parsed = message.next_step_plan ? JSON.parse(message.next_step_plan) as unknown : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      savedPlan = parsed as Record<string, unknown>;
    }
  } catch {
    // Replace malformed historical metadata with the current checklist.
  }
  const nextStepPlan = JSON.stringify({
    ...savedPlan,
    quality_checklist: quality.checks,
  });

  await env.DB
    .prepare(
      `UPDATE messages SET
         subject = COALESCE(?1, subject),
         body = COALESCE(?2, body),
         status = ?3,
         error = ?4,
         draft_quality_status = ?5,
         validation_warnings = ?6,
         next_step_plan = ?7,
         sendability_status = ?8,
         status_reason = ?9,
         updated_at = datetime('now')
       WHERE id = ?10 AND status IN ('draft','needs_review')`
    )
    .bind(subject, newBody, nextStatus, warning, quality.status, JSON.stringify(quality.warnings), nextStepPlan,
      quality.valid ? 'sendable' : 'needs_review', quality.valid ? null : 'Draft quality checks need attention', id)
    .run();
  if (message.lead_id) {
    await recordEvent(env.DB, message.lead_id, 'draft_edited', { message_id: id });
  }
  return jsonResponse({ ok: true, message: await getMessage(env, id) });
}

async function assertEligibleToSend(env: Env, message: MessageRow): Promise<LeadRow> {
  const workspace = await getWorkspaceProfile(env);
  assertProfileReady(workspace, 'approve or send drafts');
  if (workspace.demoMode) throw new HttpError(409, 'Demo mode cannot approve, queue, or send email. Switch to your business profile first.');
  if (!message.profile_snapshot) throw new HttpError(409, 'This legacy draft must be regenerated under the current Business profile before it can be approved or sent.');
  if (message.direction !== 'outbound') throw new HttpError(409, 'Not an outbound message');
  if (!message.lead_id) throw new HttpError(409, 'Message has no lead');
  const lead = await getLead(env, message.lead_id);
  const suppressedReason = await isSuppressed(env.DB, lead.email, lead.domain);
  if (suppressedReason) throw new HttpError(409, `Lead is suppressed (${suppressedReason})`);
  if (['suppressed', 'failed', 'not_interested'].includes(lead.status)) {
    throw new HttpError(409, `Lead status is '${lead.status}'`);
  }
  const other = await env.DB
    .prepare(
      `SELECT id, status FROM messages
       WHERE lead_id = ?1 AND direction = 'outbound' AND id != ?2
         AND NOT (campaign_id = ?3 AND ?4 = 2 AND sequence_step = 1)
         AND status IN ('approved','queued','sending','sent','send_unknown')`
    )
    .bind(lead.id, message.id, message.campaign_id ?? '', message.sequence_step)
    .all<{ id: string; status: string }>();
  if (other.results.some((row) => priorOutboundBlocksDelivery(deliveryTestEnabled(lead), row.status))) {
    throw new HttpError(409, 'One cold email per lead: another email is already queued or sent');
  }
  return lead;
}

function savedDraftStrategy(message: MessageRow, lead: LeadRow, settings: OutreachSettings, workspace: Awaited<ReturnType<typeof getWorkspaceProfile>>) {
  const strategy = buildPersonalizationPlan(lead, settings, workspace).strategy;
  if (message.profile_snapshot) {
    const campaignBrief = readDraftCampaignBrief(message.profile_snapshot);
    if (campaignBrief?.offer) strategy.recommended_offer = campaignBrief.offer;
    if (campaignBrief?.cta) strategy.recommended_cta = campaignBrief.cta;
    if (campaignBrief?.personalizationNote) strategy.likely_relevance_context = campaignBrief.personalizationNote;
    if (message.recommended_offer) strategy.recommended_offer = message.recommended_offer;
    if (message.recommended_cta) strategy.recommended_cta = message.recommended_cta;
    if (message.relevance_context) strategy.likely_relevance_context = message.relevance_context;
  }
  return strategy;
}

async function currentQuality(env: Env, message: MessageRow, lead: LeadRow) {
  const fallback = await getOutreachSettings(env.DB);
  const snapshot = snapshotSettings(message, fallback);
  const workspace = readDraftWorkspaceSnapshot(message.profile_snapshot) ?? await getWorkspaceProfile(env);
  return validateDraftQuality(
    message.subject ?? '',
    message.body ?? '',
    lead,
    savedDraftStrategy(message, lead, snapshot.settings, workspace),
    message.body ?? '',
    snapshot.settings,
    snapshot.policy, workspace
  );
}

/**
 * A green quality result is the approval gate. Draft edits always recalculate
 * it, so later wording-setting changes cannot strand an already-passed draft.
 */
function requiresAutomatedRepair(message: MessageRow, quality: ReturnType<typeof validateDraftQuality>): boolean {
  return message.draft_quality_status !== 'passed' || !quality.valid;
}

export async function handleMessageApprove(id: string, env: Env): Promise<Response> {
  const message = await getMessage(env, id);
  if (!['draft', 'needs_review'].includes(message.status)) {
    throw new HttpError(409, `Cannot approve a message in status '${message.status}'`);
  }
  const lead = await assertEligibleToSend(env, message);
  const quality = await currentQuality(env, message, lead);
  if (requiresAutomatedRepair(message, quality)) {
    const repaired = await autoRepairStoredDraft(env, message, lead);
    if (!repaired.automation.quality.valid) {
      throw new HttpError(
        409,
        `Automated repair could not pass quality review: ${repaired.automation.quality.warnings.join(' ')}`
      );
    }
    return jsonResponse({
      ok: true,
      repaired: true,
      approvalRequired: true,
      queued: false,
      message: repaired.message,
    });
  }

  const claim = await env.DB
    .prepare(
      `UPDATE messages SET status = 'approved', sendability_status = 'sendable', status_reason = 'Approved; waiting for queue delivery', next_action='send_approved_email', updated_at = datetime('now')
       WHERE id = ?1 AND status IN ('draft','needs_review')`
    )
    .bind(id)
    .run();
  if ((claim.meta.changes ?? 0) === 0) throw new HttpError(409, 'Draft changed concurrently');
  await recordEvent(env.DB, lead.id, 'approved', { message_id: id });

  let queued = false;
  try {
    await env.SEND_QUEUE.send({ type: 'send', messageId: id });
    await env.DB
      .prepare(`UPDATE messages SET status = 'queued', sendability_status = 'sendable', status_reason = 'Queued for delivery', updated_at = datetime('now') WHERE id = ?1 AND status = 'approved'`)
      .bind(id)
      .run();
    queued = true;
    await recordEvent(env.DB, lead.id, 'enqueued', { message_id: id });
  } catch {
    // Stays 'approved'; the sweeper cron re-enqueues stragglers.
  }
  await env.DB
    .prepare(
      `UPDATE leads SET status = 'queued', sales_stage = 'approved_to_send',
         next_action = 'send_approved_email', updated_at = datetime('now') WHERE id = ?1`
    )
    .bind(lead.id)
    .run();
  return jsonResponse({ ok: true, queued });
}

function batchScheduleStart(value: unknown): Date {
  if (typeof value !== 'string' || !value.trim()) return new Date();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new HttpError(400, 'scheduledAt must be a valid date and time');
  if (parsed.getTime() < Date.now() - 60_000) throw new HttpError(400, 'scheduledAt cannot be in the past');
  if (parsed.getTime() > Date.now() + 31 * 86_400_000) throw new HttpError(400, 'scheduledAt must be within 31 days');
  return parsed;
}

/** Approve a visible batch and space the queue so messages do not burst together. */
export async function handleMessagesQueue(body: Record<string, unknown>, env: Env): Promise<Response> {
  const ids = Array.isArray(body.messageIds)
    ? [...new Set(body.messageIds.filter((id): id is string => typeof id === 'string' && id.length <= 80))].slice(0, 200)
    : [];
  if (!ids.length) throw new HttpError(400, 'Select at least one draft');
  const interval = Number(body.intervalMinutes ?? 2);
  if (!Number.isInteger(interval) || interval < 1 || interval > 60) throw new HttpError(400, 'intervalMinutes must be between 1 and 60');
  const dailyCap = Number(body.dailyCap ?? ids.length);
  if (!Number.isInteger(dailyCap) || dailyCap < 1 || dailyCap > 500) throw new HttpError(400, 'dailyCap must be between 1 and 500');
  const start = batchScheduleStart(body.scheduledAt);
  const queued: Array<{ id: string; scheduledAt: string }> = [];
  const blocked: Array<{ id: string; reason: string }> = [];

  for (const [index, id] of ids.entries()) {
    try {
      const message = await getMessage(env, id);
      if (!['draft', 'approved'].includes(message.status)) throw new HttpError(409, `Message is ${message.status}`);
      if (message.draft_quality_status !== 'passed') throw new HttpError(409, 'Draft needs review before it can enter the queue');
      const lead = await assertEligibleToSend(env, message);
      const scheduled = new Date(start.getTime() + index * interval * 60_000).toISOString();
      let snapshot: Record<string, unknown> = {};
      try {
        const parsed = message.settings_snapshot ? JSON.parse(message.settings_snapshot) as unknown : null;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) snapshot = parsed as Record<string, unknown>;
      } catch { /* Preserve delivery behavior with a fresh safe snapshot. */ }
      if (!snapshot.senderDisplayName) {
        const settings = await getOutreachSettings(env.DB);
        snapshot.senderDisplayName = effectiveSenderDisplayName(settings, env);
      }
      snapshot.batchDailyCap = dailyCap;
      const updated = await env.DB.prepare(
        `UPDATE messages SET status='queued', scheduled_at=?1, settings_snapshot=?2, sendability_status='sendable', next_action='send_approved_email',
            status_reason='Scheduled for delivery', updated_at=datetime('now')
         WHERE id=?3 AND status IN ('draft','approved')`
      ).bind(scheduled, JSON.stringify(snapshot), id).run();
      if ((updated.meta.changes ?? 0) === 0) throw new HttpError(409, 'Message changed while being queued');
      await env.DB.prepare(
        `UPDATE leads SET status='queued', sales_stage='approved_to_send', next_action='scheduled_send', updated_at=datetime('now') WHERE id=?1`
      ).bind(lead.id).run();
      await recordEvent(env.DB, lead.id, 'enqueued', { message_id: id, scheduled_at: scheduled, interval_minutes: interval });
      const delaySeconds = Math.min(Math.max(0, Math.ceil((new Date(scheduled).getTime() - Date.now()) / 1000)), 85_800);
      await env.SEND_QUEUE.send({ type: 'send', messageId: id }, delaySeconds > 0 ? { delaySeconds } : undefined);
      queued.push({ id, scheduledAt: scheduled });
    } catch (error) {
      blocked.push({ id, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return jsonResponse({ ok: true, queued, blocked, intervalMinutes: interval, dailyCap });
}

export async function handleMessageReject(id: string, body: Record<string, unknown>, env: Env): Promise<Response> {
  const message = await getMessage(env, id);
  if (!['draft', 'needs_review'].includes(message.status)) {
    throw new HttpError(409, `Cannot reject a message in status '${message.status}'`);
  }
  const reason = normalizeText(body.reason, 300) || null;
  await env.DB
    .prepare(
      `UPDATE messages SET status = 'rejected', sendability_status = 'blocked', status_reason = ?1, error = ?1, updated_at = datetime('now')
       WHERE id = ?2 AND status IN ('draft','needs_review')`
    )
    .bind(reason, id)
    .run();
  if (message.lead_id) {
    await env.DB
      .prepare(`UPDATE leads SET status = 'scored', updated_at = datetime('now') WHERE id = ?1 AND status = 'drafted'`)
      .bind(message.lead_id)
      .run();
    await recordEvent(env.DB, message.lead_id, 'rejected', { message_id: id });
  }
  return jsonResponse({ ok: true });
}

export async function handleMessageNeedsReview(id: string, env: Env): Promise<Response> {
  const message = await getMessage(env, id);
  if (!['draft', 'needs_review'].includes(message.status)) {
    throw new HttpError(409, `Cannot mark a message in status '${message.status}' for review`);
  }
  await env.DB.prepare(
    `UPDATE messages SET status = 'needs_review', draft_quality_status = 'needs_review', sendability_status = 'needs_review',
       status_reason = 'Marked for manual review', error = 'Marked for manual review', updated_at = datetime('now') WHERE id = ?1`
  ).bind(id).run();
  if (message.lead_id) {
    await recordEvent(env.DB, message.lead_id, 'draft_needs_review', { message_id: id, by: 'manual' });
  }
  return jsonResponse({ ok: true, message: await getMessage(env, id) });
}

export async function handleMessageCancel(id: string, env: Env): Promise<Response> {
  const message = await getMessage(env, id);
  if (!['approved', 'queued'].includes(message.status)) {
    throw new HttpError(409, `Cannot cancel a message in status '${message.status}'`);
  }
  const result = await env.DB.prepare(
    `UPDATE messages SET status='rejected', sendability_status='blocked', status_reason='Cancelled by operator',
       stopped_at=datetime('now'), stopped_reason='operator_cancelled', next_action='stopped', updated_at=datetime('now')
     WHERE id=?1 AND status IN ('approved','queued')`
  ).bind(id).run();
  if ((result.meta.changes ?? 0) === 0) throw new HttpError(409, 'Message changed before it could be cancelled');
  if (message.lead_id) {
    await env.DB.prepare(
      `UPDATE leads SET status='manual_review', sales_stage='sequence_stopped', next_action='stopped_by_operator', updated_at=datetime('now')
       WHERE id=?1 AND status='queued'`
    ).bind(message.lead_id).run();
    await recordEvent(env.DB, message.lead_id, 'send_cancelled', { message_id: id });
  }
  return jsonResponse({ ok: true, message: await getMessage(env, id) });
}

export async function handleMessageReschedule(id: string, body: Record<string, unknown>, env: Env): Promise<Response> {
  const message = await getMessage(env, id);
  if (message.status !== 'queued') throw new HttpError(409, `Cannot reschedule a message in status '${message.status}'`);
  const scheduled = batchScheduleStart(body.scheduledAt).toISOString();
  await env.DB.prepare(
    `UPDATE messages SET scheduled_at=?1, status_reason='Rescheduled by operator', retry_at=NULL, updated_at=datetime('now')
     WHERE id=?2 AND status='queued'`
  ).bind(scheduled, id).run();
  const delaySeconds = Math.min(Math.max(0, Math.ceil((new Date(scheduled).getTime() - Date.now()) / 1000)), 85_800);
  try { await env.SEND_QUEUE.send({ type: 'send', messageId: id }, delaySeconds > 0 ? { delaySeconds } : undefined); } catch {
    // The sweeper can recover the queued row if the queue call fails.
  }
  if (message.lead_id) await recordEvent(env.DB, message.lead_id, 'send_rescheduled', { message_id: id, scheduled_at: scheduled });
  return jsonResponse({ ok: true, scheduledAt: scheduled, message: await getMessage(env, id) });
}

export async function handleMessageRetry(id: string, body: Record<string, unknown>, env: Env): Promise<Response> {
  const message = await getMessage(env, id);
  if (!['failed', 'send_unknown'].includes(message.status)) {
    throw new HttpError(409, `Cannot retry a message in status '${message.status}'`);
  }
  if (message.status === 'send_unknown' && body.confirmUnknown !== true) {
    throw new HttpError(409, 'This send outcome is unknown; confirm that Zoho did not deliver it before retrying');
  }
  const lead = await assertEligibleToSend(env, message);
  const scheduled = batchScheduleStart(body.scheduledAt).toISOString();
  const updated = await env.DB.prepare(
    `UPDATE messages SET status='queued', sendability_status='sendable', status_reason='Retry queued by operator',
       error=NULL, error_code=NULL, error_detail=NULL, retry_at=NULL, scheduled_at=?1, stopped_at=NULL, stopped_reason=NULL,
       next_action='scheduled_send', updated_at=datetime('now')
     WHERE id=?2 AND status IN ('failed','send_unknown')`
  ).bind(scheduled, id).run();
  if ((updated.meta.changes ?? 0) === 0) throw new HttpError(409, 'Message changed before it could be retried');
  await env.DB.prepare(`UPDATE leads SET status='queued', sales_stage='approved_to_send', next_action='scheduled_send', updated_at=datetime('now') WHERE id=?1`).bind(lead.id).run();
  const delaySeconds = Math.min(Math.max(0, Math.ceil((new Date(scheduled).getTime() - Date.now()) / 1000)), 85_800);
  try { await env.SEND_QUEUE.send({ type: 'send', messageId: id }, delaySeconds > 0 ? { delaySeconds } : undefined); } catch {
    // The sweeper will re-enqueue a queued row if the queue call fails.
  }
  await recordEvent(env.DB, lead.id, 'send_retry_queued', { message_id: id, scheduled_at: scheduled });
  return jsonResponse({ ok: true, scheduledAt: scheduled, message: await getMessage(env, id) });
}

/**
 * Synchronous send for testing and hands-on use: approve + attempt delivery now.
 * If a gate defers it (window/cap), the message is queued with a delay instead.
 */
export async function handleSendNow(id: string, env: Env): Promise<Response> {
  const message = await getMessage(env, id);
  if (!['draft', 'needs_review', 'approved', 'queued'].includes(message.status)) {
    throw new HttpError(409, `Cannot send a message in status '${message.status}'`);
  }
  const lead = await assertEligibleToSend(env, message);
  const quality = await currentQuality(env, message, lead);
  if (requiresAutomatedRepair(message, quality)) {
    if (!['draft', 'needs_review'].includes(message.status)) {
      throw new HttpError(409, `Approved draft no longer passes quality review: ${quality.warnings.join(' ')}`);
    }
    const repaired = await autoRepairStoredDraft(env, message, lead);
    if (!repaired.automation.quality.valid) {
      throw new HttpError(
        409,
        `Automated repair could not pass quality review: ${repaired.automation.quality.warnings.join(' ')}`
      );
    }
    return jsonResponse({
      ok: true,
      repaired: true,
      approvalRequired: true,
      sent: false,
      message: repaired.message,
    });
  }

  if (message.status !== 'queued') {
    const claim = await env.DB
      .prepare(
        `UPDATE messages SET status = 'queued', sendability_status = 'sendable', next_action='send_approved_email',
           status_reason = 'Queued for immediate delivery', updated_at = datetime('now')
         WHERE id = ?1 AND status IN ('draft','needs_review','approved')`
      )
      .bind(id)
      .run();
    if ((claim.meta.changes ?? 0) === 0) throw new HttpError(409, 'Message changed concurrently');
    await env.DB
      .prepare(
        `UPDATE leads SET status = 'queued', sales_stage = 'approved_to_send',
           next_action = 'send_approved_email', updated_at = datetime('now') WHERE id = ?1`
      )
      .bind(lead.id)
      .run();
    await recordEvent(env.DB, lead.id, 'approved', { message_id: id, via: 'send_now' });
  }

  const outcome = await processSend(env, id);
  if (outcome.action === 'sent') {
    return jsonResponse({ ok: true, sent: true, dryRun: outcome.dryRun });
  }
  if (outcome.action === 'retry') {
    try {
      await env.SEND_QUEUE.send({ type: 'send', messageId: id }, { delaySeconds: outcome.delaySeconds });
    } catch {
      // sweeper will re-enqueue the queued row if this fails
    }
    return jsonResponse(
      { ok: false, deferred: true, reason: outcome.reason, retryInSeconds: outcome.delaySeconds },
      202
    );
  }
  return jsonResponse({ ok: false, error: outcome.reason }, 409);
}
