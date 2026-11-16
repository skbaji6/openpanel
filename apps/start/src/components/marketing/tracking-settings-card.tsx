import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import {
  describeMarketingError,
  useMarketingFetch,
  useMarketingQueryKey,
} from './api';
import {
  exampleTrackedLink,
  type TrackingForm,
  type TrackingSettings,
  toTrackingBody,
  toTrackingForm,
  trackingProblems,
} from './tracking-settings';
import { NOT_ADMIN_NOTE, useMarketingRole } from './use-marketing-role';
import CopyInput from '@/components/forms/copy-input';
import { InputWithLabel } from '@/components/forms/input-with-label';
import {
  IntegrationCardFooter,
  IntegrationCardHeader,
} from '@/components/integrations/integration-card';
import { Button } from '@/components/ui/button';

interface TrackingSettingsResponse {
  settings: TrackingSettings;
  effectivePublicUrl: string;
}

const COPY = {
  publicUrl:
    "Where students and providers reach this service: unsubscribe links and the delivery webhook use it. Leave empty to use the server's MARKETING_PUBLIC_URL.",
  campaignUrl:
    'Links in push and email go through this address so clicks can be counted, for example https://campaign.sianext.com. Leave empty to send links unchanged.',
  conversionEvent:
    'The app event that counts as a conversion, for example the app-open event. Leave empty to turn conversions off.',
  conversionWindowDays:
    'How many days after a message an app open still counts for it.',
  webhook:
    "Paste this into MSG91's delivery report webhook. Anyone with it can mark messages delivered, so share it only with MSG91.",
  note: 'Changes apply within a minute.',
} as const;

function TrackingFields({
  loaded,
  isAdmin,
}: {
  loaded: TrackingSettingsResponse;
  isAdmin: boolean;
}) {
  const marketingFetch = useMarketingFetch();
  const queryKey = useMarketingQueryKey();
  const client = useQueryClient();
  const formId = useId();
  const [form, setForm] = useState<TrackingForm>(() =>
    toTrackingForm(loaded.settings)
  );
  const problems = trackingProblems(form);
  const messageFor = (field: keyof TrackingSettings) =>
    problems.find((problem) => problem.field === field)?.message;
  const set = <K extends keyof TrackingForm>(key: K, value: string) =>
    setForm((current) => ({ ...current, [key]: value }));
  const campaignUrl = form.campaignUrl.trim() || null;
  const example = messageFor('campaignUrl')
    ? null
    : exampleTrackedLink(campaignUrl);

  const webhook = useQuery({
    queryKey: queryKey('tracking-settings', 'webhook'),
    queryFn: () => marketingFetch<{ url: string }>('tracking-settings/webhook'),
    retry: false,
    enabled: isAdmin,
  });

  const save = useMutation({
    mutationFn: () =>
      marketingFetch<TrackingSettingsResponse>('tracking-settings', {
        method: 'PUT',
        body: JSON.stringify(toTrackingBody(form)),
      }),
    onSuccess(saved) {
      client.setQueryData(queryKey('tracking-settings'), saved);
      client.invalidateQueries({
        queryKey: queryKey('tracking-settings', 'webhook'),
      });
      toast.success('Tracking settings saved');
    },
    onError: (error) => toast.error(describeMarketingError(error)),
  });

  return (
    <form
      className="col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (problems.length === 0) {
          save.mutate();
        }
      }}
    >
      <fieldset className="col gap-4 p-4" disabled={!isAdmin}>
        <InputWithLabel
          autoComplete="off"
          error={messageFor('publicUrl')}
          hint={COPY.publicUrl}
          label="Public URL"
          onChange={(event) => set('publicUrl', event.target.value)}
          placeholder="https://dash.example.com"
          value={form.publicUrl}
        />
        <p className="text-muted-foreground text-xs">
          In use now: {loaded.effectivePublicUrl}
        </p>
        <InputWithLabel
          autoComplete="off"
          error={messageFor('campaignUrl')}
          hint={COPY.campaignUrl}
          label="Campaign URL"
          onChange={(event) => set('campaignUrl', event.target.value)}
          placeholder="https://campaign.sianext.com"
          value={form.campaignUrl}
        />
        {example && (
          <p className="text-muted-foreground text-xs">
            Tracked links look like {example}
          </p>
        )}
        <InputWithLabel
          autoComplete="off"
          error={messageFor('conversionEvent')}
          hint={COPY.conversionEvent}
          label="Conversion event"
          onChange={(event) => set('conversionEvent', event.target.value)}
          value={form.conversionEvent}
        />
        <InputWithLabel
          error={messageFor('conversionWindowDays')}
          hint={COPY.conversionWindowDays}
          label="Conversion window (days)"
          max={30}
          min={1}
          onChange={(event) => set('conversionWindowDays', event.target.value)}
          type="number"
          value={form.conversionWindowDays}
        />
      </fieldset>
      {isAdmin && webhook.data && (
        <div
          aria-describedby={`${formId}-webhook`}
          className="col gap-2 px-4"
          role="group"
        >
          <CopyInput label="MSG91 delivery webhook" value={webhook.data.url} />
          <p className="text-muted-foreground text-xs" id={`${formId}-webhook`}>
            {COPY.webhook}
          </p>
        </div>
      )}
      {webhook.error && (
        <p className="px-4 text-destructive text-sm">
          {describeMarketingError(webhook.error)}
        </p>
      )}
      <p className="px-4 text-muted-foreground text-xs">{COPY.note}</p>
      <IntegrationCardFooter className="justify-end">
        {isAdmin ? null : (
          <span className="text-muted-foreground text-sm">
            {NOT_ADMIN_NOTE}
          </span>
        )}
        <Button
          disabled={!isAdmin || problems.length > 0}
          loading={save.isPending}
          type="submit"
        >
          Save
        </Button>
      </IntegrationCardFooter>
    </form>
  );
}

export function TrackingSettingsCard() {
  const marketingFetch = useMarketingFetch();
  const queryKey = useMarketingQueryKey();
  const { isAdmin } = useMarketingRole();
  const settings = useQuery({
    queryKey: queryKey('tracking-settings'),
    queryFn: () =>
      marketingFetch<TrackingSettingsResponse>('tracking-settings'),
    retry: false,
  });
  return (
    <section aria-label="Tracking" className="card">
      <IntegrationCardHeader>
        <h2 className="title">Tracking and delivery reports</h2>
      </IntegrationCardHeader>
      {settings.error && (
        <p className="p-4 text-destructive text-sm">
          {describeMarketingError(settings.error)}
        </p>
      )}
      {settings.data && (
        <TrackingFields
          isAdmin={isAdmin}
          key={JSON.stringify(settings.data)}
          loaded={settings.data}
        />
      )}
    </section>
  );
}
