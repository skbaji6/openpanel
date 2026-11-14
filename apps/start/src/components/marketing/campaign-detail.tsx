import { MegaphoneIcon } from 'lucide-react';
import { describeMarketingError } from './api';
import { CHANNEL_LABELS, STATE_BADGE, sendTimeText } from './campaign-form';
import { useAudiences, useCampaign } from './use-campaign';
import { FullPageEmptyState } from '@/components/full-page-empty-state';
import FullPageLoadingState from '@/components/full-page-loading-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

export function CampaignSummary({
  campaignId,
  onClose,
}: {
  campaignId: string;
  onClose: () => void;
}) {
  const campaign = useCampaign(campaignId);
  const audiences = useAudiences();

  if (campaign.isPending) {
    return <FullPageLoadingState />;
  }
  if (campaign.error) {
    return (
      <FullPageEmptyState
        description={describeMarketingError(campaign.error)}
        icon={MegaphoneIcon}
        title="Campaign not found"
      >
        <Button onClick={onClose}>Back to campaigns</Button>
      </FullPageEmptyState>
    );
  }
  const row = campaign.data;
  const badge = STATE_BADGE[row.state];
  const audienceName =
    audiences.data?.audiences.find((a) => a.id === row.audienceId)?.name ??
    row.audienceId ??
    'None';
  const facts: [string, string][] = [
    ['Channel', CHANNEL_LABELS[row.channel]],
    ['Audience', audienceName],
    ['Send time', sendTimeText(row)],
    ['Queued', String(row.counters.queued)],
    ['Sent', String(row.counters.sent)],
    ['Failed', String(row.counters.failed)],
    ['Skipped', String(row.counters.skipped)],
    ['Uncertain', String(row.counters.uncertain)],
  ];
  return (
    <div className="card col gap-4 p-4">
      <div className="row items-center gap-2">
        <h2 className="font-medium text-lg">{row.name}</h2>
        <Badge variant={badge.variant}>{badge.label}</Badge>
      </div>
      <dl className="grid grid-cols-[10rem_1fr] gap-2 text-sm">
        {facts.map(([label, value]) => (
          <div className="contents" key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <div>
        <Button onClick={onClose} variant="ghost">
          Back to campaigns
        </Button>
      </div>
    </div>
  );
}
