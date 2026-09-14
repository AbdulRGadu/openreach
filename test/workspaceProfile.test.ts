import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { HttpError } from '../src/http.ts';
import { createDraftProfileSnapshot, readDraftCampaignBrief, readDraftMessagingSnapshot, readDraftWorkspaceSnapshot } from '../src/services/draftSnapshot.ts';
import { DEFAULT_OUTREACH_SETTINGS } from '../src/services/outreachSettings.ts';
import { assertProfileReady, profileIssues, type WorkspaceProfile } from '../src/services/workspaceProfile.ts';
import type { CampaignRow, LeadRow } from '../src/types.ts';

const profile: WorkspaceProfile = {
  businessName: 'Mosaic Studio', website: 'https://mosaic.example', industry: 'Software and visual design',
  description: 'An independent practice creating useful software and visual identities for small teams.',
  services: ['Product development', 'Visual identity'],
  idealCustomer: 'Small teams launching a product or refreshing their brand.',
  targetIndustries: ['Software', 'Creative services'], targetRoles: ['Founder', 'Product lead'],
  painPoints: ['A project needs a clear first step'], differentiators: ['Product and visual craft in one practice'],
  offer: 'a short design sample', cta: 'Would it be useful if I shared a short design sample?',
  tone: 'warm, practical, and concise', geography: 'Remote', claimsToAvoid: ['guaranteed results'],
  version: 2, demoMode: false,
};

const lead = {
  id: 'lead-1', first_name: 'Sam', company: 'Example Studio', industry: 'Creative agency',
  role: 'Founder', country: 'Remote',
} as unknown as LeadRow;

test('complete business profile passes setup validation; missing core facts are actionable', () => {
  assert.deepEqual(profileIssues(profile), []);
  const incomplete = { ...profile, businessName: '', industry: '', description: '', services: [], idealCustomer: '', offer: '', cta: '' };
  assert.deepEqual(profileIssues(incomplete), ['business name', 'industry', 'business description', 'at least one service', 'ideal customer', 'offer', 'CTA']);
  assert.throws(() => assertProfileReady(incomplete, 'generate drafts'), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.match(error.message, /Complete your Business profile/);
    assert.match(error.message, /business name/);
    return true;
  });
});

test('every new message can snapshot its full business, messaging, and campaign context', () => {
  const campaign = {
    id: 'campaign-1', name: 'Studio introduction', objective: 'Introduce visual design services',
    tone: 'friendly and direct', offer: 'a sample homepage concept',
    cta: 'Would you like me to share a homepage concept?', sector_angle: 'Reference the supplied role only',
    initial_template: 'Hi {{first_name}},', follow_up_template: 'Following up once.',
  } as unknown as CampaignRow;
  const raw = createDraftProfileSnapshot(profile, { ...DEFAULT_OUTREACH_SETTINGS, senderName: 'Alex Example' }, campaign, lead);
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  assert.deepEqual(readDraftWorkspaceSnapshot(raw), profile);
  assert.equal(readDraftMessagingSnapshot(raw)?.senderName, 'Alex Example');
  assert.deepEqual(readDraftCampaignBrief(raw), {
    objective: 'Introduce visual design services', audience: 'Founder · Creative agency · Remote',
    tone: 'friendly and direct', offer: 'a sample homepage concept',
    cta: 'Would you like me to share a homepage concept?', personalizationNote: 'Reference the supplied role only',
  });
  assert.equal((parsed.campaignBrief as Record<string, unknown>).initialTemplate, 'Hi {{first_name}},');
  assert.equal(((parsed.campaignBrief as Record<string, unknown>).selectedAudience as Record<string, unknown>).leadId, 'lead-1');
});

test('profile routes are authenticated and demo mode cannot be toggled through profile editing', () => {
  const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const profileSource = readFileSync(new URL('../src/services/workspaceProfile.ts', import.meta.url), 'utf8');
  const settings = readFileSync(new URL('../src/services/outreachSettings.ts', import.meta.url), 'utf8');
  assert.match(index, /resource === 'workspace-profile'/);
  assert.match(index, /resource === 'onboarding'/);
  assert.match(index, /resource === 'demo'/);
  assert.match(index, /workspace\.businessName\);/);
  assert.match(settings, /effectiveSenderDisplayName\(settings, env, defaultName\)/);
  assert.match(profileSource, /body\.demoMode !== undefined/);
});

test('demo mode blocks approval and delivery, and leaving demo deletes only demo-tagged leads', () => {
  const messages = readFileSync(new URL('../src/messages.ts', import.meta.url), 'utf8');
  const sending = readFileSync(new URL('../src/sending.ts', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../src/services/workspaceProfile.ts', import.meta.url), 'utf8');
  assert.match(messages, /workspace\.demoMode\) throw new HttpError\(409, 'Demo mode cannot approve, queue, or send email/);
  assert.match(sending, /if \(workspace\.demoMode\) return \{ action: 'ack', reason: 'demo mode blocks delivery' \}/);
  assert.match(source, /DELETE FROM leads WHERE is_demo = 1/);
  assert.match(source, /DELETE FROM messages WHERE lead_id IN \$\{demoLeadIds\}/);
  assert.match(source, /if \(!current\.demoMode\) throw new HttpError/);
});

test('additive migration parks legacy unsent drafts without rewriting sent mail', () => {
  const migration = readFileSync(new URL('../migrations/0011_workspace_profile.sql', import.meta.url), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS workspace_profile/);
  assert.match(migration, /ALTER TABLE leads ADD COLUMN is_demo/);
  assert.match(migration, /ALTER TABLE messages ADD COLUMN profile_snapshot/);
  assert.match(migration, /ALTER TABLE messages ADD COLUMN relevance_context/);
  assert.match(migration, /draft_quality_status = 'needs_review'/);
  assert.match(migration, /profile_snapshot IS NULL/);
  assert.match(migration, /status IN \('draft','needs_review','approved','queued','failed'\)/);
  assert.doesNotMatch(migration, /status IN \([^)]*'sent'/);
});
