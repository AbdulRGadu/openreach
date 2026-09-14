import type { LeadRow } from '../types';

/** Stable industry labels retained for compatibility with existing lead filters. */
export type ProspectSegment =
  | 'fintech'
  | 'healthcare'
  | 'education'
  | 'logistics'
  | 'saas'
  | 'ecommerce'
  | 'professional_services'
  | 'general_business';

export type BuyerPersona = 'founder' | 'executive' | 'technical' | 'operations' | 'marketing' | 'admin' | 'unknown';

export interface LeadSegmentationInput {
  companyName?: string | null;
  industry?: string | null;
  subIndustry?: string | null;
  contactRole?: string | null;
  country?: string | null;
  notes?: string | null;
  source?: string | null;
  website?: string | null;
  domain?: string | null;
  fitScore?: number | null;
}

export interface LeadSegmentationResult {
  segment: ProspectSegment;
  buyer_persona: BuyerPersona;
  likely_relevance_context: string;
  recommended_offer: string;
  recommended_cta: string;
  do_not_say: string[];
}

const SEGMENT_PATTERNS: Array<[ProspectSegment, RegExp]> = [
  ['fintech', /\b(?:fintech|bank(?:ing)?|payments?|lending|credit|insurtech|mobile money|digital wallet|financial technology)\b/i],
  ['healthcare', /\b(?:healthcare|health care|hospital|clinic|medical|patient|pharmacy|pharmaceutical|dental|healthtech)\b/i],
  ['education', /\b(?:school|education|university|college|academy|student|edtech|training institute)\b/i],
  ['logistics', /\b(?:logistics|delivery|shipment|freight|transport(?:ation)?|warehouse|courier|supply chain|fleet)\b/i],
  ['saas', /\b(?:saas|software as a service|cloud software|subscription software|software platform)\b/i],
  ['ecommerce', /\b(?:e-?commerce|online retail|online store|digital marketplace|retail marketplace)\b/i],
  ['professional_services', /\b(?:professional services?|consult(?:ing|ancy)|law firm|legal services?|accounting|creative agency|marketing agency|architecture firm)\b/i],
];

function sourceText(input: LeadSegmentationInput): string {
  return [input.industry, input.subIndustry, input.companyName, input.website, input.domain, input.notes]
    .filter(Boolean).join(' ');
}

function detectSegment(input: LeadSegmentationInput): ProspectSegment {
  const text = sourceText(input);
  for (const [segment, pattern] of SEGMENT_PATTERNS) if (pattern.test(text)) return segment;
  return 'general_business';
}

function detectBuyerPersona(role: string | null | undefined): BuyerPersona {
  const value = (role ?? '').trim().toLowerCase();
  if (/\b(?:co-?founder|founder|business owner|owner)\b/.test(value)) return 'founder';
  if (/\b(?:chief executive|ceo|managing director|president|general manager|chief .* officer)\b/.test(value)) return 'executive';
  if (/\b(?:engineer|developer|technical|technology|cto|architect|data scientist|product manager)\b/.test(value)) return 'technical';
  if (/\b(?:operations?|supply chain|service delivery|human resources|people operations)\b/.test(value)) return 'operations';
  if (/\b(?:marketing|sales|brand|design|communications?)\b/.test(value)) return 'marketing';
  if (/\b(?:administrator|admin|office manager|coordinator|assistant)\b/.test(value)) return 'admin';
  return 'unknown';
}

export function leadShowsWarmIntent(input: LeadSegmentationInput): boolean {
  const source = (input.source ?? '').toLowerCase();
  if (/\b(?:referral|inbound|existing customer|partner)\b/.test(source)) return true;
  return /\b(?:requested|asked for|interested in|book(?:ing)?|meeting|walkthrough|proposal)\b/i.test(input.notes ?? '');
}

/**
 * Supply neutral lead context only. Workspace-specific services, offers, and
 * CTAs are layered on in buildPersonalizationPlan from the saved profile.
 */
export function segmentLead(input: LeadSegmentationInput): LeadSegmentationResult {
  const industry = (input.industry ?? input.subIndustry ?? '').trim();
  const doNotSay = ['we reviewed your company', 'we found a problem', 'assume a need or intent that was not supplied'];
  return {
    segment: detectSegment(input),
    buyer_persona: detectBuyerPersona(input.contactRole),
    likely_relevance_context: industry
      ? `The supplied lead data lists ${industry} as the industry. Connect it to the workspace profile only where the fit is clear.`
      : 'No reliable industry context was supplied; keep the note relevant without making assumptions.',
    recommended_offer: 'a short overview of relevant services',
    recommended_cta: 'Would a short overview be useful?',
    do_not_say: doNotSay,
  };
}

export function segmentLeadRow(lead: LeadRow): LeadSegmentationResult {
  return segmentLead({
    companyName: lead.company,
    industry: lead.industry,
    subIndustry: lead.sub_industry,
    contactRole: lead.role,
    country: lead.country,
    notes: lead.notes,
    source: lead.source,
    website: lead.company_website,
    domain: lead.domain,
    fitScore: lead.fit_score,
  });
}
