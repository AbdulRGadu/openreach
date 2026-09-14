import type { LeadRow } from '../types.ts';
import { normalizeInlineText, normalizeMultilineText } from '../util/text.ts';
import { leadShowsWarmIntent, segmentLead, type LeadSegmentationResult } from './leadSegmentation.ts';
import { DEFAULT_OUTREACH_SETTINGS, type OutreachSettings } from './outreachSettings.ts';
import type { WorkspaceProfile } from './workspaceProfile.ts';
import type { CampaignRow } from '../types.ts';

export interface NormalizedProspect { first_name: string; company_name: string; industry: string; segment: string; role: string; country: string; notes: string; }
export interface DraftPersonalizationPlan { prospect: NormalizedProspect; strategy: LeadSegmentationResult; outreach_angle: string; is_warm: boolean; messaging: OutreachSettings; workspace: WorkspaceProfile; campaignBrief?: { objective: string; audience: string; tone: string; offer: string; cta: string; personalizationNote: string }; }
const DEFAULT_WORKSPACE: WorkspaceProfile = { businessName: 'Your business', website: '', industry: '', description: '', services: ['practical services'], idealCustomer: 'teams with a relevant need', targetIndustries: [], targetRoles: [], painPoints: ['a clear next step'], differentiators: [], offer: 'a useful overview', cta: 'Would it be useful if I sent it over?', tone: 'helpful and professional', geography: '', claimsToAvoid: [], version: 1, demoMode: false };

export function buildPersonalizationPlan(lead: LeadRow, messaging: OutreachSettings = DEFAULT_OUTREACH_SETTINGS, workspace: WorkspaceProfile = DEFAULT_WORKSPACE, campaign?: CampaignRow | null): DraftPersonalizationPlan {
  const input = { companyName: normalizeInlineText(lead.company, 160), industry: normalizeInlineText(lead.industry, 120), subIndustry: normalizeInlineText(lead.sub_industry, 120), contactRole: normalizeInlineText(lead.role, 120), country: normalizeInlineText(lead.country, 100), notes: normalizeMultilineText(lead.notes, 1600), source: normalizeInlineText(lead.source, 40), website: normalizeInlineText(lead.company_website, 240), domain: normalizeInlineText(lead.domain, 180), fitScore: lead.fit_score };
  const base = segmentLead(input);
  const effectiveWorkspace = campaign?.tone ? { ...workspace, tone: campaign.tone } : workspace;
  const campaignBrief = campaign ? {
    objective: campaign.objective || '',
    audience: [input.contactRole, input.industry || input.subIndustry, input.country].filter(Boolean).join(' · '),
    tone: campaign.tone || '', offer: campaign.offer || '', cta: campaign.cta || '',
    personalizationNote: campaign.sector_angle || '',
  } : undefined;
  const strategy: LeadSegmentationResult = {
    ...base,
    likely_relevance_context: input.industry
      ? `The lead data lists ${input.industry}. Connect ${workspace.services[0] || 'the configured service'} to ${workspace.painPoints[0] || 'a relevant business priority'} only where the fit is clear.`
      : 'Keep the note useful and relevant without assuming facts about the prospect.',
    recommended_offer: campaign?.offer || workspace.offer,
    recommended_cta: campaign?.cta || workspace.cta,
    do_not_say: [...new Set(['we reviewed your company', 'we found a problem', 'assume a need or intent that was not supplied', ...workspace.claimsToAvoid])],
  };
  return {
    prospect: { first_name: normalizeInlineText(lead.first_name, 80), company_name: input.companyName, industry: input.industry || input.subIndustry, segment: strategy.segment, role: input.contactRole, country: input.country, notes: input.notes },
    strategy, outreach_angle: `Connect ${workspace.services.slice(0, 2).join(' and ') || 'your work'} to a practical outcome for ${input.contactRole || 'the recipient'}.`,
    is_warm: leadShowsWarmIntent(input), messaging, workspace: effectiveWorkspace, campaignBrief,
  };
}
