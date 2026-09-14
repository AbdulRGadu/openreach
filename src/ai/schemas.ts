import { z } from 'zod';

export const SEGMENTS = [
  'fintech',
  'healthcare',
  'education',
  'logistics',
  'saas',
  'ecommerce',
  'professional_services',
  'general_business',
] as const;

export const CLASSIFICATIONS = [
  'positive_interest',
  'meeting_request',
  'asks_for_more_info',
  'referral_to_colleague',
  'not_now',
  'not_interested',
  'remove_me',
  'out_of_office',
  'bounce_or_auto_reply',
  'unclear',
] as const;

export type Classification = (typeof CLASSIFICATIONS)[number];

export const POSITIVE_CLASSIFICATIONS: ReadonlySet<string> = new Set([
  'positive_interest',
  'meeting_request',
  'asks_for_more_info',
  'referral_to_colleague',
]);

// --- Scoring ---

export const scoreResult = z.object({
  segment: z.enum(SEGMENTS),
  fit_score: z.number().min(0).max(100),
  fit_reason: z.string().min(1).max(500),
  pain_points: z.array(z.string().max(200)).max(5),
});
export type ScoreResult = z.infer<typeof scoreResult>;

export const scoreJsonSchema = {
  type: 'object',
  properties: {
    segment: { type: 'string', enum: [...SEGMENTS] },
    fit_score: { type: 'integer', minimum: 0, maximum: 100 },
    fit_reason: { type: 'string' },
    pain_points: { type: 'array', items: { type: 'string' }, maxItems: 3 },
  },
  required: ['segment', 'fit_score', 'fit_reason', 'pain_points'],
} as const;

// --- Email drafting ---

export const draftResult = z.object({
  subject: z.string().min(1).max(120),
  body: z.string().min(1),
});
export type DraftResult = z.infer<typeof draftResult>;

export const draftJsonSchema = {
  type: 'object',
  properties: {
    subject: { type: 'string' },
    body: { type: 'string' },
  },
  required: ['subject', 'body'],
} as const;

// --- Reply classification ---

export const classifyResult = z.object({
  classification: z.enum(CLASSIFICATIONS),
  confidence: z.number().min(0).max(1),
  summary: z.string().max(500),
});
export type ClassifyResult = z.infer<typeof classifyResult>;

export const classifyJsonSchema = {
  type: 'object',
  properties: {
    classification: { type: 'string', enum: [...CLASSIFICATIONS] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    summary: { type: 'string' },
  },
  required: ['classification', 'confidence', 'summary'],
} as const;

// --- Discovery research structuring ---

const shortList = z.array(z.string().min(1).max(240)).max(6);

export const discoveryEnrichmentResult = z.object({
  company_summary: z.string().min(1).max(700),
  industry: z.string().max(120),
  country: z.string().max(100),
  company_size: z.string().max(80),
  company_fit_score: z.number().min(0).max(100),
  role_relevance_score: z.number().min(0).max(100),
  timing_signal_score: z.number().min(0).max(100),
  data_confidence: z.number().min(0).max(100),
  score_reason: z.string().min(1).max(500),
  why_relevant: z.string().min(1).max(500),
  verified_facts: shortList,
  business_relevance: shortList,
  contact_relevance: shortList,
  personalization_hooks: shortList,
  do_not_claim: shortList,
  research_gaps: shortList,
});
export type DiscoveryEnrichmentResult = z.infer<typeof discoveryEnrichmentResult>;

const score = { type: 'integer', minimum: 0, maximum: 100 } as const;
const strings = { type: 'array', items: { type: 'string' }, maxItems: 6 } as const;

export const discoveryEnrichmentJsonSchema = {
  type: 'object',
  properties: {
    company_summary: { type: 'string' },
    industry: { type: 'string' },
    country: { type: 'string' },
    company_size: { type: 'string' },
    company_fit_score: score,
    role_relevance_score: score,
    timing_signal_score: score,
    data_confidence: score,
    score_reason: { type: 'string' },
    why_relevant: { type: 'string' },
    verified_facts: strings,
    business_relevance: strings,
    contact_relevance: strings,
    personalization_hooks: strings,
    do_not_claim: strings,
    research_gaps: strings,
  },
  required: [
    'company_summary',
    'industry',
    'country',
    'company_size',
    'company_fit_score',
    'role_relevance_score',
    'timing_signal_score',
    'data_confidence',
    'score_reason',
    'why_relevant',
    'verified_facts',
    'business_relevance',
    'contact_relevance',
    'personalization_hooks',
    'do_not_claim',
    'research_gaps',
  ],
} as const;
