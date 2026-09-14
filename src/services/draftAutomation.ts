import type { DraftPersonalizationPlan } from './personalization.ts';
import type { LeadRow, QualityPolicy } from '../types';
import { validateDraftQuality, type DraftQualityResult } from './draftQuality.ts';
import { expectedGreeting, normalizeDraftSubject, renderDraftEmail } from './emailRenderer.ts';

export interface DraftCandidate {
  subject: string;
  body: string;
}

export interface DraftRepairRequest {
  failedDraft: DraftCandidate;
  warnings: string[];
  attempt: number;
}

export type DraftRepair = (request: DraftRepairRequest) => Promise<DraftCandidate>;

export interface DraftAutomationResult extends DraftCandidate {
  quality: DraftQualityResult;
  initial_warnings: string[];
  repair_attempts: number;
  repair_failures: number;
  auto_repaired: boolean;
  used_fallback: boolean;
}

function practicalHelp(plan: DraftPersonalizationPlan): string {
  return `${plan.workspace.businessName} helps ${plan.workspace.idealCustomer.toLowerCase()} with ${plan.workspace.services.slice(0, 2).join(' and ') || 'practical work'} so they can make progress on ${plan.workspace.painPoints[0] || 'their next priority'}.`;
}

function offerSentence(plan: DraftPersonalizationPlan): string {
  const offer = plan.strategy.recommended_offer;
  return `I can share ${offer} to make the next step clearer without asking your team for a large commitment.`;
}

export function buildSafeFallbackDraft(lead: LeadRow, plan: DraftPersonalizationPlan): DraftCandidate {
  const body = [
    expectedGreeting(lead, plan.messaging),
    `I'm reaching out from ${plan.workspace.businessName}.`,
    practicalHelp(plan),
    plan.strategy.likely_relevance_context,
    offerSentence(plan),
    plan.strategy.recommended_cta,
    plan.messaging.senderName ? `${plan.messaging.signoff},\n${plan.messaging.senderName}` : `${plan.messaging.signoff},`,
  ].join('\n\n');
  return {
    subject: `${plan.workspace.businessName}: a practical idea`,
    body,
  };
}

function assess(candidate: DraftCandidate, lead: LeadRow, plan: DraftPersonalizationPlan, qualityPolicy: QualityPolicy): DraftCandidate & { quality: DraftQualityResult } {
  const subject = normalizeDraftSubject(candidate.subject ?? '');
  const body = renderDraftEmail(candidate.body ?? '', lead, plan.messaging);
  return {
    subject,
    body,
    quality: validateDraftQuality(subject, body, lead, plan.strategy, candidate.body ?? '', plan.messaging, qualityPolicy, plan.workspace),
  };
}

export async function improveDraftUntilSendable(args: {
  lead: LeadRow;
  plan: DraftPersonalizationPlan;
  initialDraft: DraftCandidate;
  repair: DraftRepair;
  maxRepairAttempts?: number;
  qualityPolicy?: QualityPolicy;
}): Promise<DraftAutomationResult> {
  const qualityPolicy = args.qualityPolicy ?? 'balanced';
  let current = assess(args.initialDraft, args.lead, args.plan, qualityPolicy);
  const initialWarnings = [...current.quality.warnings];
  const maxAttempts = Math.min(Math.max(args.maxRepairAttempts ?? 2, 0), 2);
  let attempts = 0;
  let failures = 0;

  while (!current.quality.valid && attempts < maxAttempts) {
    attempts++;
    try {
      const repaired = await args.repair({
        failedDraft: { subject: current.subject, body: current.body },
        warnings: current.quality.warnings,
        attempt: attempts,
      });
      current = assess(repaired, args.lead, args.plan, qualityPolicy);
    } catch {
      failures++;
    }
  }

  if (!current.quality.valid) {
    current = assess(buildSafeFallbackDraft(args.lead, args.plan), args.lead, args.plan, qualityPolicy);
    return {
      ...current,
      initial_warnings: initialWarnings,
      repair_attempts: attempts,
      repair_failures: failures,
      auto_repaired: true,
      used_fallback: true,
    };
  }

  return {
    ...current,
    initial_warnings: initialWarnings,
    repair_attempts: attempts,
    repair_failures: failures,
    auto_repaired: initialWarnings.length > 0,
    used_fallback: false,
  };
}
