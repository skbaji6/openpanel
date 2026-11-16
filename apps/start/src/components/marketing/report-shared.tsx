import { type UseQueryResult, useQuery } from '@tanstack/react-query';
import { BarChart3Icon } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  describeMarketingError,
  MarketingApiError,
  useMarketingFetch,
  useMarketingQueryKey,
} from './api';
import { MESSAGE_STATUSES, type StatusCounts } from './contract';
import { browserTimeZone, statusLabel } from './report-view';
import { FullPageEmptyState } from '@/components/full-page-empty-state';
import FullPageLoadingState from '@/components/full-page-loading-state';
import { Button } from '@/components/ui/button';

export function useReport<T>(kind: 'campaigns' | 'journeys', id: string) {
  const marketingFetch = useMarketingFetch();
  const queryKey = useMarketingQueryKey();
  const timeZone = browserTimeZone();
  return useQuery({
    queryKey: queryKey('report', kind, id, timeZone),
    queryFn: () =>
      marketingFetch<T>(
        `reports/${kind}/${encodeURIComponent(id)}?tz=${encodeURIComponent(timeZone)}`
      ),
  });
}

export function ReportShell<T>({
  query,
  noun,
  onClose,
  children,
}: {
  query: UseQueryResult<T>;
  noun: string;
  onClose: () => void;
  children: (report: T) => ReactNode;
}) {
  if (query.isPending) {
    return <FullPageLoadingState />;
  }
  if (query.error) {
    const missing =
      query.error instanceof MarketingApiError && query.error.status === 404;
    return (
      <FullPageEmptyState
        description={
          missing
            ? `This ${noun} no longer exists, so there is no report for it.`
            : describeMarketingError(query.error)
        }
        icon={BarChart3Icon}
        title={missing ? 'Report not found' : 'The report is not available'}
      >
        <Button onClick={onClose}>Back to results</Button>
      </FullPageEmptyState>
    );
  }
  return (
    <div className="col gap-4">
      <div>
        <Button onClick={onClose}>Back to results</Button>
      </div>
      {children(query.data)}
    </div>
  );
}

export function StatusTable({ statuses }: { statuses: StatusCounts }) {
  return (
    <table className="w-full text-left text-sm">
      <caption className="sr-only">Messages by furthest status</caption>
      <thead>
        <tr>
          <th className="p-2" scope="col">
            Status
          </th>
          <th className="p-2 text-right" scope="col">
            Messages
          </th>
        </tr>
      </thead>
      <tbody>
        {MESSAGE_STATUSES.map((status) => (
          <tr className="border-t" key={status}>
            <th className="p-2 font-normal" scope="row">
              {statusLabel(status)}
            </th>
            <td className="p-2 text-right tabular-nums">{statuses[status]}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
