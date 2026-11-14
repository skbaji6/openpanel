import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { PlusIcon, UsersIcon } from 'lucide-react';
import { toast } from 'sonner';
import {
  describeMarketingError,
  MarketingApiError,
  useMarketingFetch,
  useMarketingQueryKey,
} from './api';
import { AudienceEditor } from './audience-editor';
import { formatCount } from './audience-filter';
import type { AudienceRow, AudienceSchema } from './campaign-contract';
import { useMarketingRole } from './use-marketing-role';
import { FullPageEmptyState } from '@/components/full-page-empty-state';
import FullPageLoadingState from '@/components/full-page-loading-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useAppParams } from '@/hooks/use-app-params';
import { showConfirm } from '@/modals';

const route = getRouteApi(
  '/_app/$organizationId/$projectId/marketing/_tabs/audiences'
);

const NOT_ADMIN_NOTE = 'Only owners and admins can delete audiences';
const NOT_CONNECTED_CODES = new Set([
  'source_not_http',
  'source_not_configured',
]);
const MODE_LABELS: Record<AudienceRow['mode'], string> = {
  dynamic: 'Dynamic',
  snapshot: 'Snapshot',
};

function ConnectSourceLink() {
  const { organizationId, projectId } = useAppParams();
  return (
    <Link
      params={{ organizationId, projectId }}
      to="/$organizationId/$projectId/marketing/channels"
    >
      <u>Channels tab</u>
    </Link>
  );
}

function DeleteButton({ row }: { row: AudienceRow }) {
  const marketingFetch = useMarketingFetch();
  const queryKey = useMarketingQueryKey();
  const client = useQueryClient();
  const remove = useMutation({
    mutationFn: () =>
      marketingFetch<null>(`audiences/${encodeURIComponent(row.id)}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      toast.success('Audience deleted');
      client.invalidateQueries({ queryKey: queryKey('audiences') });
    },
    onError: (error) => toast.error(describeMarketingError(error)),
  });
  return (
    <Button
      loading={remove.isPending}
      onClick={() =>
        showConfirm({
          title: `Delete ${row.name}?`,
          text: 'The audience and its lists are removed. This cannot be undone.',
          onConfirm: () => remove.mutate(),
        })
      }
      size="sm"
      variant="ghost"
    >
      Delete
    </Button>
  );
}

function snapshotText(row: AudienceRow): string {
  if (row.mode !== 'snapshot') {
    return '';
  }
  return row.snapshotAt
    ? new Date(row.snapshotAt).toLocaleString()
    : 'Not frozen';
}

function AudienceTable({
  rows,
  isAdmin,
  onOpen,
}: {
  rows: AudienceRow[];
  isAdmin: boolean;
  onOpen: (id: string) => void;
}) {
  return (
    <table className="w-full text-left text-sm">
      <thead className="text-muted-foreground">
        <tr>
          <th className="p-2">Name</th>
          <th className="p-2">Mode</th>
          <th className="p-2">Hand-picked</th>
          <th className="p-2">Left out</th>
          <th className="p-2">Snapshot</th>
          <th className="p-2">
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr className="border-t" key={row.id}>
            <td className="p-2">
              <span className="row items-center gap-2">
                {row.name}
                {row.inUse && <Badge variant="info">In use</Badge>}
              </span>
            </td>
            <td className="p-2">{MODE_LABELS[row.mode]}</td>
            <td className="p-2">{formatCount(row.includeCount)}</td>
            <td className="p-2">{formatCount(row.excludeCount)}</td>
            <td className="p-2">{snapshotText(row)}</td>
            <td className="row justify-end gap-1 p-2">
              <Button onClick={() => onOpen(row.id)} size="sm" variant="ghost">
                Open
              </Button>
              {isAdmin && <DeleteButton row={row} />}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function AudiencesPage() {
  const marketingFetch = useMarketingFetch();
  const queryKey = useMarketingQueryKey();
  const { isAdmin } = useMarketingRole();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const audiences = useQuery({
    queryKey: queryKey('audiences'),
    queryFn: () => marketingFetch<{ audiences: AudienceRow[] }>('audiences'),
  });
  const schema = useQuery({
    queryKey: queryKey('audience-schema'),
    queryFn: () => marketingFetch<AudienceSchema>('audience/schema'),
    retry: false,
  });
  const schemaState = {
    dimensions: schema.data?.dimensions ?? null,
    error: schema.error,
  };
  const close = () => navigate({ search: {} });
  const open = (id: string) => navigate({ search: { id } });

  if (search.new || search.id) {
    if (schema.isPending) {
      return <FullPageLoadingState />;
    }
    return (
      <AudienceEditor
        audienceId={search.id}
        key={search.id ?? 'new'}
        onClose={close}
        onSaved={open}
        schema={schemaState}
      />
    );
  }

  const rows = audiences.data?.audiences ?? [];
  const notConnected =
    schema.error instanceof MarketingApiError &&
    NOT_CONNECTED_CODES.has(schema.error.code);
  return (
    <div className="col gap-4">
      <div className="row items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">
          Who receives a campaign: students matched by filters, plus or minus
          hand-picked lists.
        </p>
        <div className="row items-center gap-3">
          {!isAdmin && (
            <p className="text-muted-foreground text-xs">{NOT_ADMIN_NOTE}</p>
          )}
          <Button
            icon={PlusIcon}
            onClick={() => navigate({ search: { new: true } })}
          >
            New audience
          </Button>
        </div>
      </div>
      {notConnected && rows.length > 0 && (
        <p className="rounded border p-3 text-sm">
          Filters and checks need the audience API. Connect it on the{' '}
          <ConnectSourceLink /> first.
        </p>
      )}
      {audiences.isPending && <FullPageLoadingState />}
      {audiences.error && (
        <FullPageEmptyState
          description={describeMarketingError(audiences.error)}
          icon={UsersIcon}
          title="Audiences are not available"
        />
      )}
      {audiences.data && rows.length === 0 && (
        <FullPageEmptyState
          description={
            notConnected
              ? 'Connect the audience API on the Channels tab first.'
              : 'Create an audience to choose who receives a campaign.'
          }
          icon={UsersIcon}
          title={notConnected ? 'No audience API yet' : 'No audiences yet'}
        >
          {notConnected && <ConnectSourceLink />}
        </FullPageEmptyState>
      )}
      {rows.length > 0 && (
        <AudienceTable isAdmin={isAdmin} onOpen={open} rows={rows} />
      )}
    </div>
  );
}
