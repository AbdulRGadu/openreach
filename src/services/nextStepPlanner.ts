import type { Classification } from '../ai/schemas';
import type { LeadRow } from '../types';
import type { LeadSegmentationResult } from './leadSegmentation';
import type { WorkspaceProfile } from './workspaceProfile.ts';
import { DEFAULT_OUTREACH_SETTINGS, type OutreachSettings } from './outreachSettings.ts';

export type ReplyNextAction =
  | 'share_configured_offer'
  | 'suggest_meeting_times'
  | 'send_helpful_information'
  | 'create_new_referred_lead'
  | 'nurture_later'
  | 'do_not_contact'
  | 'suppress_immediately'
  | 'no_action'
  | 'update_email_status'
  | 'manual_review';

export interface InitialNextStepPlan {
  sales_stage: 'first_touch_review';
  email_goal: string;
  on_positive_reply: string;
  on_no_reply: string;
  human_approval_required: true;
}

export interface ReplyPlan {
  classification: Classification;
  confidence: number;
  summary: string;
  next_action: ReplyNextAction;
  suggested_reply: string;
  sales_stage: string;
}

export function planInitialNextStep(strategy: LeadSegmentationResult): InitialNextStepPlan {
  return {
    sales_stage: 'first_touch_review',
    email_goal: `Start a useful conversation and earn permission to share the ${strategy.recommended_offer}.`,
    on_positive_reply: `Share the requested ${strategy.recommended_offer} and agree on a helpful next step.`,
    on_no_reply: 'Do not auto-follow up; leave the lead for human review.',
    human_approval_required: true,
  };
}

export function nextActionFor(classification: string): ReplyNextAction {
  switch (classification) {
    case 'positive_interest': return 'share_configured_offer';
    case 'meeting_request': return 'suggest_meeting_times';
    case 'asks_for_more_info': return 'send_helpful_information';
    case 'referral_to_colleague': return 'create_new_referred_lead';
    case 'not_now': return 'nurture_later';
    case 'not_interested': return 'do_not_contact';
    case 'remove_me': return 'suppress_immediately';
    case 'out_of_office': return 'no_action';
    case 'bounce_or_auto_reply': return 'update_email_status';
    default: return 'manual_review';
  }
}

export function salesStageFor(classification: string): string {
  switch (classification) {
    case 'positive_interest': return 'engaged';
    case 'meeting_request': return 'meeting_requested';
    case 'asks_for_more_info': return 'information_requested';
    case 'referral_to_colleague': return 'referral_received';
    case 'not_now': return 'nurture_later';
    case 'not_interested':
    case 'remove_me': return 'do_not_contact';
    case 'out_of_office': return 'auto_reply';
    case 'bounce_or_auto_reply': return 'delivery_issue';
    default: return 'manual_review';
  }
}

function greeting(lead: LeadRow | null, settings: OutreachSettings): string {
  return lead?.first_name?.trim() ? `${settings.greeting} ${lead.first_name.trim()},` : `${settings.fallbackGreeting},`;
}

function signoff(settings: OutreachSettings): string {
  return settings.senderName ? `${settings.signoff},\n${settings.senderName}` : `${settings.signoff},`;
}

function referralContact(replyBody: string): string {
  return replyBody.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? 'your colleague';
}

export function suggestedReplyFor(classification: Classification, lead: LeadRow | null, replyBody = '', settings: OutreachSettings = DEFAULT_OUTREACH_SETTINGS, workspace?: WorkspaceProfile): string {
  const hello = greeting(lead, settings);
  const offer = workspace?.offer || 'the helpful information';
  const business = workspace?.businessName || settings.senderDisplayName || 'our team';
  switch (classification) {
    case 'positive_interest':
      return `${hello}\n\nThanks for getting back to me.\n\nI’ll send over ${offer}.\n\nIf useful, we can discuss the most relevant next step after you have had a look.\n\n${signoff(settings)}`;
    case 'meeting_request':
      return `${hello}\n\nThanks for your response.\n\nA short conversation would be a good next step to understand your priorities and whether ${business} can help.\n\nPlease share a convenient time, or I can send over a few options.\n\n${signoff(settings)}`;
    case 'asks_for_more_info':
      return `${hello}\n\nThanks for getting back to me.\n\nI can send ${offer} first so you can decide whether a conversation is worthwhile.\n\n${workspace?.cta || 'Would you like me to send it over?'}\n\n${signoff(settings)}`;
    case 'referral_to_colleague':
      return `${hello}\n\nThanks for pointing me in the right direction. I’ll reach out to ${referralContact(replyBody)} separately and keep the note brief.\n\nI appreciate the introduction.\n\n${signoff(settings)}`;
    default:
      return '';
  }
}

export function planReply(args: {
  classification: Classification;
  confidence: number;
  summary: string;
  lead: LeadRow | null;
  replyBody?: string;
  settings?: OutreachSettings;
  workspace?: WorkspaceProfile;
}): ReplyPlan {
  return {
    classification: args.classification,
    confidence: args.confidence,
    summary: args.summary,
    next_action: nextActionFor(args.classification),
    suggested_reply: suggestedReplyFor(args.classification, args.lead, args.replyBody, args.settings, args.workspace),
    sales_stage: salesStageFor(args.classification),
  };
}
