import { recordEvent } from './db';
import { intVar, type Env } from './env';
import { addSuppression, isSuppressed } from './suppression';
import { deliveryTestEnabled, priorOutboundBlocksDelivery } from './services/deliveryTest';
import type { LeadRow, MessageRow } from './types';
import { dayString, isInSendWindow, secondsToNextWindowOpen, weekStartString } from './util/time';
import { ensureFooter } from './util/text';
import { isValidEmail } from './http';
import { getAccessToken, sendMail, ZohoError } from './zoho';
import { effectiveSenderDisplayName, effectiveSenderEmail, getOutreachSettings, safeSenderDisplayName } from './services/outreachSettings.ts';
import { getCampaign, recordSequenceEvent } from './services/campaigns.ts';
import { getWorkspaceProfile, profileIssues } from './services/workspaceProfile.ts';

export type SendOutcome =
  | { action: 'sent'; dryRun: boolean }
  | { action: 'ack'; reason: string }
  | { action: 'retry'; delaySeconds: number; reason: string };

// Queues cap delaySeconds at 12h/24h depending on plan; stay safely under.
const MAX_DELAY_SECONDS = 85_800;

function clampDelay(seconds: number): number {
  return Math.min(Math.max(seconds, 60), MAX_DELAY_SECONDS);
}

async function decrementCounter(env: Env, day: string): Promise<void> {
  await env.DB
    .prepare(`UPDATE send_counters SET count = count - 1 WHERE day = ?1 AND count > 0`)
    .bind(day)
    .run();
}

async function decrementDomainCounter(env: Env, weekStart: string, domain: string): Promise<void> {
  await env.DB
    .prepare(
      `UPDATE domain_send_counters SET count = count - 1
       WHERE week_start = ?1 AND domain = ?2 AND count > 0`
    )
    .bind(weekStart, domain)
    .run();
}

/** Atomically take one send slot for the day. Returns false when the cap is reached. */
async function takeDailySlot(env: Env, day: string, cap: number): Promise<boolean> {
  const attempt = () =>
    env.DB
      .prepare(`UPDATE send_counters SET count = count + 1 WHERE day = ?1 AND count < ?2`)
      .bind(day, cap)
      .run();
  let res = await attempt();
  if ((res.meta.changes ?? 0) > 0) return true;
  await env.DB.prepare(`INSERT OR IGNORE INTO send_counters (day, count) VALUES (?1, 0)`).bind(day).run();
  res = await attempt();
  return (res.meta.changes ?? 0) > 0;
}

/** Atomically reserve one weekly slot for a recipient domain. */
async function takeDomainSlot(env: Env, weekStart: string, domain: string, cap: number): Promise<boolean> {
  const attempt = () =>
    env.DB
      .prepare(
        `UPDATE domain_send_counters SET count = count + 1
         WHERE week_start = ?1 AND domain = ?2 AND count < ?3`
      )
      .bind(weekStart, domain, cap)
      .run();
  let res = await attempt();
  if ((res.meta.changes ?? 0) > 0) return true;
  await env.DB
    .prepare(`INSERT OR IGNORE INTO domain_send_counters (week_start, domain, count) VALUES (?1, ?2, 0)`)
    .bind(weekStart, domain)
    .run();
  res = await attempt();
  return (res.meta.changes ?? 0) > 0;
}

async function decrementCampaignDailyCounter(env: Env, campaignId: string, day: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE campaign_send_counters SET sent_today = sent_today - 1
     WHERE campaign_id = ?1 AND counter_day = ?2 AND sent_today > 0`
  ).bind(campaignId, day).run();
}

async function takeCampaignDailySlot(env: Env, campaignId: string, day: string, weekStart: string, cap: number): Promise<boolean> {
  const attempt = () => env.DB.prepare(
    `UPDATE campaign_send_counters SET sent_today = sent_today + 1
     WHERE campaign_id = ?1 AND counter_day = ?2 AND sent_today < ?3`
  ).bind(campaignId, day, cap).run();
  let result = await attempt();
  if ((result.meta.changes ?? 0) > 0) return true;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO campaign_send_counters (campaign_id,counter_day,counter_week,sent_today,sent_this_week)
     VALUES (?1,?2,?3,0,0)`
  ).bind(campaignId, day, weekStart).run();
  result = await attempt();
  return (result.meta.changes ?? 0) > 0;
}

async function markFailed(env: Env, messageId: string, error: string): Promise<void> {
  await env.DB
    .prepare(`UPDATE messages SET status = 'failed', error = ?1, status_reason = ?2, sendability_status = 'blocked',
      retry_at = NULL, updated_at = datetime('now') WHERE id = ?3`)
    .bind(error.slice(0, 500), error.slice(0, 240), messageId)
    .run();
}

interface DeliverySnapshot {
  senderEmail?: string;
  senderDisplayName?: string;
  ccEmail?: string | null;
  bccEmail?: string | null;
  footerHtml?: string;
  batchDailyCap?: number;
}

function deliverySnapshot(message: MessageRow): DeliverySnapshot {
  if (!message.settings_snapshot) return {};
  try {
    const parsed = JSON.parse(message.settings_snapshot) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as DeliverySnapshot : {};
  } catch { return {}; }
}

function secondsUntilScheduled(scheduledAt: string | null): number | null {
  if (!scheduledAt) return null;
  const date = new Date(scheduledAt.endsWith('Z') ? scheduledAt : `${scheduledAt.replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) return null;
  const seconds = Math.ceil((date.getTime() - Date.now()) / 1000);
  return seconds > 0 ? clampDelay(seconds) : null;
}

/** Undo a 'sending' claim so the message can be retried later. */
async function revertToQueued(env: Env, messageId: string, error: string, code: string | null = null, retryAt: string | null = null, reason = 'Retry scheduled') : Promise<void> {
  await env.DB
    .prepare(
      `UPDATE messages SET status = 'queued', error = ?1, error_code = ?2, error_detail = ?3,
          retry_at = ?4, status_reason = ?5, sendability_status = 'sendable', updated_at = datetime('now')
       WHERE id = ?6 AND status = 'sending'`
    )
    .bind(error.slice(0, 500), code, error.slice(0, 500), retryAt, reason, messageId)
    .run();
}

async function markQueuedReason(env: Env, messageId: string, reason: string, retryAfterSeconds?: number): Promise<void> {
  const retryAt = retryAfterSeconds ? new Date(Date.now() + retryAfterSeconds * 1000).toISOString() : null;
  await env.DB.prepare(
    `UPDATE messages SET status_reason=?1, retry_at=?2, updated_at=datetime('now') WHERE id=?3 AND status='queued'`
  ).bind(reason, retryAt, messageId).run();
}

/**
 * The single send path - used by the queue consumer and by /send-now.
 * D1 is the source of truth; every gate is re-checked here at send time.
 */
export async function processSend(env: Env, messageId: string): Promise<SendOutcome> {
  const workspace = await getWorkspaceProfile(env);
  if (workspace.demoMode) return { action: 'ack', reason: 'demo mode blocks delivery' };
  const issues = profileIssues(workspace);
  if (issues.length) return { action: 'ack', reason: `workspace profile incomplete: ${issues.join(', ')}` };
  const message = await env.DB
    .prepare(`SELECT * FROM messages WHERE id = ?1`)
    .bind(messageId)
    .first<MessageRow>();
  if (!message || message.direction !== 'outbound') return { action: 'ack', reason: 'message not found' };
  // Idempotency: duplicate queue delivery of an already-handled message is a no-op.
  if (message.status !== 'queued') return { action: 'ack', reason: `status is '${message.status}'` };
  if (!message.profile_snapshot) {
    await env.DB.prepare(
      `UPDATE messages SET status='needs_review', draft_quality_status='needs_review', sendability_status='needs_review',
         status_reason='Legacy draft must be regenerated under the current Business profile',
         next_action='regenerate_under_workspace_profile', scheduled_at=NULL, updated_at=datetime('now')
       WHERE id=?1 AND status='queued'`
    ).bind(messageId).run();
    if (message.lead_id) await recordEvent(env.DB, message.lead_id, 'auto_send_blocked', { message_id: messageId, reason: 'legacy_draft_requires_regeneration' });
    return { action: 'ack', reason: 'legacy draft requires regeneration' };
  }
  if (message.status_reason === 'Scheduled by campaign automation' || (message.sequence_step > 1 && message.status_reason === 'Scheduled follow-up')) {
    await env.DB.prepare(
      `UPDATE messages SET status='needs_review', sendability_status='needs_review',
         status_reason='Legacy automated queue blocked; human approval required', next_action='review_and_approve_draft',
         scheduled_at=NULL, updated_at=datetime('now') WHERE id=?1 AND status='queued'`
    ).bind(messageId).run();
    if (message.lead_id) await recordEvent(env.DB, message.lead_id, 'auto_send_blocked', { message_id: messageId, reason: 'human_approval_required' });
    return { action: 'ack', reason: 'human approval required' };
  }
  const scheduleDelay = secondsUntilScheduled(message.scheduled_at);
  if (scheduleDelay !== null) {
    await markQueuedReason(env, messageId, 'Scheduled for delivery');
    return { action: 'retry', delaySeconds: scheduleDelay, reason: 'scheduled for later' };
  }

  if (!message.lead_id) {
    await markFailed(env, messageId, 'no lead attached');
    return { action: 'ack', reason: 'no lead' };
  }
  const lead = await env.DB
    .prepare(`SELECT * FROM leads WHERE id = ?1`)
    .bind(message.lead_id)
    .first<LeadRow>();
  if (!lead) {
    await markFailed(env, messageId, 'lead not found');
    return { action: 'ack', reason: 'lead not found' };
  }
  const testDelivery = deliveryTestEnabled(lead);
  const snapshot = deliverySnapshot(message);
  const senderEmail = (snapshot.senderEmail || message.from_email || env.FROM_EMAIL || '').trim().toLowerCase();
  if (!isValidEmail(senderEmail)) {
    await markFailed(env, messageId, 'No valid sender email is configured');
    return { action: 'ack', reason: 'sender email is not configured' };
  }
  const deploymentSender = (env.FROM_EMAIL ?? '').trim().toLowerCase();
  const verifiedSender = senderEmail === deploymentSender && isValidEmail(deploymentSender)
    ? true
    : !!(await env.DB.prepare('SELECT 1 AS present FROM sender_profiles WHERE sender_email=?1 AND is_verified=1 AND is_active=1 LIMIT 1')
      .bind(senderEmail).first<{ present: number }>());
  if (!verifiedSender) {
    await markFailed(env, messageId, 'Sender identity is not verified in Zoho');
    return { action: 'ack', reason: 'sender identity is not verified' };
  }
  let campaign = null;
  if (message.campaign_id) {
    campaign = await getCampaign(env, message.campaign_id);
    if (campaign.status !== 'active') {
      await markQueuedReason(env, messageId, `Campaign is ${campaign.status}; resume it to send`, 900);
      await recordSequenceEvent(env, campaign.id, lead.id, message.id, 'send_deferred', { reason: `campaign_${campaign.status}` });
      return { action: 'retry', delaySeconds: 900, reason: `campaign is ${campaign.status}` };
    }
    const campaignDay = dayString(campaign.timezone);
    if (campaign.start_date && campaignDay < campaign.start_date) {
      await markQueuedReason(env, messageId, 'Campaign has not started yet', 3600);
      await recordSequenceEvent(env, campaign.id, lead.id, message.id, 'send_deferred', { reason: 'campaign_not_started' });
      return { action: 'retry', delaySeconds: 3600, reason: 'campaign has not started' };
    }
    if (campaign.end_date && campaignDay > campaign.end_date) {
      await markFailed(env, messageId, 'campaign end date has passed');
      await recordSequenceEvent(env, campaign.id, lead.id, message.id, 'send_blocked', { reason: 'campaign_ended' });
      return { action: 'ack', reason: 'campaign ended' };
    }
    if (campaign.maximum_volume !== null) {
      const sent = await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages WHERE campaign_id=?1 AND direction='outbound' AND status='sent'`).bind(campaign.id).first<{n:number}>();
      if ((sent?.n ?? 0) >= campaign.maximum_volume) {
        await markQueuedReason(env, messageId, 'Campaign volume cap reached; waiting for capacity', 86_400);
        await recordSequenceEvent(env, campaign.id, lead.id, message.id, 'send_deferred', { reason: 'campaign_volume_cap' });
        return { action: 'retry', delaySeconds: 86_400, reason: 'campaign volume cap' };
      }
    }
  }

  // Gate 1: suppression (final check - the list may have grown since approval).
  const suppressedReason = await isSuppressed(env.DB, lead.email, lead.domain);
  if (suppressedReason) {
    await markFailed(env, messageId, `suppressed: ${suppressedReason}`);
    const leadStatus = 'suppressed';
    await env.DB
      .prepare(
        `UPDATE leads SET status = ?1, sales_stage = 'do_not_contact',
           next_action = 'suppressed', updated_at = datetime('now') WHERE id = ?2`
    )
      .bind(leadStatus, lead.id)
      .run();
    if (campaign) {
      await env.DB.prepare(`UPDATE campaign_leads SET status='suppressed',updated_at=datetime('now') WHERE campaign_id=?1 AND lead_id=?2`).bind(campaign.id, lead.id).run();
      await recordSequenceEvent(env, campaign.id, lead.id, messageId, 'send_blocked', { reason: 'suppressed' });
    }
    await recordEvent(env.DB, lead.id, 'send_blocked', { message_id: messageId, reason: suppressedReason });
    return { action: 'ack', reason: 'suppressed' };
  }

  // Gate 2: exactly one initial email, plus one campaign-owned follow-up.
  const dupes = await env.DB
    .prepare(
      `SELECT id, status FROM messages
       WHERE lead_id = ?1 AND direction = 'outbound' AND id != ?2
         AND NOT (campaign_id = ?3 AND ?4 = 2 AND sequence_step = 1)
         AND status IN ('approved','queued','sending','sent','send_unknown')`
    )
    .bind(lead.id, messageId, message.campaign_id ?? '', message.sequence_step)
    .all<{ id: string; status: string }>();
  if (dupes.results.some((row) => priorOutboundBlocksDelivery(testDelivery, row.status))) {
    await markFailed(env, messageId, 'another email was already sent to this lead');
    await recordEvent(env.DB, lead.id, 'send_blocked', { message_id: messageId, reason: 'one_email_rule' });
    return { action: 'ack', reason: 'one-email rule' };
  }

  // Gate 3: business-hours send window (UTC unless configured otherwise).
  const sendEnv = campaign ? { ...env, SEND_WINDOW: campaign.send_window, SEND_DAYS: campaign.send_days, TIMEZONE: campaign.timezone } : env;
  if (!isInSendWindow(sendEnv)) {
    const delay = clampDelay(secondsToNextWindowOpen(sendEnv));
    await markQueuedReason(env, messageId, 'Outside the configured send window', delay);
    await recordEvent(env.DB, lead.id, 'send_deferred', { message_id: messageId, reason: 'window', delay });
    return { action: 'retry', delaySeconds: delay, reason: 'outside send window' };
  }

  // Gate 4: daily cap, taken atomically.
  const day = dayString(sendEnv.TIMEZONE);
  // A campaign's selected daily plan is an explicit override of the organisation default.
  const cap = campaign ? campaign.daily_cap : snapshot.batchDailyCap || intVar(env.DAILY_SEND_CAP, 10);
  if (!(await takeDailySlot(env, day, cap))) {
    const delay = clampDelay(secondsToNextWindowOpen(sendEnv));
    await markQueuedReason(env, messageId, 'Daily send cap reached; waiting for the next window', delay);
    await recordEvent(env.DB, lead.id, 'send_deferred', { message_id: messageId, reason: 'daily_cap', delay });
    return { action: 'retry', delaySeconds: delay, reason: 'daily cap reached' };
  }
  let campaignSlotTaken = false;
  if (campaign && !(await takeCampaignDailySlot(env, campaign.id, day, weekStartString(sendEnv.TIMEZONE), campaign.daily_cap))) {
    await decrementCounter(env, day);
    await markQueuedReason(env, messageId, 'Campaign daily cap reached; waiting for the next window', clampDelay(secondsToNextWindowOpen(sendEnv)));
    await recordSequenceEvent(env, campaign.id, lead.id, message.id, 'send_deferred', { reason: 'campaign_daily_cap' });
    return { action: 'retry', delaySeconds: clampDelay(secondsToNextWindowOpen(sendEnv)), reason: 'campaign daily cap reached' };
  } else if (campaign) {
    campaignSlotTaken = true;
  }

  // Gate 5: per-domain courtesy cap (don't pile onto one company). The slot
  // is reserved atomically so concurrent queue consumers cannot exceed it.
  const weekStart = weekStartString(sendEnv.TIMEZONE);
  let domainSlotTaken = false;
  if (!testDelivery) {
    const domainCap = campaign ? Math.min(intVar(env.DOMAIN_WEEKLY_CAP, 2), campaign.domain_weekly_cap) : intVar(env.DOMAIN_WEEKLY_CAP, 2);
    if (!(await takeDomainSlot(env, weekStart, lead.domain, domainCap))) {
      await decrementCounter(env, day);
      if (campaignSlotTaken && campaign) await decrementCampaignDailyCounter(env, campaign.id, day);
      await markQueuedReason(env, messageId, 'Recipient domain courtesy cap reached; retrying next week', clampDelay(86_400));
      await recordEvent(env.DB, lead.id, 'send_deferred', { message_id: messageId, reason: 'domain_cap' });
      return { action: 'retry', delaySeconds: clampDelay(86_400), reason: 'domain weekly cap' };
    }
    domainSlotTaken = true;
  }

  // Claim - the double-send guard. Only one consumer can flip queued -> sending.
  const claim = await env.DB
    .prepare(
      `UPDATE messages SET status = 'sending', attempts = attempts + 1, last_attempt_at = datetime('now'),
          status_reason = 'Sending through Zoho', updated_at = datetime('now')
       WHERE id = ?1 AND status = 'queued'`
    )
    .bind(messageId)
    .run();
  if ((claim.meta.changes ?? 0) === 0) {
    await decrementCounter(env, day);
    if (campaignSlotTaken && campaign) await decrementCampaignDailyCounter(env, campaign.id, day);
    if (domainSlotTaken) await decrementDomainCounter(env, weekStart, lead.domain);
    return { action: 'ack', reason: 'claimed elsewhere' };
  }

  const finalBody = ensureFooter(message.body ?? '', snapshot.footerHtml ?? (await getOutreachSettings(env.DB)).footerHtml);
  const subject = message.subject ?? `${workspace.businessName}: a practical idea`;
  const settings = await getOutreachSettings(env.DB);
  const senderDisplayName = safeSenderDisplayName(snapshot.senderDisplayName || message.sender_display_name, effectiveSenderDisplayName(settings, env, workspace.businessName));

  try {
    const sent = await trySendWithAuthRetry(env, lead.email, subject, finalBody, {
      from: snapshot.senderEmail || message.from_email || undefined,
      cc: snapshot.ccEmail ?? undefined,
      bcc: snapshot.bccEmail ?? undefined,
    });
    await env.DB
      .prepare(
        `UPDATE messages SET status = 'sent', body = ?1, zoho_message_id = COALESCE(?2, zoho_message_id), error = NULL,
           error_code = NULL, error_detail = NULL, retry_at = NULL, provider_status = 'accepted',
           sendability_status = 'sendable', status_reason = 'Accepted by Zoho', sender_display_name = ?3,
           sent_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ?4 AND status = 'sending'`
      )
      .bind(finalBody, sent.internetMessageId ?? sent.providerMessageId, senderDisplayName, messageId)
      .run();
    await env.DB
      .prepare(
        `UPDATE leads SET status = 'sent', delivery_test = 0, sales_stage = 'awaiting_reply',
           next_action = 'wait_for_reply_no_auto_follow_up', updated_at = datetime('now') WHERE id = ?1`
      )
      .bind(lead.id)
      .run();
    await recordEvent(env.DB, lead.id, 'sent', {
      message_id: messageId,
      dry_run: sent.dryRun,
      delivery_test: testDelivery,
    });
    if (campaign) {
      await env.DB.prepare(`UPDATE campaign_leads SET status='sent',status_reason='Accepted by Zoho',updated_at=datetime('now') WHERE campaign_id=?1 AND lead_id=?2`).bind(campaign.id,lead.id).run();
      await recordSequenceEvent(env,campaign.id,lead.id,message.id,'sent',{step:message.sequence_step});
    }
    return { action: 'sent', dryRun: sent.dryRun };
  } catch (err) {
    if (err instanceof ZohoError && err.kind === 'permanent') {
      const recipientFailure = err.code === 'invalid_recipient';
      const operatorReason = recipientFailure
        ? 'Recipient address was rejected; verify the address before retrying'
        : err.code === 'sender_not_verified'
          ? 'Sender address is not approved by Zoho; fix the sender profile before retrying'
          : 'Zoho rejected this message; review the provider detail before retrying';
      await env.DB.prepare(
        `UPDATE messages SET status='failed', error=?1, error_code=?2, error_detail=?3,
           status_reason=?4, sendability_status='blocked', retry_at=NULL, updated_at=datetime('now')
         WHERE id=?5`
      ).bind(err.message.slice(0, 500), err.code, err.providerDescription.slice(0, 500), operatorReason, messageId).run();
      await env.DB
        .prepare(
          `UPDATE leads SET status = 'failed', delivery_test = 0, sales_stage = 'delivery_issue',
             next_action = ?1, updated_at = datetime('now') WHERE id = ?2`
        )
        .bind(recipientFailure ? 'verify_recipient' : 'fix_sender_or_message', lead.id)
        .run();
      if (recipientFailure) await addSuppression(env.DB, 'email', lead.email, 'hard_bounce', messageId);
      await decrementCounter(env, day);
      if (campaignSlotTaken && campaign) await decrementCampaignDailyCounter(env, campaign.id, day);
      if (domainSlotTaken) await decrementDomainCounter(env, weekStart, lead.domain);
      await recordEvent(env.DB, lead.id, 'send_failed', { message_id: messageId, kind: err.code });
      if (campaign) {
        await env.DB.prepare(`UPDATE campaign_leads SET status='failed',status_reason=?1,updated_at=datetime('now') WHERE campaign_id=?2 AND lead_id=?3`).bind(operatorReason, campaign.id, lead.id).run();
        await recordSequenceEvent(env, campaign.id, lead.id, messageId, 'send_failed', { kind: err.code });
      }
      return { action: 'ack', reason: 'permanent send failure' };
    }
    const kind = err instanceof ZohoError ? err.kind : 'unknown';
    const messageText = err instanceof Error ? err.message : String(err);
    const errorCode = err instanceof ZohoError ? err.code : 'unknown_provider_error';
    const retrySeconds = err instanceof ZohoError && err.retryAfterSeconds
      ? Math.max(60, Math.min(err.retryAfterSeconds, MAX_DELAY_SECONDS))
      : kind === 'auth' ? 3600 : kind === 'rate' ? 1800 : 900;
    const retryAt = new Date(Date.now() + retrySeconds * 1000).toISOString();
    const reason = kind === 'rate'
      ? 'Zoho rate limit reached; retry scheduled'
      : kind === 'auth'
        ? 'Zoho authentication failed; token refresh will retry'
        : 'Zoho is temporarily unavailable; retry scheduled';
    await revertToQueued(env, messageId, messageText, errorCode, retryAt, reason);
    await decrementCounter(env, day);
    if (campaignSlotTaken && campaign) await decrementCampaignDailyCounter(env, campaign.id, day);
    if (domainSlotTaken) await decrementDomainCounter(env, weekStart, lead.domain);
    await recordEvent(env.DB, lead.id, 'send_failed', { message_id: messageId, kind });
    return { action: 'retry', delaySeconds: clampDelay(retrySeconds), reason };
  }
}

async function trySendWithAuthRetry(
  env: Env,
  to: string,
  subject: string,
  content: string,
  overrides: { from?: string; cc?: string; bcc?: string }
): Promise<{ dryRun: boolean; providerMessageId: string | null; internetMessageId: string | null }> {
  const settings = await getOutreachSettings(env.DB);
  const from = overrides.from || effectiveSenderEmail(settings, env);
  const defaultCopyTo = env.OUTREACH_CC_EMAIL.trim().toLowerCase() === from.trim().toLowerCase()
    ? undefined
    : env.OUTREACH_CC_EMAIL;
  const copyTo = overrides.cc ?? defaultCopyTo;
  const args = { to, subject, content, from, cc: copyTo, bcc: overrides.bcc };
  try {
    return await sendMail(env, args);
  } catch (err) {
    if (err instanceof ZohoError && err.kind === 'auth') {
      await getAccessToken(env, true);
      return sendMail(env, args);
    }
    throw err;
  }
}
