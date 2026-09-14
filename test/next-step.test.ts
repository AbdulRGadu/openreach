import assert from 'node:assert/strict';
import test from 'node:test';
import { nextActionFor, planInitialNextStep, planReply, suggestedReplyFor } from '../src/services/nextStepPlanner.ts';
import { DEFAULT_OUTREACH_SETTINGS } from '../src/services/outreachSettings.ts';
import type { WorkspaceProfile } from '../src/services/workspaceProfile.ts';
import type { LeadRow } from '../src/types.ts';

const lead = { first_name: 'Ada' } as unknown as LeadRow;
const workspace: WorkspaceProfile = {
  businessName: 'Mosaic Studio', website: '', industry: 'Software and visual design',
  description: 'An independent practice creating useful software and visual identities for small teams.',
  services: ['Product development', 'Visual identity'], idealCustomer: 'Small teams launching a product or refreshing their brand.',
  targetIndustries: ['Software'], targetRoles: ['Founder'], painPoints: ['A project needs a clear first step'],
  differentiators: ['Product and visual craft in one practice'], offer: 'a short design sample',
  cta: 'Would it be useful if I shared a short design sample?', tone: 'warm and practical', geography: 'Remote',
  claimsToAvoid: [], version: 1, demoMode: false,
};

test('positive interest shares the configured offer and leaves the reply for human review', () => {
  const plan = planReply({
    classification: 'positive_interest', confidence: 0.94,
    summary: 'Asked for a design sample.', lead, workspace,
  });
  assert.equal(plan.next_action, 'share_configured_offer');
  assert.equal(plan.sales_stage, 'engaged');
  assert.match(plan.suggested_reply, /^Hi Ada,/);
  assert.match(plan.suggested_reply, /I’ll send over a short design sample/);
  assert.match(plan.suggested_reply, /Best regards,$/);
  assert.doesNotMatch(plan.suggested_reply, /walkthrough|checklist/i);
});

test('the initial next step uses the workspace offer without assuming a meeting', () => {
  const plan = planInitialNextStep({
    segment: 'general_business', buyer_persona: 'founder', likely_relevance_context: '',
    recommended_offer: workspace.offer, recommended_cta: workspace.cta, do_not_say: [],
  });
  assert.match(plan.on_positive_reply, /short design sample/);
  assert.match(plan.on_positive_reply, /helpful next step/);
  assert.doesNotMatch(plan.on_positive_reply, /15-minute|walkthrough/i);
  assert.equal(plan.human_approval_required, true);
});

test('more-information suggestions use the configured offer and CTA', () => {
  const reply = suggestedReplyFor('asks_for_more_info', lead, '', DEFAULT_OUTREACH_SETTINGS, workspace);
  assert.equal((reply.match(/\?/g) ?? []).length, 1);
  assert.match(reply, /short design sample/);
  assert.match(reply, /Would it be useful if I shared a short design sample\?/);
});

test('negative and automated classes produce safe deterministic actions', () => {
  assert.equal(nextActionFor('not_now'), 'nurture_later');
  assert.equal(nextActionFor('not_interested'), 'do_not_contact');
  assert.equal(nextActionFor('remove_me'), 'suppress_immediately');
  assert.equal(nextActionFor('out_of_office'), 'no_action');
  assert.equal(nextActionFor('bounce_or_auto_reply'), 'update_email_status');
  assert.equal(nextActionFor('unclear'), 'manual_review');
});
