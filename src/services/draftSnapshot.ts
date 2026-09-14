import type { CampaignRow, LeadRow } from '../types';
import type { OutreachSettings } from './outreachSettings';
import type { WorkspaceProfile } from './workspaceProfile';

export interface DraftProfileSnapshot {
  version: 1;
  profile: WorkspaceProfile;
  messaging: OutreachSettings;
  campaignBrief: null | {
    id: string;
    name: string;
    objective: string | null;
    selectedAudience: { leadId: string; company: string | null; industry: string | null; role: string | null; geography: string | null };
    tone: string | null;
    offer: string | null;
    cta: string | null;
    personalizationNote: string | null;
    initialTemplate: string | null;
    followUpTemplate: string | null;
  };
}

export function createDraftProfileSnapshot(
  profile: WorkspaceProfile,
  messaging: OutreachSettings,
  campaign: CampaignRow | null,
  lead: LeadRow,
): string {
  const snapshot: DraftProfileSnapshot = {
    version: 1,
    profile,
    messaging,
    campaignBrief: campaign ? {
      id: campaign.id,
      name: campaign.name,
      objective: campaign.objective,
      selectedAudience: { leadId: lead.id, company: lead.company, industry: lead.industry, role: lead.role, geography: lead.country },
      tone: campaign.tone,
      offer: campaign.offer,
      cta: campaign.cta,
      personalizationNote: campaign.sector_angle,
      initialTemplate: campaign.initial_template,
      followUpTemplate: campaign.follow_up_template,
    } : null,
  };
  return JSON.stringify(snapshot);
}

/** Accept both the current envelope and the first profile-only preview format. */
export function readDraftWorkspaceSnapshot(raw: string | null | undefined): WorkspaceProfile | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const candidate = record.profile && typeof record.profile === 'object' && !Array.isArray(record.profile)
      ? record.profile as Record<string, unknown>
      : record;
    return typeof candidate.businessName === 'string' && typeof candidate.industry === 'string'
      ? candidate as unknown as WorkspaceProfile
      : null;
  } catch {
    return null;
  }
}

export function readDraftMessagingSnapshot(raw: string | null | undefined): OutreachSettings | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const candidate = record.messaging;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const messaging = candidate as Record<string, unknown>;
    if (typeof messaging.greeting !== 'string' || typeof messaging.signoff !== 'string') return null;
    return messaging as unknown as OutreachSettings;
  } catch {
    return null;
  }
}

export function readDraftCampaignBrief(raw: string | null | undefined) {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const brief = (value as Record<string, unknown>).campaignBrief;
    if (!brief || typeof brief !== 'object' || Array.isArray(brief)) return undefined;
    const record = brief as Record<string, unknown>;
    const selected = record.selectedAudience && typeof record.selectedAudience === 'object' && !Array.isArray(record.selectedAudience)
      ? record.selectedAudience as Record<string, unknown>
      : {};
    return {
      objective: typeof record.objective === 'string' ? record.objective : '',
      audience: [selected.role, selected.industry, selected.geography].filter((item): item is string => typeof item === 'string' && item.length > 0).join(' · '),
      tone: typeof record.tone === 'string' ? record.tone : '',
      offer: typeof record.offer === 'string' ? record.offer : '',
      cta: typeof record.cta === 'string' ? record.cta : '',
      personalizationNote: typeof record.personalizationNote === 'string' ? record.personalizationNote : '',
    };
  } catch {
    return undefined;
  }
}
