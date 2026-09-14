import type { LeadRow, QualityPolicy } from '../types.ts';
import { wordCount } from '../util/text.ts';
import { expectedGreeting } from './emailRenderer.ts';
import type { LeadSegmentationResult } from './leadSegmentation.ts';
import { DEFAULT_OUTREACH_SETTINGS, type OutreachSettings } from './outreachSettings.ts';
import type { WorkspaceProfile } from './workspaceProfile.ts';

export interface DraftQualityCheck { id: string; label: string; passed: boolean; }
export interface DraftQualityResult { valid: boolean; status: 'passed' | 'needs_review'; warnings: string[]; word_count: number; question_count: number; checks: DraftQualityCheck[]; }
function countCtas(text: string): number { return (text.match(/\?/g) ?? []).length + text.split(/\n+/).filter((line) => /\b(?:let me know|reply if|send over|schedule|book)\b/i.test(line) && !line.includes('?')).length; }
function escaped(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
export function validateDraftQuality(subject: string, body: string, lead: LeadRow, strategy?: LeadSegmentationResult, sourceBody = body, settings: OutreachSettings = DEFAULT_OUTREACH_SETTINGS, qualityPolicy: QualityPolicy = 'strict', workspace?: WorkspaceProfile): DraftQualityResult {
  const warnings: string[] = []; const normalized = body.replace(/\r\n?/g, '\n').trim(); const raw = sourceBody.replace(/\r\n?/g, '\n').trim();
  const blocks = normalized.split(/\n\s*\n/).filter(Boolean); const words = wordCount(normalized); const questions = (raw.match(/\?/g) ?? []).length;
  const business = workspace?.businessName || settings.senderDisplayName || 'the sender'; const expectedSignoff = settings.senderName ? `${settings.signoff},\n${settings.senderName}` : `${settings.signoff},`;
  if (subject.trim().length < 3) warnings.push('Subject is too short.'); if (wordCount(subject) > 10) warnings.push('Subject is longer than 10 words.');
  if (words < 70) warnings.push('Body is shorter than 70 words.'); if (words > 160) warnings.push('Body exceeds the 160-word quality limit.');
  if (blocks.length < 4 || blocks.length > 7) warnings.push('Body must contain 4 to 7 readable paragraphs.');
  if (blocks[0] !== expectedGreeting(lead, settings)) warnings.push(`Greeting must be exactly "${expectedGreeting(lead, settings)}".`);
  if (!new RegExp(`^I['’]m reaching out from ${escaped(business)}\\.$`, 'i').test(blocks[1] ?? '')) warnings.push('Sender line must introduce the configured business.');
  if (!strategy?.recommended_offer || !raw.toLowerCase().includes(strategy.recommended_offer.toLowerCase())) warnings.push('Helpful offer is missing or unclear.');
  if (strategy && !raw.includes(strategy.recommended_cta)) warnings.push('CTA does not match the configured next step.');
  if (questions !== 1 || countCtas(raw) !== 1) warnings.push('Body must contain exactly one CTA question.');
  if (!normalized.endsWith(expectedSignoff)) warnings.push('Signoff must appear exactly once with the configured sender.');
  if (/\b(?:we found|we detected|we identified|we scanned|we audited|your (?:company|team|systems?) (?:has|have|lacks?))\b/i.test(raw)) warnings.push('Draft makes an unsupported claim about the prospect.');
  for (const phrase of workspace?.claimsToAvoid ?? []) if (phrase && raw.toLowerCase().includes(phrase.toLowerCase())) warnings.push(`Draft uses a configured avoided claim: ${phrase}.`);
  if (/https?:\/\/\S*(?:unsubscribe|opt[-_]?out)\S*|\b(?:unsubscribe|opt out)\b/i.test(raw)) warnings.push('AI body includes unsubscribe text.');
  if (/^\s*(?:—|--|___|\*\*\*)\s*$/m.test(raw)) warnings.push('A standalone separator is present.');
  if (/\b(?:guaranteed|limited time|act now|urgent(?:ly)?|final chance)\b/i.test(raw)) warnings.push('Draft contains hype or fake urgency.');
  const unique = [...new Set(warnings)]; const blocking = qualityPolicy === 'strict' ? unique : unique.filter((w) => /too short|configured business|unsupported claim|unsubscribe|separator|hype|Signoff/i.test(w));
  const failed = (re: RegExp) => unique.some((w) => re.test(w));
  return { valid: blocking.length === 0, status: blocking.length ? 'needs_review' : 'passed', warnings: unique, word_count: words, question_count: questions, checks: [
    { id: 'subject', label: 'Clear concise subject', passed: !failed(/^Subject/) }, { id: 'length', label: 'Body is 70–160 words', passed: !failed(/^Body (?:is shorter|exceeds)/) },
    { id: 'structure', label: 'Readable greeting, sender line, message, CTA, and signoff', passed: !failed(/paragraphs|Greeting|Sender line|Signoff/) },
    { id: 'offer', label: 'Configured offer and CTA are present', passed: !failed(/Helpful offer|CTA/) }, { id: 'safety', label: 'No unsupported claims, urgency, separator, or unsubscribe copy', passed: !failed(/unsupported|avoided claim|unsubscribe|separator|hype/) },
  ] };
}
