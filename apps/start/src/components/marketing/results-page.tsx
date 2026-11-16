import { useQuery } from '@tanstack/react-query';
import { BarChart3Icon } from 'lucide-react';
import { useState } from 'react';
import {
  describeMarketingError,
  useMarketingFetch,
  useMarketingQueryKey,
} from './api';
import type { CampaignRow } from './campaign-contract';
import { CampaignReport } from './campaign-report';
import type { RuleResult } from './contract';
import { JourneyReport } from './journey-report';
import { FullPageEmptyState } from '@/components/full-page-empty-state';
import FullPageLoadingState from '@/components/full-page-loading-state';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const percent = new Intl.NumberFormat(undefined, {
  style: 'percent',
  maximumFractionDigits: 1,
});

const COLUMNS: { key: Exclude<keyof RuleResult, 'goalKind'>; label: string }[] =
  [
    { key: 'enrolled', label: 'Enrolled' },
    { key: 'messaged', label: 'Messaged' },
    { key: 'sent', label: 'Sent' },
    { key: 'completedAfterSend', label: 'Completed after send' },
    { key: 'skipped', label: 'Skipped' },
    { key: 'failed', label: 'Failed' },
  ];

type OpenReport =
  | { kind: 'journey'; id: string; name: string }
  | { kind: 'campaign'; id: string; name: string };

function OpenRowButton({ name, onOpen }: { name: string; onOpen: () => void }) {
  return (
    <button
      aria-label={`Open report for ${name}`}
      className="text-left font-medium hover:underline"
      onClick={onOpen}
      type="button"
    >
      {name}
    </button>
  );
}

function CampaignResults({
  onOpen,
}: {
  onOpen: (campaign: CampaignRow) => void;
}) {
  const marketingFetch = useMarketingFetch();
  const queryKey = useMarketingQueryKey();
  const campaigns = useQuery({
    queryKey: queryKey('campaigns'),
    queryFn: () => marketingFetch<{ campaigns: CampaignRow[] }>('campaigns'),
  });
  return (
    <section className="card col gap-2 p-4">
      <h2 className="font-medium">Campaigns</h2>
      {campaigns.isPending && (
        <p className="text-muted-foreground text-sm">Loading campaigns...</p>
      )}
      {campaigns.error && (
        <p className="text-sm">
          Campaigns could not be loaded:{' '}
          {describeMarketingError(campaigns.error)}
        </p>
      )}
      {campaigns.data && campaigns.data.campaigns.length === 0 && (
        <p className="text-muted-foreground text-sm">No campaigns yet.</p>
      )}
      {campaigns.data && campaigns.data.campaigns.length > 0 && (
        <ul className="col gap-1 text-sm">
          {campaigns.data.campaigns.map((campaign) => (
            <li key={campaign.id}>
              <OpenRowButton
                name={campaign.name}
                onOpen={() => onOpen(campaign)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function ResultsPage() {
  const [open, setOpen] = useState<OpenReport | null>(null);
  const close = () => setOpen(null);
  if (open?.kind === 'journey') {
    return <JourneyReport name={open.name} onClose={close} ruleId={open.id} />;
  }
  if (open?.kind === 'campaign') {
    return (
      <CampaignReport campaignId={open.id} name={open.name} onClose={close} />
    );
  }
  return (
    <div className="col gap-4">
      <JourneyResults
        onOpen={(result) =>
          setOpen({ kind: 'journey', id: result.ruleId, name: result.name })
        }
      />
      <CampaignResults
        onOpen={(campaign) =>
          setOpen({ kind: 'campaign', id: campaign.id, name: campaign.name })
        }
      />
    </div>
  );
}

function JourneyResults({ onOpen }: { onOpen: (result: RuleResult) => void }) {
  const marketingFetch = useMarketingFetch();
  const queryKey = useMarketingQueryKey();
  const results = useQuery({
    queryKey: queryKey('results'),
    queryFn: () => marketingFetch<{ results: RuleResult[] }>('results'),
  });

  if (results.isPending) {
    return <FullPageLoadingState />;
  }
  if (results.error) {
    return (
      <FullPageEmptyState
        description={describeMarketingError(results.error)}
        icon={BarChart3Icon}
        title="Results are not available"
      />
    );
  }
  if (results.data.results.length === 0) {
    return (
      <FullPageEmptyState
        description="Create a rule to see how many profiles it messages and how many reach the goal."
        icon={BarChart3Icon}
        title="No results yet"
      />
    );
  }
  return (
    <div className="card">
      <Table>
        <TableCaption className="p-4 text-left">
          "Completed after send" counts journeys that reached the goal while
          they were running, after at least one message was sent. A goal reached
          after the final step, or by a journey still running, is not counted,
          and a count does not prove the message caused the goal. Rules with an
          inactivity goal have no goal event, so their conversion shows a dash.
          Journeys that ended before the plugin recorded end reasons count as
          not converted.
        </TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>Rule</TableHead>
            {COLUMNS.map((column) => (
              <TableHead className="text-right" key={column.key}>
                {column.label}
              </TableHead>
            ))}
            <TableHead className="text-right">Conversion</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {results.data.results.map((result) => (
            <TableRow key={result.ruleId}>
              <TableCell>
                <OpenRowButton
                  name={result.name}
                  onOpen={() => onOpen(result)}
                />
              </TableCell>
              {COLUMNS.map((column) => (
                <TableCell className="text-right tabular-nums" key={column.key}>
                  {result[column.key]}
                </TableCell>
              ))}
              <TableCell className="text-right tabular-nums">
                {result.goalKind === 'inactivity'
                  ? '—'
                  : percent.format(result.conversionRate)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
