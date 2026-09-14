import assert from 'node:assert/strict';
import test from 'node:test';
import type { LeadRow } from '../src/types.ts';
import { validateDraftQuality } from '../src/services/draftQuality.ts';
import {
  buildFooter,
  detectReplyOptOut,
  ensureFooter,
  latestReplyText,
  normalizeEmailBody,
} from '../src/util/text.ts';

const lead = { company: 'Prospect Limited', notes: null, first_name: 'Ada' } as LeadRow;

test('normalizes a blob into readable plain-text paragraphs', () => {
  const result = normalizeEmailBody(
    'Hi Kelvin, I am reaching out from Mosaic Studio. We help small teams shape useful software and visual identities. Would a short design sample be useful? Best regards, Alex Example'
  );
  assert.match(result, /^Hi Kelvin,\n\n/);
  assert.match(result, /\n\nWould a short design sample be useful\?\n\nBest regards,\nAlex Example$/);
});

test('the default sender footer is empty and email content is HTML-escaped', () => {
  const result = ensureFooter('Hi Ada,\n\nWould <a sample> help?');
  assert.doesNotMatch(result, /<table|logo|CEO/i);
  assert.match(result, /Would &lt;a sample&gt; help\?/);
  assert.equal(buildFooter(), '');
});

test('a user-configured HTML footer is appended once', () => {
  const result = ensureFooter('Hi Ada,\n\nA useful note.', '<p>Alex Example · Mosaic Studio</p>');
  assert.match(result, /<p>Alex Example · Mosaic Studio<\/p>$/);
  assert.equal((result.match(/Alex Example · Mosaic Studio/g) ?? []).length, 1);
});

test('visible unsubscribe lines and standalone separators are removed from the body', () => {
  const result = ensureFooter(
    'Hi Ada,\n\nA short note.\n\n—\n\nOpt out here: https://example.com/unsubscribe?x=1'
  );
  assert.equal(result.includes('Opt out here'), false);
  assert.equal(result.includes('https://example.com/unsubscribe'), false);
  assert.doesNotMatch(normalizeEmailBody('Hi Ada,\n\n—\n--\n___\n***\nA useful note.'), /^(?:—|--|___|\*\*\*)$/m);
});

test('quality checks catch unsupported prospect claims, urgency, and multiple questions', () => {
  const quality = validateDraftQuality(
    'A very unusually long subject line that has more than ten words for this email',
    'Hi Ada,\n\nI am reaching out from the sender.\n\nWe found a problem with your company. Act now.\n\nCan we talk? Would you reply?\n\nBest regards,',
    lead
  );
  assert.equal(quality.valid, false);
  assert.match(quality.warnings.join(' '), /unsupported claim/);
  assert.match(quality.warnings.join(' '), /hype or fake urgency/);
  assert.match(quality.warnings.join(' '), /exactly one CTA/);
  assert.match(quality.warnings.join(' '), /longer than 10 words/);
});

test('reply opt-out detection is deterministic but avoids broad no matches', () => {
  assert.equal(detectReplyOptOut('No'), 'remove_me');
  assert.equal(detectReplyOptOut('No, thanks.'), 'remove_me');
  assert.equal(detectReplyOptOut('Please remove me from your list'), 'remove_me');
  assert.equal(detectReplyOptOut('Not interested, thanks'), 'not_interested');
  assert.equal(detectReplyOptOut('No problem, please send the sample'), null);
});

test('quoted message footer cannot create a false opt-out', () => {
  const reply = latestReplyText('Yes, please send the sample.\n\nOn Thu, 16 Jul 2026 at 10:00, Alex Example wrote:\n> If this is not relevant, reply “no”.');
  assert.equal(reply, 'Yes, please send the sample.');
  assert.equal(detectReplyOptOut(reply), null);
});

test('there is no static footer preview content', () => {
  assert.equal(buildFooter(), '');
});
