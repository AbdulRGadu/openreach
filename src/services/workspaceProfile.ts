import type { Env } from '../env.ts';
import { HttpError, isValidEmail, jsonResponse, normalizeText } from '../http.ts';
import { effectiveSenderEmail, getOutreachSettings } from './outreachSettings.ts';

export interface WorkspaceProfile {
  businessName: string;
  website: string;
  industry: string;
  description: string;
  services: string[];
  idealCustomer: string;
  targetIndustries: string[];
  targetRoles: string[];
  painPoints: string[];
  differentiators: string[];
  offer: string;
  cta: string;
  tone: string;
  geography: string;
  claimsToAvoid: string[];
  version: number;
  demoMode: boolean;
}

type StoredProfile = Omit<WorkspaceProfile, 'demoMode'> & { demo_mode: number };
const EMPTY: WorkspaceProfile = {
  businessName: '', website: '', industry: '', description: '', services: [], idealCustomer: '',
  targetIndustries: [], targetRoles: [], painPoints: [], differentiators: [], offer: '', cta: '',
  tone: 'helpful, concise, and professional', geography: '', claimsToAvoid: [], version: 1, demoMode: false,
};

function list(value: unknown, limit = 8, itemLimit = 180): string[] {
  const source = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\n|,/) : [];
  return [...new Set(source.map((item) => normalizeText(item, itemLimit)).filter(Boolean))].slice(0, limit);
}
function parseList(value: string): string[] { try { return list(JSON.parse(value)); } catch { return []; } }
function toProfile(row?: Record<string, unknown> | null): WorkspaceProfile {
  if (!row) return { ...EMPTY };
  return {
    businessName: String(row.business_name ?? ''), website: String(row.website ?? ''), industry: String(row.industry ?? ''),
    description: String(row.description ?? ''), services: parseList(String(row.services ?? '[]')),
    idealCustomer: String(row.ideal_customer ?? ''), targetIndustries: parseList(String(row.target_industries ?? '[]')),
    targetRoles: parseList(String(row.target_roles ?? '[]')), painPoints: parseList(String(row.pain_points ?? '[]')),
    differentiators: parseList(String(row.differentiators ?? '[]')), offer: String(row.offer ?? ''), cta: String(row.cta ?? ''),
    tone: String(row.tone ?? EMPTY.tone), geography: String(row.geography ?? ''),
    claimsToAvoid: parseList(String(row.claims_to_avoid ?? '[]')), version: Number(row.version ?? 1), demoMode: Number(row.demo_mode ?? 0) === 1,
  };
}

export function profileIssues(profile: WorkspaceProfile): string[] {
  const missing: Array<[string, boolean]> = [
    ['business name', !!profile.businessName], ['industry', !!profile.industry], ['business description', profile.description.length >= 20],
    ['at least one service', profile.services.length > 0], ['ideal customer', profile.idealCustomer.length >= 10],
    ['offer', profile.offer.length >= 3], ['CTA', profile.cta.includes('?')],
  ];
  return missing.filter(([, valid]) => !valid).map(([label]) => label);
}
export function assertProfileReady(profile: WorkspaceProfile, action: string): void {
  const missing = profileIssues(profile);
  if (missing.length) throw new HttpError(409, `Complete your Business profile before you can ${action}: ${missing.join(', ')}.`);
}
export async function getWorkspaceProfile(env: Env): Promise<WorkspaceProfile> {
  const row = await env.DB.prepare('SELECT * FROM workspace_profile WHERE id = ?1').bind('default').first<Record<string, unknown>>();
  return toProfile(row);
}
function cleaned(body: Record<string, unknown>, current: WorkspaceProfile): WorkspaceProfile {
  const text = (key: string, fallback: string, max: number) => body[key] === undefined ? fallback : normalizeText(body[key], max);
  const next: WorkspaceProfile = {
    businessName: text('businessName', current.businessName, 120), website: text('website', current.website, 240), industry: text('industry', current.industry, 120),
    description: text('description', current.description, 1200), services: body.services === undefined ? current.services : list(body.services),
    idealCustomer: text('idealCustomer', current.idealCustomer, 700), targetIndustries: body.targetIndustries === undefined ? current.targetIndustries : list(body.targetIndustries),
    targetRoles: body.targetRoles === undefined ? current.targetRoles : list(body.targetRoles), painPoints: body.painPoints === undefined ? current.painPoints : list(body.painPoints),
    differentiators: body.differentiators === undefined ? current.differentiators : list(body.differentiators), offer: text('offer', current.offer, 260),
    cta: text('cta', current.cta, 260), tone: text('tone', current.tone, 240) || EMPTY.tone, geography: text('geography', current.geography, 160),
    claimsToAvoid: body.claimsToAvoid === undefined ? current.claimsToAvoid : list(body.claimsToAvoid), version: current.version + 1,
    demoMode: body.demoMode === undefined ? current.demoMode : body.demoMode === true,
  };
  if (next.website && !/^https?:\/\//i.test(next.website)) throw new HttpError(400, 'website must start with http:// or https://');
  if (next.cta && (next.cta.match(/\?/g) ?? []).length !== 1) throw new HttpError(400, 'CTA must contain exactly one question');
  return next;
}
export async function updateWorkspaceProfile(body: Record<string, unknown>, env: Env): Promise<WorkspaceProfile> {
  const next = cleaned(body, await getWorkspaceProfile(env));
  await env.DB.prepare(`INSERT INTO workspace_profile (id,business_name,website,industry,description,services,ideal_customer,target_industries,target_roles,pain_points,differentiators,offer,cta,tone,geography,claims_to_avoid,version,demo_mode,updated_at)
    VALUES ('default',?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,datetime('now'))
    ON CONFLICT(id) DO UPDATE SET business_name=excluded.business_name,website=excluded.website,industry=excluded.industry,description=excluded.description,services=excluded.services,ideal_customer=excluded.ideal_customer,target_industries=excluded.target_industries,target_roles=excluded.target_roles,pain_points=excluded.pain_points,differentiators=excluded.differentiators,offer=excluded.offer,cta=excluded.cta,tone=excluded.tone,geography=excluded.geography,claims_to_avoid=excluded.claims_to_avoid,version=excluded.version,demo_mode=excluded.demo_mode,updated_at=datetime('now')`)
    .bind(next.businessName,next.website,next.industry,next.description,JSON.stringify(next.services),next.idealCustomer,JSON.stringify(next.targetIndustries),JSON.stringify(next.targetRoles),JSON.stringify(next.painPoints),JSON.stringify(next.differentiators),next.offer,next.cta,next.tone,next.geography,JSON.stringify(next.claimsToAvoid),next.version,Number(next.demoMode)).run();
  return next;
}
export async function handleWorkspaceProfileGet(env: Env): Promise<Response> { const profile = await getWorkspaceProfile(env); return jsonResponse({ ok: true, profile, issues: profileIssues(profile) }); }
export async function handleWorkspaceProfilePut(body: Record<string, unknown>, env: Env): Promise<Response> {
  if (body.demoMode !== undefined) throw new HttpError(400, 'Demo mode is managed through the demo controls.');
  const current = await getWorkspaceProfile(env);
  if (current.demoMode) throw new HttpError(409, 'Leave demo mode before changing the business profile. Only demo-tagged records will be removed.');
  const profile = await updateWorkspaceProfile(body, env);
  return jsonResponse({ ok: true, profile, issues: profileIssues(profile) });
}
export async function handleOnboardingGet(env: Env): Promise<Response> {
  const profile = await getWorkspaceProfile(env);
  const issues = profileIssues(profile);
  const settings = await getOutreachSettings(env.DB);
  const senderEmail = effectiveSenderEmail(settings, env);
  const deployedSender = senderEmail.toLowerCase() === (env.FROM_EMAIL ?? '').trim().toLowerCase() && isValidEmail(senderEmail);
  const verifiedProfile = isValidEmail(senderEmail) ? await env.DB.prepare(
    'SELECT 1 AS present FROM sender_profiles WHERE sender_email=?1 AND is_verified=1 AND is_active=1 LIMIT 1'
  ).bind(senderEmail).first<{ present: number }>() : null;
  const senderConfigured = deployedSender || !!verifiedProfile;
  return jsonResponse({ ok: true, complete: profile.demoMode || (issues.length === 0 && senderConfigured), issues, senderConfigured, demoMode: profile.demoMode, profile });
}

const DEMO_LEADS = [
  ['mira@northstar.example', 'Mira', 'Okafor', 'Founder', 'Northstar Product Studio', 'Creative services'],
  ['dan@kinetic.example', 'Daniel', 'Cole', 'Product Lead', 'Kinetic Labs', 'Software'],
  ['ada@harbor.example', 'Ada', 'Nwosu', 'Marketing Director', 'Harbor Works', 'Professional services'],
] as const;
export async function seedDemo(env: Env): Promise<Response> {
  const currentProfile = await getWorkspaceProfile(env);
  const existing = await env.DB.prepare('SELECT COUNT(*) AS n FROM leads WHERE is_demo = 0').first<{ n: number }>();
  if ((existing?.n ?? 0) > 0) throw new HttpError(409, 'Demo mode is only available before adding real leads.');
  if (!currentProfile.demoMode && (currentProfile.businessName || currentProfile.description || currentProfile.services.length)) {
    throw new HttpError(409, 'A business profile is already configured. Clear it explicitly before loading the fictional demo.');
  }
  await updateWorkspaceProfile({ businessName: 'Northstar Studio', website: 'https://northstar.example', industry: 'Software and visual design', description: 'A fictional independent studio that helps small teams turn product ideas into clear, useful software and visual identities.', services: ['Product development', 'UX design', 'Visual identity'], idealCustomer: 'Founders and small product teams preparing a new product or a focused redesign.', targetIndustries: ['Software', 'Professional services', 'Creative services'], targetRoles: ['Founder', 'Product lead', 'Marketing director'], painPoints: ['A product idea needs a focused first version', 'A brand needs clearer visual direction'], differentiators: ['One studio for product and visual craft', 'Practical, collaborative delivery'], offer: 'a short product and visual direction note', cta: 'Would it be useful if I sent over a short direction note?', tone: 'warm, direct, and practical', geography: 'Remote', claimsToAvoid: ['guaranteed growth', 'we reviewed your product'], demoMode: true }, env);
  for (const [email, first, last, role, company, industry] of DEMO_LEADS) {
    await env.DB.prepare(`INSERT OR IGNORE INTO leads (id,email,domain,first_name,last_name,role,company,industry,source,status,is_demo) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'manual','new',1)`)
      .bind(crypto.randomUUID(),email,email.split('@')[1],first,last,role,company,industry).run();
  }
  return handleOnboardingGet(env);
}

async function removeDemoRecords(env: Env): Promise<void> {
  const demoLeadIds = '(SELECT id FROM leads WHERE is_demo = 1)';
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM sequence_events WHERE lead_id IN ${demoLeadIds}`),
    env.DB.prepare(`DELETE FROM campaign_leads WHERE lead_id IN ${demoLeadIds}`),
    env.DB.prepare(`DELETE FROM lead_events WHERE lead_id IN ${demoLeadIds}`),
    env.DB.prepare(`DELETE FROM discovery_sources WHERE lead_id IN ${demoLeadIds}`),
    env.DB.prepare(`DELETE FROM discovery_candidates WHERE lead_id IN ${demoLeadIds}`),
    env.DB.prepare(`DELETE FROM reply_ingest_logs WHERE lead_id IN ${demoLeadIds}`),
    env.DB.prepare(`DELETE FROM messages WHERE lead_id IN ${demoLeadIds}`),
    env.DB.prepare('DELETE FROM leads WHERE is_demo = 1'),
  ]);
}

export async function clearDemo(env: Env): Promise<Response> {
  const current = await getWorkspaceProfile(env);
  if (!current.demoMode) throw new HttpError(409, 'Demo mode is not active. Your business profile was left unchanged.');
  await removeDemoRecords(env);
  const profile = await updateWorkspaceProfile({
    businessName: '', website: '', industry: '', description: '', services: [], idealCustomer: '',
    targetIndustries: [], targetRoles: [], painPoints: [], differentiators: [], offer: '', cta: '',
    tone: EMPTY.tone, geography: '', claimsToAvoid: [], demoMode: false,
  }, env);
  return jsonResponse({ ok: true, profile, message: 'Demo data cleared. Complete your business profile to begin.' });
}
