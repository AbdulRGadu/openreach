import type { LeadRow } from '../types';

export function deliveryTestEnabled(lead: Pick<LeadRow, 'delivery_test'>): boolean {
  return lead.delivery_test === 1;
}

export function priorOutboundBlocksDelivery(testEnabled: boolean, status: string): boolean {
  if (testEnabled && status === 'sent') return false;
  return ['approved', 'queued', 'sending', 'sent', 'send_unknown'].includes(status);
}
