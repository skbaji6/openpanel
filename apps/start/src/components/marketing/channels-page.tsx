import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import {
  describeMarketingError,
  MarketingApiError,
  useMarketingFetch,
  useMarketingQueryKey,
} from './api';
import { AudienceSourceCard } from './audience-source-card';
import {
  type ApiIssue,
  CHANNELS,
  type Channel,
  type ChannelConfigResponse,
  type CreatedApiKey,
  SECRET_MASK,
} from './contract';
import CopyInput from '@/components/forms/copy-input';
import { InputWithLabel, WithLabel } from '@/components/forms/input-with-label';
import {
  IntegrationCardFooter,
  IntegrationCardHeader,
} from '@/components/integrations/integration-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

const DEFAULT_SMTP_PORT = '587';
const MAX_WEBHOOK_SECRETS = 2;

type FieldKind = 'text' | 'number' | 'boolean' | 'secret' | 'secretLines';

interface FieldSpec {
  name: string;
  label: string;
  kind: FieldKind;
  hint?: string;
  optional?: boolean;
}

// Mirrors each adapter's config shape; only the non-secret fields are returned in clear by the service.
const CHANNEL_FIELDS: Record<Channel, FieldSpec[]> = {
  email: [
    { name: 'host', label: 'SMTP host', kind: 'text' },
    { name: 'port', label: 'SMTP port', kind: 'number' },
    {
      name: 'secure',
      label: 'Use TLS from the start (port 465)',
      kind: 'boolean',
    },
    { name: 'user', label: 'SMTP user', kind: 'text', optional: true },
    { name: 'pass', label: 'SMTP password', kind: 'secret', optional: true },
    { name: 'from', label: 'From address', kind: 'text' },
  ],
  webhook: [
    { name: 'url', label: 'URL', kind: 'text', hint: 'Must be https.' },
    {
      name: 'secrets',
      label: 'Signing secrets',
      kind: 'secretLines',
      hint: 'One per line, at most two: the first signs, the second is accepted during rotation.',
    },
  ],
  push: [
    {
      name: 'serviceAccountJson',
      label: 'Firebase service account JSON',
      kind: 'secret',
    },
  ],
};

const CHANNEL_TITLES: Record<Channel, string> = {
  email: 'Email (SMTP)',
  webhook: 'Webhook',
  push: 'Push (Firebase Cloud Messaging)',
};

type FormValues = Record<string, string | boolean>;

function isSecret(field: FieldSpec): boolean {
  return field.kind === 'secret' || field.kind === 'secretLines';
}

function inputType(field: FieldSpec): string {
  if (isSecret(field)) {
    return 'password';
  }
  return field.kind === 'number' ? 'number' : 'text';
}

function initialValues(
  channel: Channel,
  config: Record<string, unknown> | null
) {
  const values: FormValues = {};
  const kept = new Set<string>();
  for (const field of CHANNEL_FIELDS[channel]) {
    const stored = config?.[field.name];
    if (isSecret(field)) {
      if (stored === SECRET_MASK) {
        kept.add(field.name);
      }
      values[field.name] = '';
    } else if (field.kind === 'boolean') {
      values[field.name] = stored === true;
    } else if (field.kind === 'number') {
      values[field.name] =
        typeof stored === 'number' ? String(stored) : DEFAULT_SMTP_PORT;
    } else {
      values[field.name] = typeof stored === 'string' ? stored : '';
    }
  }
  return { values, kept };
}

function fieldValue(
  field: FieldSpec,
  value: string | boolean,
  isKept: boolean
): unknown {
  if (isKept && value === '') {
    return SECRET_MASK;
  }
  if (field.kind === 'boolean') {
    return value === true;
  }
  const text = String(value);
  if (field.kind === 'number') {
    return Number(text);
  }
  if (field.kind === 'secretLines') {
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, MAX_WEBHOOK_SECRETS);
  }
  return field.optional && text === '' ? undefined : text;
}

function ChannelForm({
  channel,
  loaded,
}: {
  channel: Channel;
  loaded: ChannelConfigResponse;
}) {
  const marketingFetch = useMarketingFetch();
  const queryKey = useMarketingQueryKey();
  const client = useQueryClient();
  const formId = useId();
  const [initial] = useState(() => initialValues(channel, loaded.config));
  const [values, setValues] = useState(initial.values);
  const [serverIssues, setServerIssues] = useState<ApiIssue[]>([]);
  const fields = CHANNEL_FIELDS[channel];

  // The service only keeps a masked secret while every public field is unchanged.
  const publicChanged = fields.some(
    (field) =>
      !isSecret(field) && values[field.name] !== initial.values[field.name]
  );
  const mustReenter = (field: FieldSpec) =>
    initial.kept.has(field.name) && publicChanged && values[field.name] === '';
  const blocked = fields.some(mustReenter);

  const save = useMutation({
    mutationFn: () => {
      const config = Object.fromEntries(
        fields
          .map((field) => [
            field.name,
            fieldValue(
              field,
              values[field.name] ?? '',
              initial.kept.has(field.name)
            ),
          ])
          .filter(([, value]) => value !== undefined)
      );
      return marketingFetch<ChannelConfigResponse>(`channels/${channel}`, {
        method: 'PUT',
        body: JSON.stringify({ config }),
      });
    },
    onSuccess() {
      setServerIssues([]);
      toast.success(`${CHANNEL_TITLES[channel]} saved`);
      client.invalidateQueries({ queryKey: queryKey('channels', channel) });
    },
    onError(error) {
      setServerIssues(error instanceof MarketingApiError ? error.issues : []);
      toast.error(describeMarketingError(error));
    },
  });

  const errorFor = (field: FieldSpec) => {
    if (mustReenter(field)) {
      return 'Re-enter this secret because other settings changed';
    }
    return serverIssues.find((issue) => issue.path === `config.${field.name}`)
      ?.message;
  };

  const setValue = (name: string, value: string | boolean) =>
    setValues((current) => ({ ...current, [name]: value }));

  return (
    <form
      className="col gap-4"
      id={formId}
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <div className="col gap-4 p-4">
        {fields.map((field) => {
          const error = errorFor(field);
          const savedHint = initial.kept.has(field.name)
            ? 'Saved. Leave empty to keep it.'
            : undefined;
          if (field.kind === 'boolean') {
            return (
              <label
                className="row items-center gap-2 text-sm"
                htmlFor={`${formId}-${field.name}`}
                key={field.name}
              >
                <Switch
                  checked={values[field.name] === true}
                  id={`${formId}-${field.name}`}
                  onCheckedChange={(checked) => setValue(field.name, checked)}
                />
                {field.label}
              </label>
            );
          }
          const isMultiline =
            field.kind === 'secretLines' || field.name === 'serviceAccountJson';
          if (isMultiline) {
            return (
              <WithLabel
                error={error}
                hint={savedHint ?? field.hint}
                id={`${formId}-${field.name}`}
                key={field.name}
                label={field.label}
              >
                <Textarea
                  autoComplete="off"
                  id={`${formId}-${field.name}`}
                  onChange={(event) => setValue(field.name, event.target.value)}
                  placeholder={savedHint ? SECRET_MASK : undefined}
                  rows={4}
                  spellCheck={false}
                  value={String(values[field.name] ?? '')}
                />
              </WithLabel>
            );
          }
          return (
            <InputWithLabel
              autoComplete={isSecret(field) ? 'new-password' : 'off'}
              error={error}
              hint={savedHint ?? field.hint}
              key={field.name}
              label={field.label}
              onChange={(event) => setValue(field.name, event.target.value)}
              placeholder={savedHint ? SECRET_MASK : undefined}
              type={inputType(field)}
              value={String(values[field.name] ?? '')}
            />
          );
        })}
      </div>
      <IntegrationCardFooter className="justify-end">
        <Button disabled={blocked} loading={save.isPending} type="submit">
          Save
        </Button>
      </IntegrationCardFooter>
    </form>
  );
}

function ChannelCard({ channel }: { channel: Channel }) {
  const marketingFetch = useMarketingFetch();
  const queryKey = useMarketingQueryKey();
  const config = useQuery({
    queryKey: queryKey('channels', channel),
    queryFn: () => marketingFetch<ChannelConfigResponse>(`channels/${channel}`),
    retry: false,
  });
  return (
    <section aria-label={CHANNEL_TITLES[channel]} className="card">
      <IntegrationCardHeader className="items-center justify-between">
        <h2 className="title">{CHANNEL_TITLES[channel]}</h2>
        {config.data && (
          <Badge variant={config.data.configured ? 'success' : 'outline'}>
            {config.data.configured ? 'Configured' : 'Not configured'}
          </Badge>
        )}
      </IntegrationCardHeader>
      {config.error && (
        <p className="p-4 text-destructive text-sm">
          {describeMarketingError(config.error)}
        </p>
      )}
      {config.data && (
        <ChannelForm
          channel={channel}
          key={config.dataUpdatedAt}
          loaded={config.data}
        />
      )}
    </section>
  );
}

function ApiKeysCard() {
  const marketingFetch = useMarketingFetch();
  const [label, setLabel] = useState('');
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const create = useMutation({
    mutationFn: () =>
      marketingFetch<CreatedApiKey>('api-keys', {
        method: 'POST',
        body: JSON.stringify({ label }),
      }),
    onSuccess(key) {
      setCreated(key);
      setLabel('');
    },
    onError: (error) => toast.error(describeMarketingError(error)),
  });
  return (
    <section aria-label="Server API keys" className="card">
      <IntegrationCardHeader>
        <h2 className="title">Server API keys</h2>
      </IntegrationCardHeader>
      <form
        className="col gap-4 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <p className="text-muted-foreground text-sm">
          Your backend uses a key to sync contacts, push devices and reference
          sets. Never ship it in an app or website.
        </p>
        <InputWithLabel
          label="Key label"
          onChange={(event) => setLabel(event.target.value)}
          placeholder="Production backend"
          value={label}
        />
        <Button
          className="self-start"
          disabled={label.trim() === ''}
          loading={create.isPending}
          type="submit"
        >
          Create key
        </Button>
        {created && (
          <div className="col gap-2" role="status">
            <CopyInput label={`Key "${created.label}"`} value={created.key} />
            <p className="text-sm">
              Copy it now: it is shown only once and cannot be retrieved later.
            </p>
          </div>
        )}
      </form>
    </section>
  );
}

export function ChannelsPage() {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {CHANNELS.map((channel) => (
        <ChannelCard channel={channel} key={channel} />
      ))}
      <ApiKeysCard />
      <AudienceSourceCard />
    </div>
  );
}
