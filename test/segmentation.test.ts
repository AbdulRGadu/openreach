import assert from 'node:assert/strict';
import test from 'node:test';
import { segmentLead, leadShowsWarmIntent } from '../src/services/leadSegmentation.ts';
import { buildPersonalizationPlan } from '../src/services/personalization.ts';
import { DEFAULT_OUTREACH_SETTINGS } from '../src/services/outreachSettings.ts';
import type { WorkspaceProfile } from '../src/services/workspaceProfile.ts';
import type { CampaignRow, LeadRow } from '../src/types.ts';

const profile: WorkspaceProfile = {
  businessName: 'Mosaic Studio', website: '', industry: 'Software and visual design',
  description: 'An independent practice creating useful software and visual identities for small teams.',
  services: ['Product development', 'Visual identity'],
  idealCustomer: 'Small teams launching a digital product or refreshing their brand.',
  targetIndustries: ['Software', 'Creative services'], targetRoles: ['Founder', 'Product lead'],
  painPoints: ['A project needs a clear first step'], differentiators: ['Product and visual craft in one practice'],
  offer: 'a short design sample', cta: 'Would it be useful if I shared a short design sample?',
  tone: 'warm, practical, and concise', geography: 'Remote', claimsToAvoid: ['guaranteed results'],
  version: 1, demoMode: false,
};

function lead(values: Partial<LeadRow> = {}): LeadRow {
  return {
    id: 'lead-1', email: 'sam@example.test', domain: 'example.test', first_name: 'Sam', last_name: null,
    role: 'Freelance Developer and Artist', company: 'Independent', company_website: null,
    industry: 'Creative agency', sub_industry: null, segment: null, fit_score: null, fit_reason: null,
    pain_points: null, source: 'manual', status: 'new', last_reply_classification: null, notes: null,
    country: null, company_size: null, contact_profile_url: null, source_url: null, structured_notes: null,
    discovery_score: null, data_confidence: null, last_verified_at: null, sales_stage: 'prospecting',
    next_action: null, delivery_test: 0, created_at: '', updated_at: '', ...values,
  };
}

test('segmentation provides neutral industry and role context, not a fixed offer', () => {
  const result = segmentLead({ industry: 'Software as a service', contactRole: 'Software Engineer' });
  assert.equal(result.segment, 'saas');
  assert.equal(result.buyer_persona, 'technical');
  assert.equal(result.recommended_offer, 'a short overview of relevant services');
  assert.equal(result.recommended_cta, 'Would a short overview be useful?');
  assert.doesNotMatch(JSON.stringify(result), /security|checklist|walkthrough/i);
});

test('a developer and artist gets outreach tailored to the configured studio profile', () => {
  const row = lead();
  const plan = buildPersonalizationPlan(row, DEFAULT_OUTREACH_SETTINGS, profile);
  assert.equal(plan.strategy.segment, 'professional_services');
  assert.equal(plan.strategy.buyer_persona, 'technical');
  assert.equal(plan.strategy.recommended_offer, 'a short design sample');
  assert.equal(plan.strategy.recommended_cta, 'Would it be useful if I shared a short design sample?');
  assert.match(plan.strategy.likely_relevance_context, /Creative agency/);
  assert.match(plan.outreach_angle, /Product development and Visual identity/);
  assert.doesNotMatch(JSON.stringify(plan), /security|checklist|walkthrough/i);
});

test('campaign details refine the offer, CTA, tone, and note without replacing business identity', () => {
  const campaign = {
    id: 'campaign-1', objective: 'Introduce the design service', tone: 'friendly and direct',
    offer: 'a sample homepage concept', cta: 'Would you like me to share a homepage concept?',
    sector_angle: 'Use the role supplied with the lead',
  } as unknown as CampaignRow;
  const plan = buildPersonalizationPlan(lead(), DEFAULT_OUTREACH_SETTINGS, profile, campaign);
  assert.equal(plan.workspace.businessName, 'Mosaic Studio');
  assert.equal(plan.workspace.tone, 'friendly and direct');
  assert.equal(plan.strategy.recommended_offer, 'a sample homepage concept');
  assert.equal(plan.strategy.recommended_cta, 'Would you like me to share a homepage concept?');
  assert.equal(plan.campaignBrief?.objective, 'Introduce the design service');
});

test('warm intent is based only on supplied referral or explicit notes', () => {
  assert.equal(leadShowsWarmIntent({ source: 'referral' }), true);
  assert.equal(leadShowsWarmIntent({ notes: 'They asked for a proposal' }), true);
  assert.equal(leadShowsWarmIntent({ source: 'manual', notes: 'Product developer and visual artist' }), false);
});

test('unknown industries remain neutral and do not invent a fit', () => {
  const result = segmentLead({ companyName: 'Northpoint Limited' });
  assert.equal(result.segment, 'general_business');
  assert.equal(result.buyer_persona, 'unknown');
  assert.match(result.likely_relevance_context, /No reliable industry context/);
  assert.ok(result.do_not_say.includes('assume a need or intent that was not supplied'));
});
