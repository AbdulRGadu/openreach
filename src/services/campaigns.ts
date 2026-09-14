import type { Env } from '../env.ts';
import { HttpError, isValidEmail, jsonResponse, normalizeMultiline, normalizeText } from '../http.ts';
import type { CampaignRow, LeadRow, QualityPolicy, SenderProfileRow } from '../types.ts';
import { DEFAULT_OUTREACH_SETTINGS, effectiveSenderDisplayName, getOutreachSettings, safeSenderDisplayName, type OutreachSettings } from './outreachSettings.ts';
import { getWorkspaceProfile } from './workspaceProfile.ts';

const QUALITY_POLICIES = new Set<QualityPolicy>(['balanced', 'strict', 'custom']);
const CAMPAIGN_STATUSES = new Set<CampaignRow['status']>(['draft', 'active', 'paused', 'archived', 'completed']);

function email(value: unknown, label: string, optional = false): string | null {
  const result = normalizeText(value, 254).toLowerCase();
  if (!result && optional) return null;
  if (!isValidEmail(result)) throw new HttpError(400, `${label} must be a valid email address`);
  return result;
}

function bool(value: unknown, fallback: boolean): number {
  return value === undefined ? Number(fallback) : Number(value === true || value === 1 || value === '1');
}

function positive(value: unknown, fallback: number, min = 1, max = 10000): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `Expected a whole number between ${min} and ${max}`);
  return n;
}

function policy(value: unknown, fallback: QualityPolicy = 'balanced'): QualityPolicy {
  const result = normalizeText(value, 20) as QualityPolicy;
  if (!result) return fallback;
  if (!QUALITY_POLICIES.has(result)) throw new HttpError(400, 'qualityPolicy must be balanced, strict, or custom');
  return result;
}

function sendWindow(value: unknown, fallback = '09:00-16:00'): string {
  const result = normalizeText(value, 20) || fallback;
  if (!/^([01]?\d|2[0-3]):[0-5]\d-([01]?\d|2[0-3]):[0-5]\d$/.test(result)) throw new HttpError(400, 'sendWindow must use HH:MM-HH:MM');
  return result;
}

function sendStartTime(value: unknown, fallback = '09:00'): string {
  const result = normalizeText(value, 10) || fallback;
  if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(result)) throw new HttpError(400, 'sendStartTime must use HH:MM');
  return result;
}

function sendDays(value: unknown, fallback = '1,2,3,4,5'): string {
  const result = normalizeText(value, 30) || fallback;
  const values = [...new Set(result.split(',').map((part) => Number(part.trim())).filter((n) => Number.isInteger(n) && n >= 1 && n <= 7))];
  if (!values.length) throw new HttpError(400, 'sendDays must contain weekdays 1 through 7');
  return values.join(',');
}

async function defaultProfile(env: Env): Promise<SenderProfileRow> {
  const settings = await getOutreachSettings(env.DB);
  const workspace = await getWorkspaceProfile(env);
  const senderEmail = env.FROM_EMAIL?.trim() || '';
  const verified = Number(isValidEmail(senderEmail));
  return {
    id: 'default-workspace', name: `${workspace.businessName || 'Workspace'} Sender`, display_name: settings.senderDisplayName || workspace.businessName || effectiveSenderDisplayName(settings, env), sender_email: senderEmail,
    reply_email: senderEmail, cc_email: env.OUTREACH_CC_EMAIL || null, bcc_email: null,
    greeting: settings.greeting, fallback_greeting: settings.fallbackGreeting, signoff: settings.signoff, sender_name: settings.senderName || null,
    cta: settings.cta, footer_html: settings.footerHtml, quality_policy: 'balanced',
    is_verified: verified, display_name_verified: 0, is_active: verified, created_at: '', updated_at: '',
  };
}

export async function ensureDefaultSenderProfile(env: Env): Promise<SenderProfileRow> {
  const existing = await env.DB.prepare('SELECT * FROM sender_profiles WHERE id = ?1').bind('default-workspace').first<SenderProfileRow>();
  if (existing) return existing;
  const profile = await defaultProfile(env);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO sender_profiles (
      id, name, display_name, sender_email, reply_email, cc_email, greeting, fallback_greeting,
      signoff, sender_name, cta, footer_html, quality_policy, is_verified, display_name_verified, is_active
    ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)`
  ).bind(profile.id, profile.name, profile.display_name, profile.sender_email, profile.reply_email, profile.cc_email,
    profile.greeting, profile.fallback_greeting, profile.signoff, profile.sender_name, profile.cta,
    profile.footer_html, profile.quality_policy, profile.is_verified, profile.display_name_verified, profile.is_active).run();
  return (await env.DB.prepare('SELECT * FROM sender_profiles WHERE id = ?1').bind(profile.id).first<SenderProfileRow>()) ?? profile;
}

export function senderProfileSettings(profile: SenderProfileRow, campaign?: CampaignRow | null): OutreachSettings {
  return {
    greeting: profile.greeting,
    fallbackGreeting: profile.fallback_greeting,
    signoff: profile.signoff,
    senderName: profile.sender_name ?? '',
    senderEmail: profile.sender_email,
    senderDisplayName: safeSenderDisplayName(profile.display_name),
    cta: campaign?.cta || profile.cta,
    footerHtml: profile.footer_html,
  };
}

export async function getSenderProfile(env: Env, id: string): Promise<SenderProfileRow> {
  const profile = await env.DB.prepare('SELECT * FROM sender_profiles WHERE id = ?1').bind(id).first<SenderProfileRow>();
  if (!profile) throw new HttpError(404, 'Sender profile not found');
  return profile;
}

export async function handleSenderProfilesList(env: Env): Promise<Response> {
  await ensureDefaultSenderProfile(env);
  const rows = await env.DB.prepare('SELECT * FROM sender_profiles ORDER BY is_active DESC, name ASC').all<SenderProfileRow>();
  return jsonResponse({ ok: true, profiles: rows.results });
}

export async function handleSenderProfilePost(body: Record<string, unknown>, env: Env): Promise<Response> {
  const senderEmail = email(body.senderEmail, 'senderEmail') as string;
  const replyEmail = email(body.replyEmail ?? senderEmail, 'replyEmail') as string;
  // Zoho's sending endpoint cannot provide a reliable per-message Reply-To.
  // The authenticated sender is therefore the reply destination for this release.
  if (replyEmail !== senderEmail) throw new HttpError(400, 'The reply inbox must be the same Zoho-approved sender address');
  const profile = {
    id: crypto.randomUUID(),
    name: normalizeText(body.name, 100), displayName: normalizeText(body.displayName, 100) || null,
    senderEmail, replyEmail,
    ccEmail: email(body.ccEmail, 'ccEmail', true), bccEmail: email(body.bccEmail, 'bccEmail', true),
    greeting: normalizeText(body.greeting, 40) || 'Hi', fallbackGreeting: normalizeText(body.fallbackGreeting, 40) || 'Hello',
    signoff: normalizeText(body.signoff, 80) || 'Best regards', senderName: normalizeText(body.senderName, 80) || null,
    cta: normalizeText(body.cta, 220) || DEFAULT_OUTREACH_SETTINGS.cta,
    footerHtml: normalizeMultiline(body.footerHtml, 10_000), qualityPolicy: policy(body.qualityPolicy),
  };
  if (!profile.name) throw new HttpError(400, 'Profile name is required');
  // Only the deployed Zoho mailbox or an explicitly confirmed Zoho-approved
  // sender can be activated.
  const verified = Number(senderEmail === (env.FROM_EMAIL ?? '').trim().toLowerCase() || body.confirmZohoApproved === true);
  const displayNameVerified = Number(body.displayNameVerified === true);
  await env.DB.prepare(
    `INSERT INTO sender_profiles (
      id,name,display_name,sender_email,reply_email,cc_email,bcc_email,greeting,fallback_greeting,
      signoff,sender_name,cta,footer_html,quality_policy,is_verified,display_name_verified,is_active
    ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)`
  ).bind(profile.id, profile.name, profile.displayName, profile.senderEmail, profile.replyEmail, profile.ccEmail,
    profile.bccEmail, profile.greeting, profile.fallbackGreeting, profile.signoff, profile.senderName, profile.cta,
    profile.footerHtml, profile.qualityPolicy, verified, displayNameVerified, verified).run();
  return jsonResponse({ ok: true, profile: await getSenderProfile(env, profile.id) }, 201);
}

export async function handleSenderProfilePatch(id: string, body: Record<string, unknown>, env: Env): Promise<Response> {
  const current = await getSenderProfile(env, id);
  const senderEmail = body.senderEmail === undefined ? current.sender_email : email(body.senderEmail, 'senderEmail') as string;
  const replyEmail = email(body.replyEmail ?? current.reply_email, 'replyEmail') as string;
  if (replyEmail !== senderEmail) throw new HttpError(400, 'The reply inbox must be the same Zoho-approved sender address');
  const verified = senderEmail === (env.FROM_EMAIL ?? '').trim().toLowerCase() ? 1 : body.confirmZohoApproved === true ? 1 : 0;
  await env.DB.prepare(
    `UPDATE sender_profiles SET name=?1, display_name=?2, sender_email=?3, reply_email=?4, cc_email=?5, bcc_email=?6,
      greeting=?7, fallback_greeting=?8, signoff=?9, sender_name=?10, cta=?11, footer_html=?12, quality_policy=?13,
      is_verified=?14, display_name_verified=?15, is_active=?16, updated_at=datetime('now') WHERE id=?17`
  ).bind(
    normalizeText(body.name ?? current.name, 100), normalizeText(body.displayName ?? current.display_name, 100) || null, senderEmail,
    replyEmail, email(body.ccEmail ?? current.cc_email, 'ccEmail', true),
    email(body.bccEmail ?? current.bcc_email, 'bccEmail', true), normalizeText(body.greeting ?? current.greeting, 40) || 'Hi',
    normalizeText(body.fallbackGreeting ?? current.fallback_greeting, 40) || 'Hello', normalizeText(body.signoff ?? current.signoff, 80) || 'Best regards',
    normalizeText(body.senderName ?? current.sender_name, 80) || null, normalizeText(body.cta ?? current.cta, 220) || DEFAULT_OUTREACH_SETTINGS.cta,
    normalizeMultiline(body.footerHtml ?? current.footer_html, 10_000), policy(body.qualityPolicy ?? current.quality_policy), verified,
    body.displayNameVerified === undefined ? current.display_name_verified : bool(body.displayNameVerified, false),
    body.isActive === undefined ? current.is_active : bool(body.isActive, true), id
  ).run();
  return jsonResponse({ ok: true, profile: await getSenderProfile(env, id) });
}

export async function getCampaign(env: Env, id: string): Promise<CampaignRow> {
  const campaign = await env.DB.prepare('SELECT * FROM campaigns WHERE id = ?1').bind(id).first<CampaignRow>();
  if (!campaign) throw new HttpError(404, 'Campaign not found');
  return campaign;
}

export async function activeCampaignForLead(env: Env, leadId: string): Promise<{ campaign: CampaignRow; profile: SenderProfileRow } | null> {
  const row = await env.DB.prepare(
    `SELECT c.* FROM campaigns c JOIN campaign_leads cl ON cl.campaign_id = c.id
     WHERE cl.lead_id = ?1 AND cl.status = 'eligible' AND c.status IN ('draft','active','paused')
     ORDER BY cl.added_at DESC LIMIT 1`
  ).bind(leadId).first<CampaignRow>();
  if (!row || !row.sender_profile_id) return null;
  return { campaign: row, profile: await getSenderProfile(env, row.sender_profile_id) };
}

export async function handleCampaignsList(env: Env): Promise<Response> {
  await ensureDefaultSenderProfile(env);
  const rows = await env.DB.prepare(
    `SELECT c.*, p.name AS sender_profile_name,
      COUNT(cl.lead_id) AS audience_count,
      SUM(CASE WHEN cl.status = 'sent' THEN 1 ELSE 0 END) AS sent_count,
      SUM(CASE WHEN cl.status = 'replied' THEN 1 ELSE 0 END) AS replied_count,
      (SELECT COUNT(*) FROM messages m WHERE m.campaign_id = c.id AND m.direction='outbound' AND m.status='queued') AS queued_count,
      (SELECT COUNT(*) FROM messages m WHERE m.campaign_id = c.id AND m.direction='outbound' AND m.status IN ('needs_review','failed','send_unknown')) AS attention_count,
      (SELECT MIN(m.scheduled_at) FROM messages m WHERE m.campaign_id = c.id AND m.direction='outbound' AND m.status='queued') AS next_scheduled_at
     FROM campaigns c LEFT JOIN sender_profiles p ON p.id=c.sender_profile_id
     LEFT JOIN campaign_leads cl ON cl.campaign_id=c.id GROUP BY c.id ORDER BY c.updated_at DESC`
  ).all();
  return jsonResponse({ ok: true, campaigns: rows.results });
}

export async function handleCampaignPost(body: Record<string, unknown>, env: Env): Promise<Response> {
  const profile = body.senderProfileId ? await getSenderProfile(env, normalizeText(body.senderProfileId, 80)) : await ensureDefaultSenderProfile(env);
  const id = crypto.randomUUID();
  const name = normalizeText(body.name, 140);
  if (!name) throw new HttpError(400, 'Campaign name is required');
  const status = (normalizeText(body.status, 20) || 'draft') as CampaignRow['status'];
  if (!CAMPAIGN_STATUSES.has(status)) throw new HttpError(400, 'Invalid campaign status');
  const values = {
    objective: normalizeMultiline(body.objective, 500) || null, owner: normalizeText(body.ownerLabel, 100) || null,
    notes: normalizeMultiline(body.notes, 3000) || null, timezone: normalizeText(body.timezone, 80) || 'UTC',
    start: normalizeText(body.startDate, 20) || null, end: normalizeText(body.endDate, 20) || null,
    autoSend: 0, followUp: bool(body.followUpEnabled, true), delay: positive(body.followUpDelayBusinessDays, 4, 1, 14),
    window: sendWindow(body.sendWindow), startTime: sendStartTime(body.sendStartTime), interval: positive(body.sendIntervalMinutes, 2, 1, 60), days: sendDays(body.sendDays), daily: positive(body.dailyCap, 10, 1, 500), domain: positive(body.domainWeeklyCap, 2, 1, 50),
    max: body.maximumVolume === undefined || body.maximumVolume === '' ? null : positive(body.maximumVolume, 1, 1, 100000),
    policy: policy(body.qualityPolicy, profile.quality_policy), tone: normalizeText(body.tone, 200) || null,
    offer: normalizeText(body.offer, 220) || null, cta: normalizeText(body.cta, 220) || null, angle: normalizeText(body.sectorAngle, 400) || null,
    initial: normalizeMultiline(body.initialTemplate, 5000) || null, followTemplate: normalizeMultiline(body.followUpTemplate, 5000) || null,
  };
  if (status === 'active' && (!profile.is_verified || !profile.is_active)) throw new HttpError(409, 'Select a verified, active sender profile before activating this campaign');
  await env.DB.prepare(
    `INSERT INTO campaigns (id,name,status,objective,owner_label,notes,sender_profile_id,timezone,start_date,end_date,auto_send,follow_up_enabled,follow_up_delay_business_days,send_window,send_start_time,send_interval_minutes,send_days,daily_cap,domain_weekly_cap,maximum_volume,quality_policy,tone,offer,cta,sector_angle,initial_template,follow_up_template)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27)`
  ).bind(id,name,status,values.objective,values.owner,values.notes,profile.id,values.timezone,values.start,values.end,values.autoSend,values.followUp,values.delay,values.window,values.startTime,values.interval,values.days,values.daily,values.domain,values.max,values.policy,values.tone,values.offer,values.cta,values.angle,values.initial,values.followTemplate).run();
  await env.DB.prepare(`INSERT INTO campaign_send_policies (campaign_id,send_days,send_window,daily_cap,domain_weekly_cap,maximum_volume) VALUES (?1,?2,?3,?4,?5,?6)`).bind(id,values.days,values.window,values.daily,values.domain,values.max).run();
  return jsonResponse({ ok: true, campaign: await getCampaign(env, id) }, 201);
}

export async function handleCampaignPatch(id: string, body: Record<string, unknown>, env: Env): Promise<Response> {
  const current = await getCampaign(env, id);
  const profile = body.senderProfileId === undefined ? (current.sender_profile_id ? await getSenderProfile(env, current.sender_profile_id) : await ensureDefaultSenderProfile(env)) : await getSenderProfile(env, normalizeText(body.senderProfileId, 80));
  const status = (normalizeText(body.status ?? current.status, 20) || current.status) as CampaignRow['status'];
  if (!CAMPAIGN_STATUSES.has(status)) throw new HttpError(400, 'Invalid campaign status');
  if (status === 'active' && (!profile.is_verified || !profile.is_active)) throw new HttpError(409, 'Select a verified, active sender profile before activating this campaign');
  const autoSend = 0; const follow = bool(body.followUpEnabled, current.follow_up_enabled === 1);
  const days = sendDays(body.sendDays, current.send_days); const window = sendWindow(body.sendWindow, current.send_window);
  const startTime = sendStartTime(body.sendStartTime, current.send_start_time); const interval = positive(body.sendIntervalMinutes, current.send_interval_minutes, 1, 60);
  const daily = positive(body.dailyCap, current.daily_cap, 1, 500); const domain = positive(body.domainWeeklyCap, current.domain_weekly_cap, 1, 50);
  const max = body.maximumVolume === undefined ? current.maximum_volume : body.maximumVolume === '' ? null : positive(body.maximumVolume, 1, 1, 100000);
  await env.DB.prepare(
    `UPDATE campaigns SET name=?1,status=?2,objective=?3,owner_label=?4,notes=?5,sender_profile_id=?6,timezone=?7,start_date=?8,end_date=?9,auto_send=?10,follow_up_enabled=?11,follow_up_delay_business_days=?12,send_window=?13,send_start_time=?14,send_interval_minutes=?15,send_days=?16,daily_cap=?17,domain_weekly_cap=?18,maximum_volume=?19,quality_policy=?20,tone=?21,offer=?22,cta=?23,sector_angle=?24,initial_template=?25,follow_up_template=?26,updated_at=datetime('now') WHERE id=?27`
  ).bind(normalizeText(body.name ?? current.name, 140),status,normalizeMultiline(body.objective ?? current.objective,500)||null,normalizeText(body.ownerLabel ?? current.owner_label,100)||null,normalizeMultiline(body.notes ?? current.notes,3000)||null,profile.id,normalizeText(body.timezone ?? current.timezone,80)||'UTC',normalizeText(body.startDate ?? current.start_date,20)||null,normalizeText(body.endDate ?? current.end_date,20)||null,autoSend,follow,positive(body.followUpDelayBusinessDays,current.follow_up_delay_business_days,1,14),window,startTime,interval,days,daily,domain,max,policy(body.qualityPolicy ?? current.quality_policy),normalizeText(body.tone ?? current.tone,200)||null,normalizeText(body.offer ?? current.offer,220)||null,normalizeText(body.cta ?? current.cta,220)||null,normalizeText(body.sectorAngle ?? current.sector_angle,400)||null,normalizeMultiline(body.initialTemplate ?? current.initial_template,5000)||null,normalizeMultiline(body.followUpTemplate ?? current.follow_up_template,5000)||null,id).run();
  await env.DB.prepare(`INSERT INTO campaign_send_policies (campaign_id,send_days,send_window,daily_cap,domain_weekly_cap,maximum_volume,updated_at) VALUES (?1,?2,?3,?4,?5,?6,datetime('now')) ON CONFLICT(campaign_id) DO UPDATE SET send_days=excluded.send_days,send_window=excluded.send_window,daily_cap=excluded.daily_cap,domain_weekly_cap=excluded.domain_weekly_cap,maximum_volume=excluded.maximum_volume,updated_at=excluded.updated_at`).bind(id,days,window,daily,domain,max).run();
  return jsonResponse({ ok: true, campaign: await getCampaign(env,id) });
}

export async function handleCampaignClone(id: string, env: Env): Promise<Response> {
  const campaign = await getCampaign(env, id);
  return handleCampaignPost({
    name: `${campaign.name} copy`, status: 'draft', senderProfileId: campaign.sender_profile_id,
    objective: campaign.objective, ownerLabel: campaign.owner_label, notes: campaign.notes, timezone: campaign.timezone,
    autoSend: campaign.auto_send === 1, followUpEnabled: campaign.follow_up_enabled === 1,
    followUpDelayBusinessDays: campaign.follow_up_delay_business_days, sendWindow: campaign.send_window, sendStartTime: campaign.send_start_time, sendIntervalMinutes: campaign.send_interval_minutes, sendDays: campaign.send_days,
    dailyCap: campaign.daily_cap, domainWeeklyCap: campaign.domain_weekly_cap, maximumVolume: campaign.maximum_volume,
    qualityPolicy: campaign.quality_policy, tone: campaign.tone, offer: campaign.offer, cta: campaign.cta, sectorAngle: campaign.sector_angle,
    initialTemplate: campaign.initial_template, followUpTemplate: campaign.follow_up_template,
  }, env);
}

export async function handleCampaignStopUnsent(id: string, env: Env): Promise<Response> {
  await getCampaign(env, id);
  const pending = await env.DB.prepare(
    `SELECT id, lead_id FROM messages WHERE campaign_id=?1 AND direction='outbound' AND status IN ('draft','needs_review','approved','queued')`
  ).bind(id).all<{ id: string; lead_id: string | null }>();
  const stopped = await env.DB.prepare(
    `UPDATE messages SET status='rejected', sendability_status='blocked', status_reason='Campaign stopped this unsent message',
       stopped_at=datetime('now'), stopped_reason='campaign_stopped', next_action='stopped',
       error='Campaign stopped all unsent messages', updated_at=datetime('now')
     WHERE campaign_id=?1 AND direction='outbound' AND status IN ('draft','needs_review','approved','queued')`
  ).bind(id).run();
  await env.DB.prepare(`UPDATE campaigns SET status='paused',updated_at=datetime('now') WHERE id=?1`).bind(id).run();
  await env.DB.prepare(`UPDATE campaign_leads SET status='paused',status_reason='Campaign stopped by operator',updated_at=datetime('now') WHERE campaign_id=?1 AND status IN ('eligible','queued')`).bind(id).run();
  for (const message of pending.results) {
    if (message.lead_id) await recordSequenceEvent(env, id, message.lead_id, message.id, 'send_cancelled', { reason: 'campaign_stopped' });
  }
  return jsonResponse({ ok: true, stopped: stopped.meta.changes ?? 0 });
}

export async function handleCampaignGet(id: string, env: Env): Promise<Response> {
  const campaign = await getCampaign(env,id);
  const [profile, audience, events, funnel, queueSummary] = await Promise.all([
    campaign.sender_profile_id ? getSenderProfile(env,campaign.sender_profile_id) : null,
    env.DB.prepare(`SELECT l.*, cl.status AS campaign_status, cl.added_at AS campaign_added_at FROM campaign_leads cl JOIN leads l ON l.id=cl.lead_id WHERE cl.campaign_id=?1 ORDER BY cl.added_at DESC LIMIT 200`).bind(id).all(),
    env.DB.prepare(`SELECT * FROM sequence_events WHERE campaign_id=?1 ORDER BY created_at DESC LIMIT 100`).bind(id).all(),
    env.DB.prepare(`SELECT status, COUNT(*) AS count FROM campaign_leads WHERE campaign_id=?1 GROUP BY status`).bind(id).all<{status:string;count:number}>(),
    env.DB.prepare(`SELECT COUNT(*) AS queued_count, MIN(scheduled_at) AS next_scheduled_at FROM messages WHERE campaign_id=?1 AND direction='outbound' AND status='queued'`).bind(id).first<{queued_count:number;next_scheduled_at:string|null}>(),
  ]);
  return jsonResponse({ ok:true,campaign:{ ...campaign, queued_count: queueSummary?.queued_count ?? 0, next_scheduled_at: queueSummary?.next_scheduled_at ?? null },profile,audience:audience.results,events:events.results,funnel:Object.fromEntries(funnel.results.map((r)=>[r.status,r.count])) });
}

export async function handleCampaignLeadPost(id: string, body: Record<string, unknown>, env: Env): Promise<Response> {
  await getCampaign(env,id);
  const leadIds = Array.isArray(body.leadIds) ? [...new Set(body.leadIds.map((value)=>normalizeText(value,80)).filter(Boolean))].slice(0,200) : [];
  if (!leadIds.length) throw new HttpError(400,'Provide one or more leadIds');
  const statements: D1PreparedStatement[]=[];
  for (const leadId of leadIds) {
    await env.DB.prepare('SELECT id FROM leads WHERE id=?1').bind(leadId).first<{id:string}>().then((lead)=>{ if(!lead) throw new HttpError(404,`Lead ${leadId} not found`); });
    statements.push(env.DB.prepare(`INSERT INTO campaign_leads (campaign_id,lead_id,status) VALUES (?1,?2,'eligible') ON CONFLICT(campaign_id,lead_id) DO UPDATE SET status='eligible',updated_at=datetime('now')`).bind(id,leadId));
    statements.push(env.DB.prepare(`INSERT INTO sequence_events (id,campaign_id,lead_id,event,detail) VALUES (?1,?2,?3,'lead_assigned',?4)`).bind(crypto.randomUUID(),id,leadId,JSON.stringify({source:'manual'})));
  }
  await env.DB.batch(statements);
  return jsonResponse({ok:true,assigned:leadIds.length});
}

export function renderCampaignTemplate(template: string, lead: LeadRow): string {
  const values: Record<string,string> = { first_name:lead.first_name||'', company_name:lead.company||'', industry:lead.industry||lead.sub_industry||'', role:lead.role||'' };
  return template.replace(/{{\s*(first_name|company_name|industry|role)\s*}}/g,(_,key:string)=>values[key] ?? '');
}

export async function recordSequenceEvent(env: Env, campaignId: string | null, leadId: string, messageId: string | null, event: string, detail?: Record<string,unknown>): Promise<void> {
  if (!campaignId) return;
  await env.DB.prepare(`INSERT INTO sequence_events (id,campaign_id,lead_id,message_id,event,detail) VALUES (?1,?2,?3,?4,?5,?6)`).bind(crypto.randomUUID(),campaignId,leadId,messageId,event,detail?JSON.stringify(detail):null).run();
}
