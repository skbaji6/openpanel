import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  describeMarketingError,
  MarketingApiError,
  useMarketingFetch,
  useMarketingQueryKey,
} from './api';
import type {
  AudienceCount,
  CampaignRow,
  Confirmation,
  Estimate,
  TestSendsResponse,
} from './campaign-contract';
import { CHANNEL_LABELS } from './campaign-form';
import {
  confirmFromError,
  formatCost,
  formatDuration,
  labelEstimateIssue,
  launchAction,
  launchSteps,
  PREVIEW_TTL_MS,
  previewIsFresh,
  startConfirmation,
  startHint,
  testSendIdProblem,
  testSendIsPending,
} from './campaign-launch';
import { CAMPAIGN_POLL_MS } from './polling';
import { labelTestSendReason, labelTestSendStatus } from './reason-labels';
import { useAudiences, useRefreshCampaign } from './use-campaign';
import { NOT_ADMIN_NOTE, useMarketingRole } from './use-marketing-role';
import { InputWithLabel } from '@/components/forms/input-with-label';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useAppParams } from '@/hooks/use-app-params';
import { showConfirm, useOnPushModal } from '@/modals';

const QUEUED_TOAST =
  'Queued: starts when the campaign that is sending now finishes';

function launchToast(path: string, saved: CampaignRow): string {
  if (saved.state === 'scheduled' && saved.sendKind === 'now') {
    return QUEUED_TOAST;
  }
  return path === 'start' ? 'Campaign started' : 'Campaign scheduled';
}

const RECOUNT_NOTE =
  'The number of students changed or the count is out of date. Counting again…';
const RECOUNTED_NOTE = 'Counted again. Check the new number and start again.';

export const campaignPath = (campaign: CampaignRow, action: string) =>
  `campaigns/${encodeURIComponent(campaign.id)}/${action}`;

export function useStoreCampaign() {
  const queryKey = useMarketingQueryKey();
  const client = useQueryClient();
  return (saved: CampaignRow) => {
    client.setQueryData(queryKey('campaigns', saved.id), saved);
    client.invalidateQueries({ queryKey: queryKey('campaigns'), exact: true });
  };
}

function Step({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={title} className="col gap-2 border-t p-4">
      <h4 className="font-medium text-sm">{`${number}. ${title}`}</h4>
      {children}
    </section>
  );
}

function ChannelsTabLink() {
  const { organizationId, projectId } = useAppParams();
  return (
    <Link
      params={{ organizationId, projectId }}
      rel="noopener noreferrer"
      target="_blank"
      to="/$organizationId/$projectId/marketing/channels"
    >
      <u>Channels tab (opens in a new tab)</u>
    </Link>
  );
}

function AdminOnlyNote() {
  return <p className="text-muted-foreground text-xs">{NOT_ADMIN_NOTE}</p>;
}

function CountStep({
  campaign,
  fresh,
  freshnessUnknown,
  counting,
  onCount,
}: {
  campaign: CampaignRow;
  fresh: boolean;
  freshnessUnknown: boolean;
  counting: boolean;
  onCount: () => void;
}) {
  const preview = campaign.countPreview;
  return (
    <Step number={1} title="Count">
      <p className="text-muted-foreground text-xs">
        Counts the students this campaign would reach right now. Starting needs
        a count from the last 15 minutes.
      </p>
      {preview && (
        <dl className="grid grid-cols-[10rem_1fr] gap-1 text-sm">
          <dt className="text-muted-foreground">Students</dt>
          <dd>{`${preview.count}${preview.approximate ? ' (approximate)' : ''}`}</dd>
          {preview.filterCount !== null && (
            <>
              <dt className="text-muted-foreground">Matched the filter</dt>
              <dd>{preview.filterCount}</dd>
            </>
          )}
          <dt className="text-muted-foreground">Added by id</dt>
          <dd>{preview.includeCount}</dd>
          <dt className="text-muted-foreground">Left out by id</dt>
          <dd>{preview.excludeCount}</dd>
          <dt className="text-muted-foreground">Counted at</dt>
          <dd>{new Date(preview.countedAt).toLocaleString()}</dd>
        </dl>
      )}
      {freshnessUnknown && (
        <p className="text-destructive text-sm">
          The audience could not be loaded, so the age of this count cannot be
          checked. Reload the page, or count again.
        </p>
      )}
      {preview && !(fresh || freshnessUnknown) && (
        <p className="text-destructive text-sm">
          This count is out of date. Count again before starting.
        </p>
      )}
      <div>
        <Button loading={counting} onClick={onCount} type="button">
          {preview ? 'Count again' : 'Count students'}
        </Button>
      </div>
    </Step>
  );
}

function EstimateStep({
  estimate,
  error,
  loading,
}: {
  estimate: Estimate | undefined;
  error: unknown;
  loading: boolean;
}) {
  return (
    <Step number={2} title="Estimate">
      {!(estimate || error || loading) && (
        <p className="text-muted-foreground text-sm">
          Shown after a fresh count.
        </p>
      )}
      {loading && <p className="text-muted-foreground text-sm">Estimating…</p>}
      {Boolean(error) && (
        <p className="text-destructive text-sm" role="alert">
          {describeMarketingError(error)}
        </p>
      )}
      {estimate && <EstimateFacts estimate={estimate} />}
    </Step>
  );
}

function EstimateFacts({ estimate }: { estimate: Estimate }) {
  const { quota } = estimate;
  return (
    <div className="col gap-2 text-sm">
      <p>
        {estimate.estimatedSeconds === null
          ? 'No sending speed is set for this channel, so the time cannot be estimated.'
          : `About ${formatDuration(estimate.estimatedSeconds)} at ${estimate.ratePerSecond} messages per second.`}
      </p>
      {estimate.cost && <p>{`Cost: about ${formatCost(estimate.cost)}`}</p>}
      {quota && (
        <p>
          {`Daily email quota: ${quota.usedToday} of ${quota.dailyQuota} used today, ${quota.remainingToday} left. This campaign needs ${quota.daysNeeded} ${quota.daysNeeded === 1 ? 'day' : 'days'}.`}
        </p>
      )}
      {estimate.issues.length > 0 && (
        <div className="col gap-1 text-destructive" role="alert">
          <ul className="list-disc pl-5">
            {estimate.issues.map((issue) => (
              <li key={issue}>{labelEstimateIssue(issue)}</li>
            ))}
          </ul>
          <p>
            Fix these in the <ChannelsTabLink />.
          </p>
        </div>
      )}
    </div>
  );
}

function TestSendForm({
  campaign,
  onQueued,
}: {
  campaign: CampaignRow;
  onQueued: () => void;
}) {
  const marketingFetch = useMarketingFetch();
  const [studentId, setStudentId] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const send = useMutation({
    mutationFn: (profileId: string) =>
      marketingFetch<{ id: string }>(campaignPath(campaign, 'test-send'), {
        method: 'POST',
        body: JSON.stringify({ profileId }),
      }),
    onSuccess: () => {
      toast.success('Test queued');
      setStudentId('');
      onQueued();
    },
    onError: (error) => toast.error(describeMarketingError(error)),
  });
  return (
    <form
      className="col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const found = testSendIdProblem(studentId);
        setProblem(found);
        if (!(found || send.isPending)) {
          send.mutate(studentId.trim());
        }
      }}
    >
      <InputWithLabel
        autoComplete="off"
        error={problem ?? undefined}
        hint="The id of a student in your audience API. This sends a real message to that student."
        label="Student id"
        onChange={(event) => setStudentId(event.target.value)}
        value={studentId}
      />
      <div>
        <Button loading={send.isPending} type="submit" variant="outline">
          Send test
        </Button>
      </div>
    </form>
  );
}

function TestSendsTable({ response }: { response: TestSendsResponse }) {
  if (response.testSends.length === 0) {
    return null;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Student id</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Reason</TableHead>
          <TableHead>Requested</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {response.testSends.map((row) => (
          <TableRow key={row.id}>
            <TableCell>{row.profileId}</TableCell>
            <TableCell>{labelTestSendStatus(row.status)}</TableCell>
            <TableCell>
              {row.reason ? labelTestSendReason(row.reason) : ''}
            </TableCell>
            <TableCell>{new Date(row.createdAt).toLocaleString()}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function TestStep({
  campaign,
  isAdmin,
  testSends,
  onQueued,
}: {
  campaign: CampaignRow;
  isAdmin: boolean;
  testSends: TestSendsResponse | undefined;
  onQueued: () => void;
}) {
  return (
    <Step number={3} title="Send a test">
      <p className="text-muted-foreground text-xs">
        Sends this campaign's message to that one student. Quiet hours and
        limits do not apply to a test.
      </p>
      {isAdmin ? (
        <TestSendForm campaign={campaign} onQueued={onQueued} />
      ) : (
        <AdminOnlyNote />
      )}
      {testSends && <TestSendsTable response={testSends} />}
    </Step>
  );
}

// Two guards: the ref stops a second request while one is in flight, the dialog flag stops a
// second dialog. The dialog closes before its onConfirm runs, so a confirmed resend skips the dialog guard.
function LaunchStep({
  campaign,
  onRecount,
  fresh,
  counting,
}: {
  campaign: CampaignRow;
  onRecount: () => void;
  fresh: boolean;
  counting: boolean;
}) {
  const marketingFetch = useMarketingFetch();
  const storeCampaign = useStoreCampaign();
  const refreshCampaign = useRefreshCampaign();
  const action = launchAction(campaign);
  const inFlight = useRef(false);
  const dialogOpen = useRef(false);
  const [pending, setPending] = useState(false);
  const [dialogShown, setDialogShown] = useState(false);

  useOnPushModal('Confirm', (open) => {
    if (!open) {
      dialogOpen.current = false;
      setDialogShown(false);
    }
  });

  const ask = (title: string, text: string, confirm: Confirmation) => {
    dialogOpen.current = true;
    setDialogShown(true);
    showConfirm({ title, text, onConfirm: () => send(confirm) });
  };

  const handleError = (error: unknown, sent: Confirmation) => {
    const decision =
      error instanceof MarketingApiError ? confirmFromError(error, sent) : null;
    if (!decision) {
      toast.error(describeMarketingError(error));
      refreshCampaign(campaign.id);
      return;
    }
    if (decision.kind === 'recount') {
      toast.info(RECOUNT_NOTE);
      onRecount();
      return;
    }
    const channelName = CHANNEL_LABELS[decision.channel];
    ask(
      `Only ${decision.remainingToday} emails are left today. Spread over ${decision.daysNeeded} days?`,
      `${decision.count} students will get this campaign by ${channelName}, spread over ${decision.daysNeeded} days by the daily quota.`,
      { count: decision.count, channel: decision.channel, spreadOverDays: true }
    );
  };

  async function send(confirm: Confirmation) {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setPending(true);
    let failure: unknown = null;
    let saved: CampaignRow | null = null;
    try {
      saved = await marketingFetch<CampaignRow>(
        campaignPath(campaign, action.path),
        { method: 'POST', body: JSON.stringify({ confirm }) }
      );
    } catch (error) {
      failure = error;
    } finally {
      inFlight.current = false;
      setPending(false);
    }
    if (saved) {
      toast.success(launchToast(action.path, saved));
      storeCampaign(saved);
      return;
    }
    handleError(failure, confirm);
  }

  const hint = startHint(campaign, fresh);

  const begin = () => {
    const plan = startConfirmation(campaign, fresh);
    if (!plan || inFlight.current || dialogOpen.current) {
      return;
    }
    ask(plan.title, plan.text, plan.confirm);
  };

  return (
    <Step number={4} title={action.title}>
      <p className="text-muted-foreground text-xs">
        Asks you to confirm the counted number of students, then runs the checks
        again on the server.
      </p>
      <div>
        <Button
          disabled={dialogShown || counting || hint !== null}
          loading={pending}
          onClick={begin}
          type="button"
        >
          {action.label}
        </Button>
      </div>
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
    </Step>
  );
}

export function CampaignLaunchPanel({ campaign }: { campaign: CampaignRow }) {
  const marketingFetch = useMarketingFetch();
  const queryKey = useMarketingQueryKey();
  const client = useQueryClient();
  const { isAdmin } = useMarketingRole();
  const audiences = useAudiences();
  const audienceVersion =
    audiences.data?.audiences.find((row) => row.id === campaign.audienceId)
      ?.version ?? null;
  const fresh = previewIsFresh(campaign, Date.now(), audienceVersion);
  const freshnessUnknown =
    audiences.data === undefined &&
    Boolean(audiences.error) &&
    campaign.countPreview !== null;
  const [, setExpiredAt] = useState(0);
  const countedAt = campaign.countPreview?.countedAt;

  // Re-render when the preview ages out, so the tick and the estimate go away on time.
  useEffect(() => {
    if (!(fresh && countedAt)) {
      return;
    }
    const remaining = Date.parse(countedAt) + PREVIEW_TTL_MS - Date.now();
    const timer = setTimeout(() => setExpiredAt(Date.now()), remaining + 1);
    return () => clearTimeout(timer);
  }, [fresh, countedAt]);
  const campaignKey = queryKey('campaigns', campaign.id);

  const count = useMutation({
    mutationFn: () =>
      marketingFetch<AudienceCount>(campaignPath(campaign, 'count-preview'), {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    // The preview is stored on the campaign without a version bump; reload both so freshness is current.
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: campaignKey, exact: true }),
        client.invalidateQueries({ queryKey: queryKey('audiences') }),
      ]),
    onError: (error) => toast.error(describeMarketingError(error)),
  });

  const estimate = useQuery({
    queryKey: [
      ...campaignKey,
      'estimate',
      campaign.countPreview?.countedAt ?? '',
    ],
    queryFn: () =>
      marketingFetch<Estimate>(campaignPath(campaign, 'estimate'), {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    enabled: fresh,
    retry: false,
    // Channel settings are fixed in another tab; coming back must re-estimate.
    staleTime: 0,
    refetchOnWindowFocus: 'always',
  });

  const testSendsKey = [...campaignKey, 'test-sends'];
  const testSends = useQuery({
    queryKey: testSendsKey,
    queryFn: () =>
      marketingFetch<TestSendsResponse>(campaignPath(campaign, 'test-sends')),
    refetchInterval: (query) =>
      testSendIsPending(query.state.data?.testSends ?? [])
        ? CAMPAIGN_POLL_MS
        : false,
  });

  const shownEstimate = fresh ? (estimate.data ?? null) : null;
  const steps = launchSteps(campaign, shownEstimate, Date.now(), {
    audienceVersion,
    testSends: testSends.data?.testSends,
  });

  return (
    <section aria-label="Check and send" className="card col">
      <div className="col gap-2 p-4">
        <h3 className="font-medium text-lg">Check and send</h3>
        <ul className="col gap-1 text-sm">
          {steps.map((step) => (
            <li
              className={step.done ? '' : 'text-muted-foreground'}
              key={step.key}
            >
              {`${step.done ? '✓' : '○'} ${step.note}`}
            </li>
          ))}
        </ul>
      </div>
      <CountStep
        campaign={campaign}
        counting={count.isPending}
        fresh={fresh}
        freshnessUnknown={freshnessUnknown}
        onCount={() => count.mutate()}
      />
      <EstimateStep
        error={fresh ? estimate.error : null}
        estimate={shownEstimate ?? undefined}
        loading={fresh && estimate.isFetching}
      />
      <TestStep
        campaign={campaign}
        isAdmin={isAdmin}
        onQueued={() => client.invalidateQueries({ queryKey: testSendsKey })}
        testSends={testSends.data}
      />
      {isAdmin ? (
        <LaunchStep
          campaign={campaign}
          counting={count.isPending}
          fresh={fresh}
          onRecount={() =>
            count.mutate(undefined, {
              onSuccess: () => toast.info(RECOUNTED_NOTE),
            })
          }
        />
      ) : (
        <Step number={4} title={launchAction(campaign).title}>
          <AdminOnlyNote />
        </Step>
      )}
    </section>
  );
}

export function UnscheduleButton({ campaign }: { campaign: CampaignRow }) {
  const marketingFetch = useMarketingFetch();
  const storeCampaign = useStoreCampaign();
  const refreshCampaign = useRefreshCampaign();
  const { isAdmin } = useMarketingRole();
  const unschedule = useMutation({
    mutationFn: () =>
      marketingFetch<CampaignRow>(campaignPath(campaign, 'unschedule'), {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    onSuccess: (saved) => {
      toast.success('Campaign unscheduled; it is a draft again');
      storeCampaign(saved);
    },
    onError: (error) => {
      toast.error(describeMarketingError(error));
      refreshCampaign(campaign.id);
    },
  });
  if (!isAdmin) {
    return (
      <div className="row items-center gap-2">
        <Button disabled type="button" variant="outline">
          Unschedule
        </Button>
        <AdminOnlyNote />
      </div>
    );
  }
  return (
    <Button
      disabled={unschedule.isPending}
      loading={unschedule.isPending}
      onClick={() =>
        showConfirm({
          title: `Unschedule ${campaign.name}?`,
          text: 'The campaign goes back to a draft and will not send until you start or schedule it again.',
          onConfirm: () => unschedule.mutate(),
        })
      }
      type="button"
      variant="outline"
    >
      Unschedule
    </Button>
  );
}
