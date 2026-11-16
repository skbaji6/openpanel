// Rank order: the furthest status wins, mirrored by marketing.message_status_rank in migration 0019.
export const MESSAGE_STATUSES = [
  'skipped',
  'uncertain',
  'sent',
  'failed',
  'delivered',
  'read',
  'clicked',
  'converted',
] as const;

export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export function statusRank(status: MessageStatus): number {
  return MESSAGE_STATUSES.indexOf(status);
}

// The funnel counts these, not ranks: a conversion does not imply a click.
export const MILESTONES = [
  'accepted',
  'delivered',
  'read',
  'clicked',
  'converted',
  'failed',
] as const;
