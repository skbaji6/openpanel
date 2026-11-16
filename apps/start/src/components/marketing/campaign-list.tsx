import { useQuery } from '@tanstack/react-query';
import { MegaphoneIcon, PlusIcon } from 'lucide-react';
import {
  describeMarketingError,
  useMarketingFetch,
  useMarketingQueryKey,
} from './api';
import type { CampaignRow } from './campaign-contract';
import {
  audienceLabel,
  CHANNEL_LABELS,
  progressText,
  STATE_BADGE,
  sendTimeText,
} from './campaign-form';
import { useAudiences } from './use-campaign';
import { EmptyState } from '@/components/empty-state';
import FullPageLoadingState from '@/components/full-page-loading-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

export function CampaignList({
  onOpen,
  onNew,
}: {
  onOpen: (id: string) => void;
  onNew: () => void;
}) {
  const marketingFetch = useMarketingFetch();
  const queryKey = useMarketingQueryKey();
  const campaigns = useQuery({
    queryKey: queryKey('campaigns'),
    queryFn: () => marketingFetch<{ campaigns: CampaignRow[] }>('campaigns'),
  });
  const audiences = useAudiences();
  const audienceSource = {
    audiences: audiences.data?.audiences,
    failed: Boolean(audiences.error),
  };
  const rows = campaigns.data?.campaigns ?? [];

  return (
    <div className="col gap-4">
      <div className="row items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">
          One message to an audience, sent now or at a set time.
        </p>
        <Button icon={PlusIcon} onClick={onNew}>
          New campaign
        </Button>
      </div>
      {campaigns.isPending && <FullPageLoadingState />}
      {campaigns.error && (
        <EmptyState
          variant="section"
          description={describeMarketingError(campaigns.error)}
          icon={MegaphoneIcon}
          title="Campaigns are not available"
        />
      )}
      {campaigns.data && rows.length === 0 && (
        <EmptyState
          variant="section"
          description="Create a campaign to draft a message for an audience."
          icon={MegaphoneIcon}
          title="No campaigns yet"
        />
      )}
      {rows.length > 0 && audiences.error && (
        <p className="rounded border p-3 text-sm">
          Audience names could not be loaded:{' '}
          {describeMarketingError(audiences.error)}
        </p>
      )}
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-muted-foreground">
              <tr>
                <th className="p-2">Name</th>
                <th className="p-2">Channel</th>
                <th className="p-2">State</th>
                <th className="p-2">Audience</th>
                <th className="p-2">Sent / queued</th>
                <th className="p-2">Send time</th>
                <th className="p-2">Created</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const badge = STATE_BADGE[row.state];
                return (
                  <tr className="border-t hover:bg-muted/50" key={row.id}>
                    <td className="p-2">
                      <button
                        className="text-left font-medium hover:underline"
                        onClick={() => onOpen(row.id)}
                        type="button"
                      >
                        {row.name}
                      </button>
                    </td>
                    <td className="p-2">{CHANNEL_LABELS[row.channel]}</td>
                    <td className="p-2">
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                    </td>
                    <td className="p-2">
                      {audienceLabel(row.audienceId, audienceSource)}
                    </td>
                    <td className="p-2">{progressText(row)}</td>
                    <td className="p-2">{sendTimeText(row)}</td>
                    <td className="p-2">
                      {new Date(row.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
