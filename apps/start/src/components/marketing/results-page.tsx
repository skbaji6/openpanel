import { useQuery } from '@tanstack/react-query';
import { BarChart3Icon } from 'lucide-react';
import {
  describeMarketingError,
  useMarketingFetch,
  useMarketingQueryKey,
} from './api';
import type { RuleResult } from './contract';
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

export function ResultsPage() {
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
              <TableCell className="font-medium">{result.name}</TableCell>
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
