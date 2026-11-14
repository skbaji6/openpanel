import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import {
  describeMarketingError,
  MarketingApiError,
  useMarketingFetch,
  useMarketingQueryKey,
} from './api';
import type {
  CampaignChannel,
  ChannelSettingsResponse,
} from './campaign-contract';
import {
  type SettingsForm,
  settingsFieldsFor,
  settingsProblems,
  toSettingsBody,
  toSettingsForm,
} from './channel-settings';
import { labelSettingsIssue } from './reason-labels';
import { useMarketingRole } from './use-marketing-role';
import { InputWithLabel, WithLabel } from '@/components/forms/input-with-label';
import {
  IntegrationCardFooter,
  IntegrationCardHeader,
} from '@/components/integrations/integration-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';

const VERSION_CONFLICT = 'version_conflict';

function statusLine(loaded: ChannelSettingsResponse): string {
  if (loaded.issues.length === 0) {
    return 'Ready';
  }
  return loaded.issues.map(labelSettingsIssue).join('. ');
}

function SettingsFields({
  channel,
  loaded,
  isAdmin,
}: {
  channel: CampaignChannel;
  loaded: ChannelSettingsResponse;
  isAdmin: boolean;
}) {
  const marketingFetch = useMarketingFetch();
  const queryKey = useMarketingQueryKey();
  const client = useQueryClient();
  const formId = useId();
  const [form, setForm] = useState<SettingsForm>(() =>
    toSettingsForm(loaded.settings)
  );
  const fields = settingsFieldsFor(channel);
  const problems = settingsProblems(form, channel);
  const has = (field: (typeof fields)[number]) => fields.includes(field);
  const set = <K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));
  const refetch = () =>
    client.invalidateQueries({
      queryKey: queryKey('channels', channel, 'settings'),
    });

  const save = useMutation({
    mutationFn: () =>
      marketingFetch<ChannelSettingsResponse>(`channels/${channel}/settings`, {
        method: 'PUT',
        body: JSON.stringify({
          settings: toSettingsBody(form),
          expectedVersion: loaded.version,
        }),
      }),
    onSuccess() {
      toast.success('Sending settings saved');
      refetch();
    },
    onError(error) {
      if (
        error instanceof MarketingApiError &&
        error.code === VERSION_CONFLICT
      ) {
        refetch();
        toast.error(
          'Someone else changed these settings. They were reloaded, so check them and save again.'
        );
        return;
      }
      toast.error(describeMarketingError(error));
    },
  });

  return (
    <form
      className="col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <fieldset className="col gap-4 p-4" disabled={!isAdmin}>
        {has('concurrency') && (
          <InputWithLabel
            hint="How many sends run at once"
            label="Concurrency"
            min={1}
            onChange={(event) => set('concurrency', event.target.value)}
            type="number"
            value={form.concurrency}
          />
        )}
        {has('ratePerSecond') && (
          <InputWithLabel
            hint="Messages per second your MSG91 account allows. Required"
            label="Rate per second"
            min={0}
            onChange={(event) => set('ratePerSecond', event.target.value)}
            step="any"
            type="number"
            value={form.ratePerSecond}
          />
        )}
        {has('quietHours') && (
          <div className="col gap-2">
            <label
              className="row items-center gap-2 text-sm"
              htmlFor={`${formId}-quiet`}
            >
              <Switch
                checked={form.quietEnabled}
                id={`${formId}-quiet`}
                onCheckedChange={(checked) => set('quietEnabled', checked)}
              />
              Quiet hours
            </label>
            <p className="text-muted-foreground text-xs">
              Messages due inside this window wait until it ends
            </p>
            {form.quietEnabled && (
              <div className="grid grid-cols-3 gap-2">
                <WithLabel id={`${formId}-qs`} label="From">
                  <Input
                    id={`${formId}-qs`}
                    onChange={(event) => set('quietStart', event.target.value)}
                    type="time"
                    value={form.quietStart}
                  />
                </WithLabel>
                <WithLabel id={`${formId}-qe`} label="Until">
                  <Input
                    id={`${formId}-qe`}
                    onChange={(event) => set('quietEnd', event.target.value)}
                    type="time"
                    value={form.quietEnd}
                  />
                </WithLabel>
                <WithLabel id={`${formId}-qz`} label="Time zone">
                  <Input
                    id={`${formId}-qz`}
                    onChange={(event) =>
                      set('quietTimezone', event.target.value)
                    }
                    value={form.quietTimezone}
                  />
                </WithLabel>
              </div>
            )}
          </div>
        )}
        {has('requireConsent') && (
          <div className="col gap-1">
            <label
              className="row items-center gap-2 text-sm"
              htmlFor={`${formId}-consent`}
            >
              <Switch
                checked={form.requireConsent}
                id={`${formId}-consent`}
                onCheckedChange={(checked) => set('requireConsent', checked)}
              />
              Require consent
            </label>
            <p className="text-muted-foreground text-xs">
              Send only to students the audience API marks as consenting
            </p>
          </div>
        )}
        {has('pricePerMessage') && (
          <div className="grid grid-cols-2 gap-2">
            <InputWithLabel
              hint="Used only for the cost estimate before a campaign starts"
              label="Price per message"
              min={0}
              onChange={(event) => set('priceAmount', event.target.value)}
              step="any"
              type="number"
              value={form.priceAmount}
            />
            <InputWithLabel
              hint="Three capital letters, for example INR"
              label="Currency"
              onChange={(event) => set('priceCurrency', event.target.value)}
              value={form.priceCurrency}
            />
          </div>
        )}
        {has('dailyQuota') && (
          <InputWithLabel
            hint="Most messages sent per day. Required for email"
            label="Daily quota"
            min={1}
            onChange={(event) => set('dailyQuota', event.target.value)}
            type="number"
            value={form.dailyQuota}
          />
        )}
        {has('quotaTimezone') && (
          <InputWithLabel
            hint="The day the quota counts over starts at midnight here"
            label="Quota time zone"
            onChange={(event) => set('quotaTimezone', event.target.value)}
            value={form.quotaTimezone}
          />
        )}
        {problems.length > 0 && (
          <ul className="text-destructive text-sm">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}
      </fieldset>
      <IntegrationCardFooter className="justify-between">
        <p className="text-muted-foreground text-xs">
          {isAdmin ? '' : 'Only owners and admins can do this'}
        </p>
        {isAdmin && (
          <Button
            disabled={problems.length > 0}
            loading={save.isPending}
            type="submit"
          >
            Save
          </Button>
        )}
      </IntegrationCardFooter>
    </form>
  );
}

export function ChannelSettingsCard({
  channel,
  title,
}: {
  channel: CampaignChannel;
  title: string;
}) {
  const marketingFetch = useMarketingFetch();
  const queryKey = useMarketingQueryKey();
  const { isAdmin } = useMarketingRole();
  const settings = useQuery({
    queryKey: queryKey('channels', channel, 'settings'),
    queryFn: () =>
      marketingFetch<ChannelSettingsResponse>(`channels/${channel}/settings`),
    retry: false,
  });
  return (
    <section aria-label={`${title} sending settings`} className="card">
      <IntegrationCardHeader className="items-center justify-between">
        <h2 className="title">Sending settings</h2>
      </IntegrationCardHeader>
      {settings.data && (
        <p className="px-4 pt-4 text-sm" role="status">
          <Badge
            variant={settings.data.issues.length === 0 ? 'success' : 'outline'}
          >
            {settings.data.issues.length === 0 ? 'Ready' : 'Needs attention'}
          </Badge>{' '}
          {settings.data.issues.length === 0 ? '' : statusLine(settings.data)}
        </p>
      )}
      {settings.error && (
        <p className="p-4 text-destructive text-sm">
          {describeMarketingError(settings.error)}
        </p>
      )}
      {settings.data && (
        <SettingsFields
          channel={channel}
          isAdmin={isAdmin}
          key={`${settings.data.version}`}
          loaded={settings.data}
        />
      )}
    </section>
  );
}
