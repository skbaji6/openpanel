import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { MessageSquareTextIcon, PlusIcon } from 'lucide-react';
import { toast } from 'sonner';
import {
  describeMarketingError,
  MarketingApiError,
  useMarketingFetch,
  useMarketingQueryKey,
} from './api';
import {
  isProviderChannel,
  REGISTRY_TEMPLATE_CHANNELS,
  type RegistryTemplateChannel,
  type TemplateRow,
} from './campaign-contract';
import { PushTemplateEditor, pushFormFromRow } from './push-template-editor';
import { inlineContent } from './step-variants';
import { formFromRow, TemplateEditor } from './template-editor';
import { emptyTemplate } from './template-form';
import { NOT_ADMIN_NOTE, useMarketingRole } from './use-marketing-role';
import { FullPageEmptyState } from '@/components/full-page-empty-state';
import FullPageLoadingState from '@/components/full-page-loading-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

const route = getRouteApi(
  '/_app/$organizationId/$projectId/marketing/_tabs/templates'
);

const CHANNEL_LABELS: Record<RegistryTemplateChannel, string> = {
  sms: 'SMS',
  whatsapp: 'WhatsApp',
  push: 'Push',
};

const isRegistryChannel = (
  channel: string | undefined
): channel is RegistryTemplateChannel =>
  REGISTRY_TEMPLATE_CHANNELS.some((candidate) => candidate === channel);

const NOT_FOUND = 404;

function templateLoadErrorTitle(error: unknown): string {
  const notFound =
    error instanceof MarketingApiError && error.status === NOT_FOUND;
  return notFound ? 'Template not found' : 'Could not load the template';
}

function pushMessage(row: TemplateRow): string {
  const content = inlineContent(row.content);
  return [content?.subject, content?.body].filter(Boolean).join(' - ');
}

function providerReference(row: TemplateRow): string {
  if (row.channel === 'push') {
    return pushMessage(row);
  }
  const ref = row.providerRef;
  if (typeof ref !== 'object' || ref === null) {
    return '';
  }
  const { flowId, templateName } = ref as Record<string, unknown>;
  return [flowId, templateName].find((id) => typeof id === 'string') ?? '';
}

function EnableButton({ row }: { row: TemplateRow }) {
  const marketingFetch = useMarketingFetch();
  const queryKey = useMarketingQueryKey();
  const client = useQueryClient();
  const toggle = useMutation({
    mutationFn: () =>
      marketingFetch<TemplateRow>(
        `templates/${encodeURIComponent(row.templateId)}/${row.enabled ? 'disable' : 'enable'}`,
        { method: 'POST' }
      ),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: queryKey('templates') }),
    onError: (error) => toast.error(describeMarketingError(error)),
  });
  return (
    <Button
      loading={toggle.isPending}
      onClick={() => toggle.mutate()}
      size="sm"
      variant="ghost"
    >
      {row.enabled ? 'Disable' : 'Enable'}
    </Button>
  );
}

export function TemplatesPage() {
  const marketingFetch = useMarketingFetch();
  const queryKey = useMarketingQueryKey();
  const { isAdmin } = useMarketingRole();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const linked = useQuery({
    queryKey: queryKey('templates', 'one', search.id ?? ''),
    queryFn: () =>
      marketingFetch<TemplateRow>(
        `templates/${encodeURIComponent(search.id ?? '')}`
      ),
    enabled: Boolean(search.id),
    retry: false,
  });
  const linkedChannel = linked.data?.channel;
  const channel: RegistryTemplateChannel = isRegistryChannel(linkedChannel)
    ? linkedChannel
    : (search.channel ?? 'sms');
  const templates = useQuery({
    queryKey: queryKey('templates', channel),
    queryFn: () =>
      marketingFetch<{ templates: TemplateRow[] }>(
        `templates?channel=${channel}`
      ),
  });
  const close = () => navigate({ search: { channel } });

  if (search.new && isAdmin) {
    return channel === 'push' ? (
      <PushTemplateEditor
        initial={emptyTemplate('push')}
        isAdmin={isAdmin}
        onClose={close}
      />
    ) : (
      <TemplateEditor
        initial={emptyTemplate(channel)}
        isAdmin={isAdmin}
        onClose={close}
      />
    );
  }
  if (search.id && linked.isPending) {
    return <FullPageLoadingState />;
  }
  if (search.id && linked.error && !linked.data) {
    return (
      <FullPageEmptyState
        description={describeMarketingError(linked.error)}
        icon={MessageSquareTextIcon}
        title={templateLoadErrorTitle(linked.error)}
      >
        <Button onClick={close}>Back to templates</Button>
      </FullPageEmptyState>
    );
  }
  if (search.id && linked.data?.channel === 'push') {
    return (
      <PushTemplateEditor
        initial={pushFormFromRow(linked.data)}
        isAdmin={isAdmin}
        key={linked.data.templateId}
        onClose={close}
        row={linked.data}
      />
    );
  }
  if (search.id && linked.data && isProviderChannel(linked.data.channel)) {
    return (
      <TemplateEditor
        initial={formFromRow(linked.data)}
        isAdmin={isAdmin}
        key={linked.data.templateId}
        onClose={close}
        row={linked.data}
      />
    );
  }

  if (search.id && linked.data) {
    return (
      <FullPageEmptyState
        description="This template is not edited on this tab yet."
        icon={MessageSquareTextIcon}
        title="Template cannot be edited here"
      >
        <Button onClick={close}>Back to templates</Button>
      </FullPageEmptyState>
    );
  }

  const rows = templates.data?.templates ?? [];
  return (
    <div className="col gap-4">
      <div className="row items-center justify-between gap-2">
        <div aria-label="Channel" className="row gap-2" role="group">
          {REGISTRY_TEMPLATE_CHANNELS.map((option) => (
            <Button
              aria-pressed={option === channel}
              key={option}
              onClick={() => navigate({ search: { channel: option } })}
              variant={option === channel ? 'default' : 'outline'}
            >
              {CHANNEL_LABELS[option]}
            </Button>
          ))}
        </div>
        {isAdmin ? (
          <Button
            icon={PlusIcon}
            onClick={() => navigate({ search: { channel, new: true } })}
          >
            Add template
          </Button>
        ) : (
          <p className="text-muted-foreground text-xs">{NOT_ADMIN_NOTE}</p>
        )}
      </div>
      {templates.isPending && <FullPageLoadingState />}
      {templates.error && (
        <FullPageEmptyState
          description={describeMarketingError(templates.error)}
          icon={MessageSquareTextIcon}
          title={
            templates.data
              ? 'Could not refresh templates'
              : 'Templates are not available'
          }
        />
      )}
      {templates.data && rows.length === 0 && (
        <FullPageEmptyState
          description={
            channel === 'push'
              ? 'Write a push title and body here, then pick it in a journey step or a campaign.'
              : `Record a provider-approved ${CHANNEL_LABELS[channel]} template here, then pick it in a campaign.`
          }
          icon={MessageSquareTextIcon}
          title="No templates yet"
        />
      )}
      {rows.length > 0 && (
        <table className="w-full text-left text-sm">
          <thead className="text-muted-foreground">
            <tr>
              <th className="p-2">Name</th>
              <th className="p-2">Category</th>
              <th className="p-2">
                {channel === 'push' ? 'Message' : 'Provider reference'}
              </th>
              <th className="p-2">Version</th>
              <th className="p-2">Status</th>
              <th className="p-2">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr className="border-t" key={row.templateId}>
                <td className="p-2">{row.displayName}</td>
                <td className="p-2">{row.category}</td>
                <td className="p-2">{providerReference(row)}</td>
                <td className="p-2">{row.currentVersion}</td>
                <td className="p-2">
                  <Badge variant={row.enabled ? 'success' : 'secondary'}>
                    {row.enabled ? 'Enabled' : 'Disabled'}
                  </Badge>
                </td>
                <td className="row justify-end gap-1 p-2">
                  <Button
                    onClick={() =>
                      navigate({ search: { channel, id: row.templateId } })
                    }
                    size="sm"
                    variant="ghost"
                  >
                    {isAdmin ? 'Edit' : 'View'}
                  </Button>
                  {isAdmin && <EnableButton row={row} />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
