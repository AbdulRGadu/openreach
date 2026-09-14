export interface SendJob {
  type: 'send';
  messageId: string;
}

export type LeadStatus =
  | 'new'
  | 'scored'
  | 'drafted'
  | 'approved'
  | 'queued'
  | 'sent'
  | 'replied_positive'
  | 'meeting_requested'
  | 'asked_for_more_info'
  | 'referred'
  | 'not_now'
  | 'not_interested'
  | 'suppressed'
  | 'unmatched_reply'
  | 'manual_review'
  | 'failed';

export type MessageStatus =
  | 'draft'
  | 'needs_review'
  | 'approved'
  | 'queued'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'rejected'
  | 'send_unknown'
  | 'received';

export type SendabilityStatus = 'sendable' | 'needs_review' | 'blocked';

export type CampaignStatus = 'draft' | 'active' | 'paused' | 'archived' | 'completed';
export type QualityPolicy = 'balanced' | 'strict' | 'custom';

export interface SenderProfileRow {
  id: string;
  name: string;
  display_name: string | null;
  sender_email: string;
  reply_email: string;
  cc_email: string | null;
  bcc_email: string | null;
  greeting: string;
  fallback_greeting: string;
  signoff: string;
  sender_name: string | null;
  cta: string;
  footer_html: string;
  quality_policy: QualityPolicy;
  is_verified: number;
  display_name_verified: number;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface CampaignRow {
  id: string;
  name: string;
  status: CampaignStatus;
  objective: string | null;
  owner_label: string | null;
  notes: string | null;
  sender_profile_id: string | null;
  timezone: string;
  start_date: string | null;
  end_date: string | null;
  auto_send: number;
  follow_up_enabled: number;
  follow_up_delay_business_days: number;
  send_window: string;
  send_start_time: string;
  send_interval_minutes: number;
  send_days: string;
  daily_cap: number;
  domain_weekly_cap: number;
  maximum_volume: number | null;
  quality_policy: QualityPolicy;
  tone: string | null;
  offer: string | null;
  cta: string | null;
  sector_angle: string | null;
  initial_template: string | null;
  follow_up_template: string | null;
  sender_profile_name?: string | null;
  audience_count?: number;
  sent_count?: number;
  replied_count?: number;
  queued_count?: number;
  attention_count?: number;
  next_scheduled_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface LeadRow {
  id: string;
  email: string;
  domain: string;
  first_name: string | null;
  last_name: string | null;
  role: string | null;
  company: string | null;
  company_website: string | null;
  industry: string | null;
  sub_industry: string | null;
  segment: string | null;
  fit_score: number | null;
  fit_reason: string | null;
  pain_points: string | null;
  source: string;
  status: LeadStatus;
  last_reply_classification: string | null;
  notes: string | null;
  country: string | null;
  company_size: string | null;
  contact_profile_url: string | null;
  source_url: string | null;
  structured_notes: string | null;
  discovery_score: number | null;
  data_confidence: number | null;
  last_verified_at: string | null;
  sales_stage: string;
  next_action: string | null;
  delivery_test: number;
  created_at: string;
  updated_at: string;
}

export type DiscoverySourceType =
  | 'company_website'
  | 'public_business_directory'
  | 'business_registry'
  | 'event_or_membership_list'
  | 'public_news'
  | 'professional_profile'
  | 'partner_referral'
  | 'customer_referral'
  | 'inbound_request'
  | 'manual_research'
  | 'csv_import'
  | 'official_api';

export type DiscoveryStatus = 'new' | 'enriched' | 'needs_research' | 'accepted' | 'rejected' | 'failed';

export interface StructuredDiscoveryNotes {
  company_summary: string;
  why_relevant: string;
  verified_facts: string[];
  business_relevance: string[];
  contact_relevance: string[];
  personalization_hooks: string[];
  do_not_claim: string[];
  research_gaps: string[];
}

export interface DiscoveryCandidateRow {
  id: string;
  company: string | null;
  company_domain: string | null;
  company_website: string | null;
  industry: string | null;
  country: string | null;
  company_size: string | null;
  contact_email: string | null;
  contact_first_name: string | null;
  contact_last_name: string | null;
  contact_role: string | null;
  contact_profile_url: string | null;
  source_type: DiscoverySourceType;
  raw_notes: string | null;
  structured_notes: string | null;
  company_fit_score: number | null;
  role_relevance_score: number | null;
  timing_signal_score: number | null;
  discovery_score: number | null;
  data_confidence: number | null;
  score_reason: string | null;
  status: DiscoveryStatus;
  lead_id: string | null;
  last_error: string | null;
  discovered_at: string;
  last_verified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DiscoverySourceRow {
  id: string;
  candidate_id: string;
  lead_id: string | null;
  source_type: DiscoverySourceType;
  source_url: string | null;
  source_title: string | null;
  evidence: string | null;
  observed_at: string | null;
  created_at: string;
}

export interface MessageRow {
  id: string;
  lead_id: string | null;
  direction: 'outbound' | 'inbound';
  status: MessageStatus;
  subject: string | null;
  body: string | null;
  from_email: string | null;
  to_email: string | null;
  classification: string | null;
  confidence: number | null;
  summary: string | null;
  suggested_reply: string | null;
  ai_model: string | null;
  prompt_version: string | null;
  zoho_message_id: string | null;
  next_action: string | null;
  received_at: string | null;
  attempts: number;
  error: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  buyer_persona: string | null;
  relevance_context: string | null;
  recommended_offer: string | null;
  recommended_cta: string | null;
  draft_quality_status: string | null;
  validation_warnings: string | null;
  next_step_plan: string | null;
  campaign_id: string | null;
  sender_profile_id: string | null;
  sequence_step: number;
  settings_snapshot: string | null;
  quality_snapshot: string | null;
  scheduled_at: string | null;
  sendability_status: SendabilityStatus;
  status_reason: string | null;
  error_code: string | null;
  error_detail: string | null;
  retry_at: string | null;
  last_attempt_at: string | null;
  sender_display_name: string | null;
  provider_status: string | null;
  stopped_at: string | null;
  stopped_reason: string | null;
  profile_snapshot?: string | null;
}

export type ReplyMatchStatus =
  | 'matched_by_message_id'
  | 'matched_by_in_reply_to'
  | 'matched_by_sender_email'
  | 'matched_by_sender_domain'
  | 'unmatched';

export interface ReplyIngestLogRow {
  id: string;
  from_email: string | null;
  message_id: string | null;
  in_reply_to: string | null;
  references_header: string | null;
  raw_payload: string | null;
  auth_status: 'authorized' | 'unauthorized';
  match_status: ReplyMatchStatus | null;
  classification_status: 'pending' | 'classified' | 'failed' | 'skipped';
  classification: string | null;
  confidence: number | null;
  lead_id: string | null;
  inbound_message_id: string | null;
  error: string | null;
  payload_received_at: string;
  updated_at: string;
}
