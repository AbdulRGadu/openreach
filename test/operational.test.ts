import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { effectiveSenderDisplayName } from '../src/services/outreachSettings.ts';

test('sender display name uses configured identity and has no company-specific fallback', () => {
  assert.equal(effectiveSenderDisplayName({ senderDisplayName: '' }, { FROM_NAME: '' }), 'Outreach Studio');
  assert.equal(effectiveSenderDisplayName({ senderDisplayName: '' }, { FROM_NAME: 'Configured Name' }), 'Configured Name');
  assert.equal(effectiveSenderDisplayName({ senderDisplayName: 'Sales Desk' }, { FROM_NAME: 'Configured Name' }), 'Sales Desk');
  assert.equal(effectiveSenderDisplayName({ senderDisplayName: '' }, { FROM_NAME: '' }, 'Northstar Studio'), 'Northstar Studio');
});

test('operational schema and dashboard expose actionable queue controls', () => {
  const migration = readFileSync(new URL('../migrations/0010_operational_message_states.sql', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../src/messages.ts', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
  assert.match(migration, /sender_display_name TEXT/);
  assert.match(migration, /error_code TEXT/);
  assert.match(migration, /retry_at TEXT/);
  assert.match(source, /handleMessageCancel/);
  assert.match(source, /handleMessageRetry/);
  assert.match(source, /handleMessageReschedule/);
  assert.match(page, /Cancel selected/);
  assert.match(page, /queue-select-visible/);
  assert.match(page, /queue-clear-selection/);
  assert.match(page, /Reschedule/);
  assert.match(page, /Retry/);
  assert.match(page, /overview-summary/);
  assert.match(page, /Needs attention/);
  assert.match(page, /Business profile/);
});

test('balanced policy keeps copy guidance visible while blocking unsafe content', () => {
  const quality = readFileSync(new URL('../src/services/draftQuality.ts', import.meta.url), 'utf8');
  assert.match(quality, /qualityPolicy: QualityPolicy = 'strict'/);
  assert.match(quality, /qualityPolicy === 'strict'/);
  assert.match(quality, /unsupported claim about the prospect/);
  assert.match(quality, /Body is shorter than 70 words/);
});

test('Zoho failures are classified for a user-visible recovery path', () => {
  const zoho = readFileSync(new URL('../src/zoho.ts', import.meta.url), 'utf8');
  const sending = readFileSync(new URL('../src/sending.ts', import.meta.url), 'utf8');
  assert.match(zoho, /provider_unavailable/);
  assert.match(zoho, /invalid_recipient/);
  assert.match(zoho, /Retry-After/);
  assert.match(sending, /Zoho is temporarily unavailable; retry scheduled/);
  assert.match(sending, /Sender address is not approved by Zoho/);
});
