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
import { CAMPAIGN_CHANNELS, type CampaignChannel } from './campaign-contract';
import { CREDENTIAL_FIELDS, type CredentialField } from './channel-settings';
import { ChannelSettingsCard } from './channel-settings-card';
import {
  type ApiIssue,
  type ChannelConfigResponse,
  type CreatedApiKey,
  SECRET_MASK,
} from './contract';
import { TrackingSettingsCard } from './tracking-settings-card';
import { useMarketingRole } from './use-marketing-role';
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

const CHANNEL_TITLES: Record<CampaignChannel, string> = {
  email: 'Email (SMTP)',
  webhook: 'Webhook',
  push: 'Push (Firebase Cloud Messaging)',
  sms: 'SMS (MSG91)',
  whatsapp: 'WhatsApp (MSG91)',
};

type FormValues = Record<string, string | boolean>;

function isSecret(field: CredentialField): boolean {
  return field.secret;
}

function inputType(field: CredentialField): string {
  if (isSecret(field)) {
    return 'password';
  }
  return field.kind === 'number' ? 'number' : 'text';
}

function initialValues(
  channel: CampaignChannel,
  config: Record<string, unknown> | null
) {
  const values: FormValues = {};
  const kept = new Set<string>();
  for (const field of CREDENTIAL_FIELDS[channel]) {
    const stored = config?.[field.key];
    if (isSecret(field)) {
      if (stored === SECRET_MASK) {
        kept.add(field.key);
      }
      values[field.key] = '';
    } else if (field.kind === 'boolean') {
      values[field.key] = stored === true;
    } else if (field.kind === 'number') {
      values[field.key] =
        typeof stored === 'number' ? String(stored) : DEFAULT_SMTP_PORT;
    } else {
      values[field.key] = typeof stored === 'string' ? stored : '';
    }
  }
  return { values, kept };
}

function fieldValue(
  field: CredentialField,
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
  return !field.required && text === '' ? undefined : text;
}

function ChannelForm({
  channel,
  loaded,
}: {
  channel: CampaignChannel;
  loaded: ChannelConfigResponse;
}) {
  const marketingFetch = useMarketingFetch();
  const queryKey = useMarketingQueryKey();
  const client = useQueryClient();
  const formId = useId();
  const [initial] = useState(() => initialValues(channel, loaded.config));
  const [values, setValues] = useState(initial.values);
  const [serverIssues, setServerIssues] = useState<ApiIssue[]>([]);
  const fields = CREDENTIAL_FIELDS[channel];

  // The service only keeps a masked secret while every public field is unchanged.
  const publicChanged = fields.some(
    (field) =>
      !isSecret(field) && values[field.key] !== initial.values[field.key]
  );
  const mustReenter = (field: CredentialField) =>
    initial.kept.has(field.key) && publicChanged && values[field.key] === '';
  const blocked = fields.some(mustReenter);

  const save = useMutation({
    mutationFn: () => {
      const config = Object.fromEntries(
        fields
          .map((field) => [
            field.key,
            fieldValue(
              field,
              values[field.key] ?? '',
              initial.kept.has(field.key)
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

  const errorFor = (field: CredentialField) => {
    if (mustReenter(field)) {
      return 'Re-enter this secret because other settings changed';
    }
    return serverIssues.find((issue) => issue.path === `config.${field.key}`)
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
          const savedHint = initial.kept.has(field.key)
            ? 'Saved. Leave empty to keep it.'
            : undefined;
          if (field.kind === 'boolean') {
            return (
              <label
                className="row items-center gap-2 text-sm"
                htmlFor={`${formId}-${field.key}`}
                key={field.key}
              >
                <Switch
                  checked={values[field.key] === true}
                  id={`${formId}-${field.key}`}
                  onCheckedChange={(checked) => setValue(field.key, checked)}
                />
                {field.label}
              </label>
            );
          }
          const isMultiline =
            field.kind === 'secretLines' || field.kind === 'secretJson';
          if (isMultiline) {
            return (
              <WithLabel
                error={error}
                hint={savedHint ?? field.help}
                id={`${formId}-${field.key}`}
                key={field.key}
                label={field.label}
              >
                <Textarea
                  autoComplete="off"
                  id={`${formId}-${field.key}`}
                  onChange={(event) => setValue(field.key, event.target.value)}
                  placeholder={savedHint ? SECRET_MASK : undefined}
                  rows={4}
                  spellCheck={false}
                  value={String(values[field.key] ?? '')}
                />
              </WithLabel>
            );
          }
          return (
            <InputWithLabel
              autoComplete={isSecret(field) ? 'new-password' : 'off'}
              error={error}
              hint={savedHint ?? field.help}
              key={field.key}
              label={field.label}
              onChange={(event) => setValue(field.key, event.target.value)}
              placeholder={savedHint ? SECRET_MASK : undefined}
              type={inputType(field)}
              value={String(values[field.key] ?? '')}
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

function ChannelCard({ channel }: { channel: CampaignChannel }) {
  const marketingFetch = useMarketingFetch();
  const queryKey = useMarketingQueryKey();
  const { isAdmin } = useMarketingRole();
  const config = useQuery({
    queryKey: queryKey('channels', channel),
    queryFn: () => marketingFetch<ChannelConfigResponse>(`channels/${channel}`),
    retry: false,
    enabled: isAdmin,
  });
  return (
    <div className="col gap-4">
      <section aria-label={CHANNEL_TITLES[channel]} className="card">
        <IntegrationCardHeader className="items-center justify-between">
          <h2 className="title">{CHANNEL_TITLES[channel]}</h2>
          {config.data && (
            <Badge variant={config.data.configured ? 'success' : 'outline'}>
              {config.data.configured ? 'Configured' : 'Not configured'}
            </Badge>
          )}
        </IntegrationCardHeader>
        {!isAdmin && (
          <p className="p-4 text-muted-foreground text-sm">
            Only owners and admins can see and change credentials.
          </p>
        )}
        {config.error && (
          <p className="p-4 text-destructive text-sm">
            {describeMarketingError(config.error)}
          </p>
        )}
        {config.data && (
          <ChannelForm
            channel={channel}
            // Keyed on the saved content, so a refetch that changed nothing keeps typed credentials.
            key={JSON.stringify(config.data)}
            loaded={config.data}
          />
        )}
      </section>
      <ChannelSettingsCard
        channel={channel}
        credentialsConfigured={config.data?.configured ?? null}
        title={CHANNEL_TITLES[channel]}
      />
    </div>
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
      {CAMPAIGN_CHANNELS.map((channel) => (
        <ChannelCard channel={channel} key={channel} />
      ))}
      <ApiKeysCard />
      <AudienceSourceCard />
      <TrackingSettingsCard />
    </div>
  );
}
