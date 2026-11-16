import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  describeMarketingError,
  useMarketingFetch,
  useMarketingQueryKey,
} from './api';
import { RECIPIENT_STATUSES, type RecipientsPage } from './campaign-contract';
import { labelRecipientReason, labelRecipientStatus } from './reason-labels';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const PAGE_SIZE = 100;
const ALL_STATUSES = 'all';
const STATUS_FILTER_ID = 'recipient-status-filter';

export function CampaignRecipients({ campaignId }: { campaignId: string }) {
  const marketingFetch = useMarketingFetch();
  const queryKey = useMarketingQueryKey();
  const [shown, setShown] = useState(false);
  const [status, setStatus] = useState(ALL_STATUSES);
  const recipients = useInfiniteQuery({
    enabled: shown,
    queryKey: queryKey('campaigns', campaignId, 'recipients', status),
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (status !== ALL_STATUSES) {
        params.set('status', status);
      }
      if (pageParam) {
        params.set('cursor', pageParam);
      }
      return marketingFetch<RecipientsPage>(
        `campaigns/${encodeURIComponent(campaignId)}/recipients?${params}`
      );
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    retry: false,
    // Refreshed on request only, so rows do not jump while the operator reads.
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
  const rows = recipients.data?.pages.flatMap((page) => page.recipients) ?? [];

  return (
    <section className="col gap-3">
      <div className="row items-end justify-between gap-2">
        <h3 className="font-medium">Recipients</h3>
        {shown ? (
          <div className="row items-end gap-2">
            <div className="col gap-1">
              <label
                className="text-muted-foreground text-xs"
                htmlFor={STATUS_FILTER_ID}
              >
                Show only
              </label>
              <Select onValueChange={setStatus} value={status}>
                <SelectTrigger id={STATUS_FILTER_ID}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_STATUSES}>All statuses</SelectItem>
                  {RECIPIENT_STATUSES.map((option) => (
                    <SelectItem key={option} value={option}>
                      {labelRecipientStatus(option)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              disabled={recipients.isFetching}
              loading={recipients.isFetching && !recipients.isFetchingNextPage}
              onClick={() => recipients.refetch()}
              type="button"
              variant="outline"
            >
              Refresh
            </Button>
          </div>
        ) : (
          <Button
            onClick={() => setShown(true)}
            type="button"
            variant="outline"
          >
            Show recipients
          </Button>
        )}
      </div>
      {recipients.error && (
        <p className="text-destructive text-sm" role="alert">
          {describeMarketingError(recipients.error)}
        </p>
      )}
      {shown && recipients.isSuccess && rows.length === 0 && (
        <p className="text-muted-foreground text-sm">No recipients match.</p>
      )}
      {rows.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Student id</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Attempts</TableHead>
              <TableHead>Provider reference</TableHead>
              <TableHead>Time</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.profileId}>
                <TableCell>{row.profileId}</TableCell>
                <TableCell>{labelRecipientStatus(row.status)}</TableCell>
                <TableCell>
                  {row.reason ? labelRecipientReason(row.reason) : ''}
                </TableCell>
                <TableCell>{row.attempt}</TableCell>
                <TableCell>{row.providerRef ?? ''}</TableCell>
                <TableCell>
                  {new Date(row.sentAt ?? row.updatedAt).toLocaleString()}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {recipients.hasNextPage && (
        <Button
          loading={recipients.isFetchingNextPage}
          onClick={() => recipients.fetchNextPage()}
          type="button"
          variant="outline"
        >
          Load more
        </Button>
      )}
    </section>
  );
}
