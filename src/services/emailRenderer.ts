import type { LeadRow } from '../types';
import { normalizeEmailBody, normalizeInlineText } from '../util/text.ts';
import { DEFAULT_OUTREACH_SETTINGS, type OutreachSettings } from './outreachSettings.ts';

const TRAILING_SIGNOFF = /(?:\n\s*)+(?:Best|Best regards|Regards|Kind regards|Thanks|Thank you),?\s*\n+[^\n]+\s*$/i;

export function expectedGreeting(lead: Pick<LeadRow, 'first_name'>, settings: OutreachSettings = DEFAULT_OUTREACH_SETTINGS): string {
  const firstName = normalizeInlineText(lead.first_name, 80);
  return firstName ? `${settings.greeting} ${firstName},` : `${settings.fallbackGreeting},`;
}

export function normalizeDraftSubject(subject: string): string {
  return subject.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

/** Apply mechanical formatting only; semantic failures are left for validation/repair. */
export function renderDraftEmail(body: string, lead: Pick<LeadRow, 'first_name'>, settings: OutreachSettings = DEFAULT_OUTREACH_SETTINGS): string {
  let normalized = normalizeEmailBody(body).replace(TRAILING_SIGNOFF, '').trim();
  const customSignoff = settings.senderName ? `${settings.signoff},\n${settings.senderName}` : `${settings.signoff},`;
  if (normalized.endsWith(customSignoff)) normalized = normalized.slice(0, -customSignoff.length).trim();
  const blocks = normalized.split(/\n\s*\n/).filter(Boolean);
  if (blocks[0] && /^(?:hi|hello|dear|goodday)\b[^\n]*[,!]$/i.test(blocks[0])) blocks.shift();
  normalized = [expectedGreeting(lead, settings), ...blocks, customSignoff].join('\n\n');
  return normalizeEmailBody(normalized);
}
