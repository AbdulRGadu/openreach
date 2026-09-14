import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { z } from 'zod';
import { runJson } from '../src/ai/client.ts';
import type { Env } from '../src/env.ts';
import { formatD1ExecScript } from '../src/util/sql.ts';
import { extractEmailAddresses } from '../src/util/emailExtraction.ts';
import { parseLeadTable } from '../src/util/leadImport.ts';
import { validateDraftQuality } from '../src/services/draftQuality.ts';
import { buildSafeFallbackDraft, improveDraftUntilSendable } from '../src/services/draftAutomation.ts';
import { deliveryTestEnabled, priorOutboundBlocksDelivery } from '../src/services/deliveryTest.ts';
import { renderDraftEmail } from '../src/services/emailRenderer.ts';
import { buildPersonalizationPlan } from '../src/services/personalization.ts';
import type { LeadRow } from '../src/types.ts';
import { DEFAULT_OUTREACH_SETTINGS } from '../src/services/outreachSettings.ts';
import { isAuthorized } from '../src/auth.ts';
import type { WorkspaceProfile } from '../src/services/workspaceProfile.ts';

function lead(values: Partial<LeadRow> = {}): LeadRow {
  return {
    id: 'lead-1', email: 'ada@harbor.example', domain: 'harbor.example', first_name: 'Ada',
    last_name: null, role: 'Product Lead', company: 'Harbor Works', company_website: 'https://harbor.example',
    industry: 'Professional services', sub_industry: 'Creative services', segment: null, fit_score: 82,
    fit_reason: null, pain_points: null, source: 'manual', status: 'scored',
    last_reply_classification: null, notes: null, country: 'Nigeria', company_size: null,
    contact_profile_url: null, source_url: null, structured_notes: null, discovery_score: null,
    data_confidence: null, last_verified_at: null, sales_stage: 'prospecting', next_action: null,
    delivery_test: 0,
    created_at: '', updated_at: '',
    ...values,
  };
}

const WORKSPACE: WorkspaceProfile = {
  businessName: 'Northstar Studio', website: 'https://northstar.example', industry: 'Software and visual design',
  description: 'An independent studio helping small teams build useful software and clear visual identities.',
  services: ['Product development', 'UX design', 'Visual identity'],
  idealCustomer: 'Founders and small product teams preparing a new product or focused redesign.',
  targetIndustries: ['Software', 'Professional services'], targetRoles: ['Founder', 'Product lead'],
  painPoints: ['A first release needs focus', 'A brand needs clearer direction'],
  differentiators: ['Product and visual craft in one small studio'],
  offer: 'a short product and visual direction note',
  cta: 'Would it be useful if I sent over a short direction note?',
  tone: 'warm, direct, and practical', geography: 'Remote', claimsToAvoid: ['guaranteed growth'], version: 1, demoMode: false,
};
const validBody = buildSafeFallbackDraft(lead(), buildPersonalizationPlan(lead(), DEFAULT_OUTREACH_SETTINGS, WORKSPACE)).body;

test('a profile-aware product and design draft passes the conversion quality gate', () => {
  const row = lead();
  const strategy = buildPersonalizationPlan(row, DEFAULT_OUTREACH_SETTINGS, WORKSPACE).strategy;
  const quality = validateDraftQuality('A practical direction note', validBody, row, strategy, validBody, DEFAULT_OUTREACH_SETTINGS, 'strict', WORKSPACE);
  assert.equal(quality.valid, true, quality.warnings.join('\n'));
  assert.ok(quality.word_count >= 70 && quality.word_count <= 160);
  assert.equal(quality.question_count, 1);
  assert.equal(quality.checks.length, 5);
  assert.ok(quality.checks.every((check) => check.passed));
});

test('safe automated fallback is sendable across every supported segment', () => {
  const cases = [
    ['Creative services', 'Product Lead'],
    ['Healthcare clinic', 'CEO'],
    ['Education school', 'Administrator'],
    ['Logistics delivery', 'Operations Manager'],
    ['Software platform', 'Founder'],
    ['Ecommerce marketplace', 'Marketing Director'],
    ['Professional services consulting', 'Managing Director'],
    ['Manufacturing', 'Office Manager'],
  ] as const;
  for (const [industry, role] of cases) {
    const row = lead({ industry, sub_industry: null, role });
    const plan = buildPersonalizationPlan(row, DEFAULT_OUTREACH_SETTINGS, WORKSPACE);
    const draft = buildSafeFallbackDraft(row, plan);
    const quality = validateDraftQuality(draft.subject, draft.body, row, plan.strategy, draft.body, plan.messaging, 'strict', WORKSPACE);
    assert.equal(quality.valid, true, `${plan.strategy.segment}: ${quality.warnings.join(' ')}`);
    assert.equal(quality.question_count, 1);
  }
});

test('weak AI copy is repaired against its failed checklist', async () => {
  const row = lead();
  const plan = buildPersonalizationPlan(row, DEFAULT_OUTREACH_SETTINGS, WORKSPACE);
  const result = await improveDraftUntilSendable({
    lead: row,
    plan,
    initialDraft: { subject: 'Too short', body: 'Hi Ada,\n\nWe help companies make progress.' },
    repair: async ({ warnings, attempt }) => {
      assert.equal(attempt, 1);
      assert.ok(warnings.length > 0);
      return { subject: 'A practical direction note', body: validBody };
    },
  });
  assert.equal(result.quality.valid, true);
  assert.equal(result.auto_repaired, true);
  assert.equal(result.repair_attempts, 1);
  assert.equal(result.used_fallback, false);
});

test('persistent AI failures use a validated fallback after two bounded attempts', async () => {
  const row = lead({ industry: 'Business services', sub_industry: null, role: 'Office Manager' });
  const plan = buildPersonalizationPlan(row);
  const result = await improveDraftUntilSendable({
    lead: row,
    plan,
    initialDraft: { subject: '', body: '' },
    repair: async () => { throw new Error('model unavailable'); },
  });
  assert.equal(result.quality.valid, true, result.quality.warnings.join(' '));
  assert.equal(result.repair_attempts, 2);
  assert.equal(result.repair_failures, 2);
  assert.equal(result.used_fallback, true);
});

test('confirmed delivery tests bypass only prior sent history', () => {
  const row = lead({ delivery_test: 1 });
  assert.equal(deliveryTestEnabled(row), true);
  assert.equal(priorOutboundBlocksDelivery(true, 'sent'), false);
  assert.equal(priorOutboundBlocksDelivery(true, 'sending'), true);
  assert.equal(priorOutboundBlocksDelivery(true, 'send_unknown'), true);
  assert.equal(priorOutboundBlocksDelivery(false, 'sent'), true);
});

test('dashboard accepts only its configured PIN without exposing API-key wording', async () => {
  const env = { API_KEY: 'test-placeholder', DASHBOARD_PIN: '654321' } as Env;
  const pinRequest = new Request('https://example.test/api/stats', {
    headers: { Authorization: 'Bearer 654321' },
  });
  const apiKeyRequest = new Request('https://example.test/api/stats', {
    headers: { Authorization: `Bearer ${env.API_KEY}` },
  });
  assert.equal(await isAuthorized(pinRequest, env), true);
  assert.equal(await isAuthorized(apiKeyRequest, env), true);
  assert.equal(await isAuthorized(new Request('https://example.test/api/stats', { headers: { Authorization: 'Bearer 111111' } }), { API_KEY: 'machine-only-key' } as Env), false);
  const dashboard = readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
  assert.match(dashboard, /6-digit PIN/);
  assert.doesNotMatch(dashboard, /Enter the API key|placeholder="API key"/i);
});

test('public landing page is informational and does not collect credentials', () => {
  const landing = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(landing, /Outreach Studio/);
  assert.match(landing, /Open your workspace/);
  assert.doesNotMatch(landing, /input|password|API key|PIN/i);
});

test('bulk lead text extraction keeps only unique email addresses', () => {
  const text = 'Abdul, abdul@example.com; Notes: Onome <ONOME@example.com>, invalid@, and abdul@example.com. Kelvin kelvin+test@sub.example.co.uk.';
  assert.deepEqual(extractEmailAddresses(text), [
    'abdul@example.com',
    'onome@example.com',
    'kelvin+test@sub.example.co.uk',
  ]);
});

test('structured TSV lead import preserves prospect fields and maps fit notes', () => {
  const table = [
    'first_name\tlast_name\tcompany\tcompany_domain\tposition\temail\tphone\tlocation\tlinkedin\tfit_note',
    'Mojisola\tOloge\tHydrogen\thydrogenpay.com\tChief Risk Officer\tologemo@hydrogenpay.com\t+234 802\tNigeria\t[LinkedIn](https://linkedin.com/in/mojisola)\tSenior risk leader at a Nigerian fintech',
  ].join('\n');
  assert.deepEqual(parseLeadTable(table), [{
    email: 'ologemo@hydrogenpay.com', firstName: 'Mojisola', lastName: 'Ologe', company: 'Hydrogen',
    companyWebsite: 'https://hydrogenpay.com', role: 'Chief Risk Officer', country: 'Nigeria',
    contactProfileUrl: 'https://linkedin.com/in/mojisola', notes: 'Phone: +234 802\nSenior risk leader at a Nigerian fintech',
  }]);
});

test('renderer fixes greeting and signoff without rewriting the message', () => {
  const rendered = renderDraftEmail(
    validBody.replace('Hi Mr. Ada,', 'Dear Ada,').replace('Best regards,', 'Regards,'),
    lead()
  );
  assert.match(rendered, /^Hi Ada,\n\n/);
  assert.match(rendered, /\n\nBest regards,$/);
  assert.equal((rendered.match(/^Northstar Studio$/gm) ?? []).length, 0);
});

test('quality gate rejects thin copy, multiple CTAs, and unsupported prospect claims', () => {
  const row = lead({ industry: 'Business services', sub_industry: null, role: 'Office Manager' });
  const strategy = buildPersonalizationPlan(row, DEFAULT_OUTREACH_SETTINGS, WORKSPACE).strategy;
  const body = `Hi Ada,

I'm reaching out from Northstar Studio.

We found a problem with your company. Act now and we can help.

I can share ${WORKSPACE.offer}.

Would you like the direction note? Should I send more details?

Best regards,`;
  const quality = validateDraftQuality('A practical direction note', body, row, strategy, body, DEFAULT_OUTREACH_SETTINGS, 'strict', WORKSPACE);
  assert.equal(quality.valid, false);
  assert.match(quality.warnings.join(' '), /shorter than 70 words/);
  assert.match(quality.warnings.join(' '), /exactly one CTA/);
  assert.match(quality.warnings.join(' '), /unsupported claim/);
  assert.match(quality.warnings.join(' '), /hype or fake urgency/);
});

test('quality gate detects forbidden raw footer content even after normalization removes it', () => {
  const row = lead();
  const strategy = buildPersonalizationPlan(row, DEFAULT_OUTREACH_SETTINGS, WORKSPACE).strategy;
  const raw = `${validBody}\n\n—\n\nNorthstar Studio | product and visual design\nOpt out: https://example.test/unsubscribe`;
  const rendered = renderDraftEmail(raw, row);
  assert.equal(rendered.includes('Opt out'), false);
  const quality = validateDraftQuality('A practical direction note', rendered, row, strategy, raw, DEFAULT_OUTREACH_SETTINGS, 'strict', WORKSPACE);
  assert.equal(quality.valid, false);
  assert.match(quality.warnings.join(' '), /unsubscribe text/);
  assert.match(quality.warnings.join(' '), /standalone separator/);
});

test('draft prompt source carries structured strategy and strict repair requirements', () => {
  const plan = buildPersonalizationPlan(lead({ role: 'Software Developer' }), DEFAULT_OUTREACH_SETTINGS, WORKSPACE);
  assert.equal(plan.prospect.segment, 'professional_services');
  assert.equal(plan.strategy.buyer_persona, 'technical');
  const promptSource = readFileSync(new URL('../src/ai/prompts.ts', import.meta.url), 'utf8');
  assert.match(promptSource, /The workspace profile is the business identity/);
  assert.match(promptSource, /4 to 7 readable paragraphs, 70 to 160 words/);
  assert.match(promptSource, /Never add a footer/);
  assert.match(promptSource, /Fix these checks/);
  assert.match(promptSource, /Use exactly this single CTA/);
  assert.match(promptSource, /v5-workspace-profile/);
  assert.match(promptSource, /Repair pass/);
});

test('dashboard reopens automatically repaired drafts with a sendability checklist', () => {
  const dashboard = readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
  assert.match(dashboard, /if \(result\.repaired\)/);
  assert.match(dashboard, /Sendability checklist/);
  assert.match(dashboard, /Review the updated copy, then approve again/);
});

test('Gemini is the default and model calls stay on the named AI Gateway', () => {
  const config = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const client = readFileSync(new URL('../src/ai/client.ts', import.meta.url), 'utf8');
  assert.match(config, /"DEFAULT_AI_MODEL": "google\/gemini-3\.5-flash"/);
  assert.match(config, /"AI_GATEWAY_ID": "outreach-studio"/);
  assert.match(client, /ai\/v1\/chat\/completions/);
  assert.match(client, /cf-aig-gateway-id/);
  assert.match(client, /max_completion_tokens: completionBudget/);
  assert.match(client, /envelope\.result\?\.choices/);
  assert.doesNotMatch(client, /callModel\(env, model, messages, jsonSchema, maxTokens, false\)/);
});

test('Gemini calls unwrap the Cloudflare result envelope and reserve reasoning headroom', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | null = null;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      state: 'Completed',
      result: {
        choices: [{ message: { content: '{"value":"complete"}' }, finish_reason: 'stop' }],
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const result = await runJson(
      {
        CF_ACCOUNT_ID: 'account',
        CF_AI_TOKEN: 'token',
        AI_GATEWAY_ID: 'outreach',
      } as Env,
      'google/gemini-3.5-flash',
      [{ role: 'user', content: 'Return JSON.' }],
      { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
      z.object({ value: z.string() }),
      { maxTokens: 900 }
    );
    assert.deepEqual(result, { value: 'complete' });
    assert.equal(requestBody?.max_completion_tokens, 4096);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('runtime schema convergence covers imported lead and reply fields', () => {
  const schema = readFileSync(new URL('../src/schema.ts', import.meta.url), 'utf8');
  const migration = readFileSync(
    new URL('../migrations/0007_production_schema_convergence.sql', import.meta.url),
    'utf8'
  );
  assert.match(schema, /country: 'country TEXT'/);
  assert.match(schema, /delivery_test: 'delivery_test INTEGER NOT NULL DEFAULT 0/);
  assert.match(schema, /reply_ingest_logs/);
  assert.match(migration, /'replied_positive'/);
  assert.match(migration, /'needs_review'/);
  assert.match(migration, /messages_v7_backup/);
  const executable = formatD1ExecScript(migration);
  assert.ok(executable.split('\n').every((statement) => statement.endsWith(';')));
  assert.doesNotMatch(executable, /--/);
  assert.doesNotMatch(executable, /CREATE TABLE leads_v7 \(\n/);
});

test('draft page supports filtered selection and paced bulk queueing', () => {
  const dashboard = readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
  assert.match(dashboard, /draft-filter-company/);
  assert.match(dashboard, /draft-filter-industry/);
  assert.match(dashboard, /draft-filter-segment/);
  assert.match(dashboard, /draft-send-amount/);
  assert.match(dashboard, /Approve &amp; queue selected/);
  assert.match(dashboard, /sendSelectedDrafts/);
  assert.match(dashboard, /intervalMinutes: 2/);
  assert.match(dashboard, /draft-queue-start/);
  assert.match(dashboard, /drafts-regenerate-all/);
  assert.match(dashboard, /draft-date-from/);
  assert.match(dashboard, /draft-view/);
  assert.match(dashboard, /allowDuplicates/);
});

test('custom email wording flows into the rendered draft and CTA strategy', () => {
  const settings = { ...DEFAULT_OUTREACH_SETTINGS, greeting: 'Goodday', fallbackGreeting: 'Goodday', signoff: 'Best regards', senderName: 'Alex Example' };
  const prospect = lead();
  const customWorkspace = { ...WORKSPACE, cta: 'Can I send a sample for your review?' };
  const plan = buildPersonalizationPlan(prospect, settings, customWorkspace);
  const draft = buildSafeFallbackDraft(prospect, plan);
  assert.match(draft.body, /^Goodday Ada,/);
  assert.match(draft.body, /Can I send a sample for your review\?/);
  assert.match(draft.body, /Best regards,\nAlex Example$/);
  assert.equal(validateDraftQuality(draft.subject, draft.body, prospect, plan.strategy, draft.body, settings, 'strict', customWorkspace).valid, true);
});

test('approving a green draft respects saved wording and does not re-block it after settings change', () => {
  const messages = readFileSync(new URL('../src/messages.ts', import.meta.url), 'utf8');
  assert.match(messages, /getOutreachSettings\(env\.DB\)/);
  assert.match(messages, /renderDraftEmail\(normalizeMultiline\(body\.body, 5000\), lead, settings/);
  assert.match(messages, /buildPersonalizationPlan\(lead, settings, workspace\)\.strategy/);
  assert.match(messages, /message\.draft_quality_status !== 'passed' \|\| !quality\.valid/);
  assert.match(messages, /if \(requiresAutomatedRepair\(message, quality\)\)/);
  assert.match(messages, /legacy draft must be regenerated under the current Business profile/);
});

test('outbound email keeps deployment sender settings optional and the prospect recipient unchanged', () => {
  const config = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const sender = readFileSync(new URL('../src/sending.ts', import.meta.url), 'utf8');
  const provider = readFileSync(new URL('../src/zoho.ts', import.meta.url), 'utf8');
  assert.match(config, /"FROM_EMAIL": ""/);
  assert.match(config, /"OUTREACH_CC_EMAIL": ""/);
  assert.match(sender, /: env\.OUTREACH_CC_EMAIL;/);
  assert.match(sender, /effectiveSenderEmail\(settings, env\)/);
  assert.match(provider, /ccAddress: args\.cc\.trim\(\)/);
  assert.match(provider, /fromAddress: args\.from\?\.trim\(\) \|\| env\.FROM_EMAIL/);
  assert.match(provider, /toAddress: args\.to/);
});

test('settings expose a configurable sender and render the HTML footer inside a sandboxed preview', () => {
  const settings = readFileSync(new URL('../src/services/outreachSettings.ts', import.meta.url), 'utf8');
  const dashboard = readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
  assert.match(settings, /senderEmail: string/);
  assert.match(settings, /senderEmail must be a valid email address/);
  assert.match(dashboard, /id="outreach-sender-email"/);
  assert.match(dashboard, /id="outreach-footer-preview"/);
  assert.match(dashboard, /sandbox=""/);
  assert.match(dashboard, /updateFooterPreview/);
});
