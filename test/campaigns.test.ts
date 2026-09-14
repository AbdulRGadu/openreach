import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { businessDaysElapsed } from '../src/util/time.ts';

test('four business days skips a weekend', () => {
  // Monday to Friday is four completed business days; a weekend does not count.
  assert.equal(businessDaysElapsed('2026-08-24 09:00:00', 'UTC', new Date('2026-08-28T12:00:00Z')), 4);
  assert.equal(businessDaysElapsed('2026-08-28 09:00:00', 'UTC', new Date('2026-08-31T12:00:00Z')), 1);
});

test('campaign workspace persists snapshots and owns one follow-up sequence', () => {
  const migration = readFileSync(new URL('../migrations/0008_campaign_workspace.sql', import.meta.url), 'utf8');
  const scheduleMigration = readFileSync(new URL('../migrations/0009_scheduled_send_queue.sql', import.meta.url), 'utf8');
  const schedule = readFileSync(new URL('../src/schedule.ts', import.meta.url), 'utf8');
  const sending = readFileSync(new URL('../src/sending.ts', import.meta.url), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS sender_profiles/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS campaigns/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS sequence_events/);
  assert.match(migration, /settings_snapshot TEXT/);
  assert.match(migration, /quality_snapshot TEXT/);
  assert.match(schedule, /sequence_step = 2/);
  assert.match(schedule, /businessDaysElapsed/);
  assert.match(sending, /campaign_daily_cap/);
  assert.match(sending, /\?4 = 2 AND sequence_step = 1/);
  assert.match(scheduleMigration, /scheduled_at TEXT/);
});

test('campaign dashboard exposes safe operator controls', () => {
  const page = readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
  assert.match(page, /data-tab="campaigns"/);
  assert.match(page, /data-tab="sent"/);
  assert.match(page, /data-tab="queue"/);
  assert.match(page, /Approve &amp; queue selected/);
  assert.match(page, /status=sent/);
  assert.match(page, /Auto-send disabled · every email requires human approval/);
  assert.match(page, /Prepare one follow-up for review/);
  assert.doesNotMatch(page, /Auto-send sendable drafts/);
  assert.match(page, /Stop unsent/);
  assert.match(page, /Sender profiles/);
  assert.match(page, /sandbox=""/);
});
