import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { MegaphoneIcon } from 'lucide-react';
import { toast } from 'sonner';
import {
  describeMarketingError,
  useMarketingFetch,
  useMarketingQueryKey,
} from './api';
import type { CampaignRow, SkipReasonsResponse } from './campaign-contract';
import {
  audienceLabel,
  CHANNEL_LABELS,
  STATE_BADGE,
  sendTimeText,
} from './campaign-form';
import {
  campaignPath,
  NOT_ADMIN_NOTE,
  UnscheduleButton,
  useStoreCampaign,
} from './campaign-launch-panel';
import { CampaignRecipients } from './campaign-recipients';
import {
  ALREADY_RECEIVED,
  actionsFor,
  outcomeLine,
  progressOf,
  shouldPoll,
  waitingLine,
} from './campaign-status';
import { CAMPAIGN_POLL_MS } from './polling';
import { labelRecipientReason, labelRecipientStatus } from './reason-labels';
import {
  campaignLoadErrorTitle,
  useAudiences,
  useCampaign,
} from './use-campaign';
import { useMarketingRole } from './use-marketing-role';
import { FullPageEmptyState } from '@/components/full-page-empty-state';
import FullPageLoadingState from '@/components/full-page-loading-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { showConfirm } from '@/modals';

type ServerAction = 'pause' | 'resume' | 'cancel' | 'retry-uncertain';

const ACTION_COPY: Record<
  ServerAction,
  { label: string; text: string; done: string }
> = {
  pause: {
    label: 'Pause',
    text: 'Pause stops sending until you resume. Nothing is lost.',
    done: 'Campaign paused',
  },
  resume: {
    label: 'Resume',
    text: 'Resume continues sending the students who are still waiting.',
    done: 'Campaign resumed',
  },
  cancel: {
    label: 'Cancel',
    text: 'Cancel stops the rest; already sent messages cannot be recalled.',
    done: 'Campaign cancelled',
  },
  'retry-uncertain': {
    label: 'Retry uncertain',
    text: 'The uncertain messages are sent again. If the provider had already accepted one, that student gets a second message.',
    done: 'Uncertain messages queued again',
  },
};

const UNCERTAIN_NOTE =
  'The provider may or may not have accepted these. Retrying can send a second message.';

function ActionButton({
  campaign,
  action,
}: {
  campaign: CampaignRow;
  action: ServerAction;
}) {
  const marketingFetch = useMarketingFetch();
  const storeCampaign = useStoreCampaign();
  const copy = ACTION_COPY[action];
  const run = useMutation({
    mutationFn: async () => {
      const response = await marketingFetch<
        CampaignRow | { retried: number; campaign: CampaignRow }
      >(campaignPath(campaign, action), {
        method: 'POST',
        body: JSON.stringify({}),
      });
      return 'campaign' in response ? response.campaign : response;
    },
    onSuccess: (saved) => {
      toast.success(copy.done);
      storeCampaign(saved);
    },
    onError: (error) => toast.error(describeMarketingError(error)),
  });
  return (
    <Button
      disabled={run.isPending}
      loading={run.isPending}
      onClick={() =>
        showConfirm({
          title: `${copy.label} ${campaign.name}?`,
          text: copy.text,
          onConfirm: () => run.mutate(),
        })
      }
      type="button"
      variant={action === 'cancel' ? 'destructive' : 'outline'}
    >
      {copy.label}
    </Button>
  );
}

const ACTION_TO_SERVER = {
  pause: 'pause',
  resume: 'resume',
  cancel: 'cancel',
  retryUncertain: 'retry-uncertain',
} as const;

function Actions({ row }: { row: CampaignRow }) {
  const { isAdmin } = useMarketingRole();
  const actions = actionsFor(row.state, isAdmin, row.counters);
  const adminHasActions = actionsFor(row.state, true, row.counters).length > 0;
  if (!isAdmin && adminHasActions) {
    return <p className="text-muted-foreground text-xs">{NOT_ADMIN_NOTE}</p>;
  }
  if (actions.length === 0) {
    return null;
  }
  const showUncertainNote = actions.includes('retryUncertain');
  return (
    <div className="col gap-2">
      <div className="row flex-wrap items-center gap-2">
        {actions.map((action) => {
          if (action === 'unschedule') {
            return <UnscheduleButton campaign={row} key={action} />;
          }
          if (action in ACTION_TO_SERVER) {
            return (
              <ActionButton
                action={
                  ACTION_TO_SERVER[action as keyof typeof ACTION_TO_SERVER]
                }
                campaign={row}
                key={action}
              />
            );
          }
          return null;
        })}
      </div>
      {showUncertainNote && (
        <p className="text-muted-foreground text-xs">{UNCERTAIN_NOTE}</p>
      )}
    </div>
  );
}

function Counters({
  row,
  preSkipped,
}: {
  row: CampaignRow;
  preSkipped: number;
}) {
  const { total, done, percent } = progressOf(
    row.counters,
    row.state,
    preSkipped
  );
  const counters: [string, number][] = [
    ['To send', total],
    ['Sent', row.counters.sent],
    ['Failed', row.counters.failed],
    ['Skipped', row.counters.skipped],
    ['Uncertain', row.counters.uncertain],
  ];
  return (
    <div className="col gap-2">
      <Progress
        aria-label={`${done} of ${total} done`}
        size="lg"
        // 0 would render a stray "0" inside the bar
        value={percent || undefined}
      />
      <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
        {counters.map(([label, value]) => (
          <div className="col" key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-medium tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function useSkipReasons(row: CampaignRow) {
  const marketingFetch = useMarketingFetch();
  const queryKey = useMarketingQueryKey();
  return useQuery({
    // The state is in the key so the table is reloaded when the campaign settles.
    queryKey: queryKey('campaigns', row.id, 'skip-reasons', row.state),
    queryFn: () =>
      marketingFetch<SkipReasonsResponse>(
        `campaigns/${encodeURIComponent(row.id)}/skip-reasons`
      ),
    placeholderData: keepPreviousData,
    retry: false,
    refetchInterval: shouldPoll(row) ? CAMPAIGN_POLL_MS : false,
  });
}

function SkipReasons({
  reasons,
}: {
  reasons: ReturnType<typeof useSkipReasons>;
}) {
  if (reasons.error) {
    return (
      <p className="text-destructive text-sm" role="alert">
        {describeMarketingError(reasons.error)}
      </p>
    );
  }
  if (!reasons.data || reasons.data.reasons.length === 0) {
    return null;
  }
  return (
    <section className="col gap-2">
      <h3 className="font-medium">Why some were not sent</h3>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Status</TableHead>
            <TableHead>Reason</TableHead>
            <TableHead>Students</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {reasons.data.reasons.map((item) => (
            <TableRow key={`${item.status}:${item.reason}`}>
              <TableCell>{labelRecipientStatus(item.status)}</TableCell>
              <TableCell>{labelRecipientReason(item.reason)}</TableCell>
              <TableCell>{item.count}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

const formatTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString() : 'Not yet';

function CampaignBody({
  row,
  refreshError,
  onClose,
}: {
  row: CampaignRow;
  refreshError: unknown;
  onClose: () => void;
}) {
  const audiences = useAudiences();
  const skipReasons = useSkipReasons(row);
  const preSkipped = (skipReasons.data?.reasons ?? [])
    .filter((item) => item.reason === ALREADY_RECEIVED)
    .reduce((sum, item) => sum + item.count, 0);
  const badge = STATE_BADGE[row.state];
  const audienceName =
    audienceLabel(row.audienceId, {
      audiences: audiences.data?.audiences,
      failed: Boolean(audiences.error),
    }) || 'None';
  const status = waitingLine(row, Date.now()) ?? outcomeLine(row);
  const facts: [string, string][] = [
    ['Channel', CHANNEL_LABELS[row.channel]],
    ['Audience', audienceName],
    ['Send time', sendTimeText(row)],
    ['Started', formatTime(row.startedAt)],
    ['Finished', formatTime(row.finishedAt)],
  ];
  return (
    <div className="card col gap-4 p-4">
      <div className="row items-center gap-2">
        <h2 className="font-medium text-lg">{row.name}</h2>
        <Badge variant={badge.variant}>{badge.label}</Badge>
      </div>
      {refreshError ? (
        <p className="text-destructive text-sm" role="alert">
          Could not refresh: {describeMarketingError(refreshError)}
        </p>
      ) : null}
      <dl className="grid grid-cols-[10rem_1fr] gap-2 text-sm">
        {facts.map(([label, value]) => (
          <div className="contents" key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <Counters preSkipped={preSkipped} row={row} />
      {status && <p className="text-sm">{status}</p>}
      <div className="row items-center gap-2">
        <Actions row={row} />
        <Button onClick={onClose} variant="ghost">
          Back to campaigns
        </Button>
      </div>
      <SkipReasons reasons={skipReasons} />
      <CampaignRecipients campaignId={row.id} />
    </div>
  );
}

export function CampaignDetail({
  campaignId,
  onClose,
}: {
  campaignId: string;
  onClose: () => void;
}) {
  const campaign = useCampaign(campaignId);

  if (campaign.isPending) {
    return <FullPageLoadingState />;
  }
  if (campaign.error && !campaign.data) {
    return (
      <FullPageEmptyState
        description={describeMarketingError(campaign.error)}
        icon={MegaphoneIcon}
        title={campaignLoadErrorTitle(campaign.error)}
      >
        <Button onClick={onClose}>Back to campaigns</Button>
      </FullPageEmptyState>
    );
  }
  return (
    <CampaignBody
      onClose={onClose}
      refreshError={campaign.error}
      row={campaign.data}
    />
  );
}
