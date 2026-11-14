import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import {
  describeMarketingError,
  MarketingApiError,
  useMarketingFetch,
  useMarketingQueryKey,
} from './api';
import {
  CAMPAIGN_CHANNELS,
  type CampaignChannel,
  type CampaignRow,
  type ChannelSettingsResponse,
  type ProviderTemplateChannel,
  type TemplateRow,
} from './campaign-contract';
import {
  type CampaignForm,
  CHANNEL_LABELS,
  campaignProblems,
  emptyCampaign,
  fromRow,
  PROBLEM_LABELS,
  type QuietHoursChoice,
  toDraftBody,
  withChannel,
} from './campaign-form';
import { CampaignLaunchPanel } from './campaign-launch-panel';
import { PushMessageEditor } from './push-message-editor';
import { useAudiences } from './use-campaign';
import { useMarketingRole } from './use-marketing-role';
import { InputWithLabel, WithLabel } from '@/components/forms/input-with-label';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useAppParams } from '@/hooks/use-app-params';
import { showConfirm } from '@/modals';

const VERSION_CONFLICT = 'version_conflict';
const NOT_DRAFT = 'not_draft';
const NOT_ADMIN_NOTE = 'Only owners and admins can do this';
const SELECT_CLASS =
  'h-8 self-start rounded-md border bg-background px-2 text-sm';
const MODE_LABELS = { dynamic: 'Dynamic', snapshot: 'Snapshot' } as const;
const STALE_TEMPLATE =
  'The chosen template is no longer enabled. Pick another.';
const CAP_HINT =
  "Counts every message to the student on this channel from any campaign or journey (all channels if the project's limit is set that way). Students at the limit are skipped, not delayed.";

type ErrorOf = (path: string) => string | undefined;
type SetField = <K extends keyof CampaignForm>(
  key: K,
  value: CampaignForm[K]
) => void;

const sameDraft = (a: CampaignForm, b: CampaignForm) =>
  JSON.stringify(toDraftBody(a)) === JSON.stringify(toDraftBody(b));

const isRegistryChannel = (
  channel: CampaignChannel
): channel is ProviderTemplateChannel =>
  channel === 'sms' || channel === 'whatsapp';

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={title} className="col gap-4 border-t p-4">
      <h3 className="font-medium text-sm">{title}</h3>
      {children}
    </section>
  );
}

// A new tab keeps the half-written campaign open.
function AudiencesTabLink() {
  const { organizationId, projectId } = useAppParams();
  return (
    <Link
      params={{ organizationId, projectId }}
      rel="noopener noreferrer"
      search={{ new: true }}
      target="_blank"
      to="/$organizationId/$projectId/marketing/audiences"
    >
      <u>Create an audience (opens in a new tab)</u>
    </Link>
  );
}

function TemplatesTabLink({ channel }: { channel: ProviderTemplateChannel }) {
  const { organizationId, projectId } = useAppParams();
  return (
    <Link
      params={{ organizationId, projectId }}
      rel="noopener noreferrer"
      search={{ channel }}
      target="_blank"
      to="/$organizationId/$projectId/marketing/templates"
    >
      <u>Templates tab (opens in a new tab)</u>
    </Link>
  );
}

function AudienceField({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (id: string) => void;
  error?: string;
}) {
  const fieldId = useId();
  const audiences = useAudiences();
  const rows = audiences.data?.audiences ?? [];
  return (
    <WithLabel
      error={
        error ??
        (audiences.error ? describeMarketingError(audiences.error) : undefined)
      }
      hint={
        <>
          Who receives the campaign. It can be picked later, before sending.{' '}
          <AudiencesTabLink />
        </>
      }
      id={fieldId}
      label="Audience"
    >
      <select
        className={SELECT_CLASS}
        id={fieldId}
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        <option value="">No audience yet</option>
        {rows.map((row) => (
          <option key={row.id} value={row.id}>
            {`${row.name} (${MODE_LABELS[row.mode]})`}
          </option>
        ))}
      </select>
    </WithLabel>
  );
}

function RegistryTemplateField({
  channel,
  value,
  onChange,
  error,
}: {
  channel: ProviderTemplateChannel;
  value: string;
  onChange: (templateId: string) => void;
  error?: string;
}) {
  const marketingFetch = useMarketingFetch();
  const queryKey = useMarketingQueryKey();
  const fieldId = useId();
  const templates = useQuery({
    queryKey: queryKey('templates', channel),
    queryFn: () =>
      marketingFetch<{ templates: TemplateRow[] }>(
        `templates?channel=${channel}`
      ),
  });
  const enabled = (templates.data?.templates ?? []).filter((t) => t.enabled);
  const selected = enabled.find((t) => t.templateId === value);
  const isStale = templates.data !== undefined && value !== '' && !selected;
  if (templates.data && enabled.length === 0) {
    return (
      <p className="rounded border p-3 text-sm">
        {isStale && `${STALE_TEMPLATE} `}
        No enabled {CHANNEL_LABELS[channel]} template yet. Add one on the{' '}
        <TemplatesTabLink channel={channel} /> first.
      </p>
    );
  }
  return (
    <div className="col gap-2">
      <WithLabel
        error={
          error ??
          (templates.error
            ? describeMarketingError(templates.error)
            : undefined)
        }
        hint="A provider-approved template from the registry. Only enabled templates are listed"
        id={fieldId}
        label="Template"
      >
        <select
          className={SELECT_CLASS}
          id={fieldId}
          onChange={(event) => onChange(event.target.value)}
          value={isStale ? '' : value}
        >
          <option value="">Pick a template</option>
          {enabled.map((t) => (
            <option key={t.templateId} value={t.templateId}>
              {t.displayName}
            </option>
          ))}
        </select>
      </WithLabel>
      {isStale && (
        <p className="text-destructive text-sm" role="alert">
          {STALE_TEMPLATE}
        </p>
      )}
      {selected && (
        <p className="whitespace-pre-wrap rounded border p-3 text-sm">
          {selected.approvedText}
        </p>
      )}
    </div>
  );
}

function MessageFields({
  form,
  set,
  errorOf,
}: {
  form: CampaignForm;
  set: SetField;
  errorOf: ErrorOf;
}) {
  const bodyId = useId();
  if (form.channel === 'push') {
    return <PushMessageEditor errorOf={errorOf} form={form} onChange={set} />;
  }
  if (isRegistryChannel(form.channel)) {
    return (
      <RegistryTemplateField
        channel={form.channel}
        error={errorOf('template.templateId')}
        onChange={(templateId) => set('templateId', templateId)}
        value={form.templateId}
      />
    );
  }
  const isEmail = form.channel === 'email';
  return (
    <>
      {isEmail && (
        <InputWithLabel
          error={errorOf('template.subject')}
          hint="The subject line students see in their inbox"
          label="Subject"
          onChange={(event) => set('subject', event.target.value)}
          value={form.subject}
        />
      )}
      <WithLabel
        error={errorOf('template.body')}
        hint={
          isEmail
            ? 'The email as HTML'
            : 'Sent as the request body to the webhook'
        }
        id={bodyId}
        label="Body"
      >
        <Textarea
          id={bodyId}
          onChange={(event) => set('body', event.target.value)}
          rows={8}
          value={form.body}
        />
      </WithLabel>
    </>
  );
}

function WhenFields({
  form,
  set,
  errorOf,
}: {
  form: CampaignForm;
  set: SetField;
  errorOf: ErrorOf;
}) {
  const name = useId();
  const scheduled = form.sendKind === 'scheduled';
  return (
    <>
      <fieldset className="col gap-2">
        <legend className="sr-only">When to send</legend>
        <label className="row items-center gap-2 text-sm">
          <input
            checked={!scheduled}
            name={name}
            onChange={() => set('sendKind', 'now')}
            type="radio"
          />
          Now, when you launch it
        </label>
        <label className="row items-center gap-2 text-sm">
          <input
            checked={scheduled}
            name={name}
            onChange={() => set('sendKind', 'scheduled')}
            type="radio"
          />
          At a set time
        </label>
      </fieldset>
      {scheduled && (
        <div className="grid gap-4 md:grid-cols-3">
          <InputWithLabel
            error={errorOf('sendAtLocal')}
            hint="Date and time in the time zone next to it"
            label="Send at"
            onChange={(event) => set('sendAtLocal', event.target.value)}
            type="datetime-local"
            value={form.sendAtLocal}
          />
          <InputWithLabel
            error={errorOf('timezone')}
            hint="For example Asia/Kolkata"
            label="Time zone"
            onChange={(event) => set('timezone', event.target.value)}
            value={form.timezone}
          />
          <InputWithLabel
            error={errorOf('ifLateMinutes')}
            hint={`If the system is down at that time, still send when it is no more than ${form.ifLateMinutes || 'N'} minutes late`}
            label="Late by at most (minutes)"
            min={0}
            onChange={(event) => set('ifLateMinutes', event.target.value)}
            type="number"
            value={form.ifLateMinutes}
          />
        </div>
      )}
    </>
  );
}

function channelQuietHint(settings: ChannelSettingsResponse | undefined) {
  if (!settings) {
    return 'Messages due inside quiet hours wait until they end';
  }
  const quiet = settings.settings.quietHours;
  return quiet.enabled
    ? `This channel's quiet hours are ${quiet.start} to ${quiet.end} (${quiet.timezone})`
    : 'This channel has no quiet hours';
}

function QuietHoursFields({
  form,
  set,
  errorOf,
}: {
  form: CampaignForm;
  set: SetField;
  errorOf: ErrorOf;
}) {
  const marketingFetch = useMarketingFetch();
  const queryKey = useMarketingQueryKey();
  const fieldId = useId();
  const settings = useQuery({
    queryKey: queryKey('channels', form.channel, 'settings'),
    queryFn: () =>
      marketingFetch<ChannelSettingsResponse>(
        `channels/${form.channel}/settings`
      ),
    retry: false,
  });
  const choose = (choice: QuietHoursChoice) => {
    set('quietHours', choice);
    const channelZone = settings.data?.settings.quietHours.timezone;
    if (choice === 'custom' && channelZone) {
      set('quietTimezone', channelZone);
    }
  };
  return (
    <>
      <WithLabel
        hint={channelQuietHint(settings.data)}
        id={`${fieldId}-quiet`}
        label="Quiet hours for this campaign"
      >
        <select
          className={SELECT_CLASS}
          id={`${fieldId}-quiet`}
          onChange={(event) => choose(event.target.value as QuietHoursChoice)}
          value={form.quietHours}
        >
          <option value="channel">Use the channel's quiet hours</option>
          <option value="off">No quiet hours</option>
          <option value="custom">Other quiet hours</option>
        </select>
      </WithLabel>
      {form.quietHours === 'custom' && (
        <div className="grid gap-2 md:grid-cols-3">
          <WithLabel
            error={errorOf('quietHoursOverride.start')}
            hint="Messages due from this time wait"
            id={`${fieldId}-qs`}
            label="From"
          >
            <Input
              id={`${fieldId}-qs`}
              onChange={(event) => set('quietStart', event.target.value)}
              type="time"
              value={form.quietStart}
            />
          </WithLabel>
          <WithLabel
            error={errorOf('quietHoursOverride.end')}
            hint="They are sent from this time on"
            id={`${fieldId}-qe`}
            label="Until"
          >
            <Input
              id={`${fieldId}-qe`}
              onChange={(event) => set('quietEnd', event.target.value)}
              type="time"
              value={form.quietEnd}
            />
          </WithLabel>
          <InputWithLabel
            error={errorOf('quietHoursOverride.timezone')}
            hint={`The times are in ${form.quietTimezone || 'this zone'}, taken from the channel's settings when you picked this option`}
            label="Time zone"
            onChange={(event) => set('quietTimezone', event.target.value)}
            value={form.quietTimezone}
          />
        </div>
      )}
    </>
  );
}

function CapFields({
  form,
  set,
  errorOf,
}: {
  form: CampaignForm;
  set: SetField;
  errorOf: ErrorOf;
}) {
  const fieldId = useId();
  return (
    <div className="col gap-2">
      <label
        className="row items-center gap-2 text-sm"
        htmlFor={`${fieldId}-cap`}
      >
        <Switch
          aria-describedby={`${fieldId}-cap-hint`}
          checked={form.capEnabled}
          id={`${fieldId}-cap`}
          onCheckedChange={(checked) => set('capEnabled', checked)}
        />
        Limit per student
      </label>
      <p className="text-muted-foreground text-xs" id={`${fieldId}-cap-hint`}>
        {CAP_HINT}
      </p>
      {form.capEnabled && (
        <div className="grid grid-cols-2 gap-2">
          <InputWithLabel
            error={errorOf('frequencyCap.max')}
            hint="The most messages a student may receive in the period"
            label="At most (messages)"
            min={1}
            onChange={(event) => set('capMax', event.target.value)}
            type="number"
            value={form.capMax}
          />
          <InputWithLabel
            error={errorOf('frequencyCap.periodSeconds')}
            hint="Length of the period, for example 24 for a day"
            label="In (hours)"
            min={0}
            onChange={(event) => set('capPeriodHours', event.target.value)}
            type="number"
            value={form.capPeriodHours}
          />
        </div>
      )}
    </div>
  );
}

function KeyFields({
  form,
  set,
  errorOf,
}: {
  form: CampaignForm;
  set: SetField;
  errorOf: ErrorOf;
}) {
  const fieldId = useId();
  return (
    <>
      <InputWithLabel
        error={errorOf('campaignKey')}
        hint="A short name shared by related campaigns, for example nov-promo. Optional"
        label="Campaign key"
        onChange={(event) => set('campaignKey', event.target.value)}
        value={form.campaignKey}
      />
      <label
        className="row items-center gap-2 text-sm"
        htmlFor={`${fieldId}-skip`}
      >
        <Switch
          checked={form.skipPreviousRecipients}
          id={`${fieldId}-skip`}
          onCheckedChange={(checked) => set('skipPreviousRecipients', checked)}
        />
        Skip students who already received a campaign with this key
      </label>
    </>
  );
}

function DeleteButton({
  row,
  onDeleted,
}: {
  row: CampaignRow;
  onDeleted: () => void;
}) {
  const marketingFetch = useMarketingFetch();
  const queryKey = useMarketingQueryKey();
  const client = useQueryClient();
  const remove = useMutation({
    mutationFn: () =>
      marketingFetch<null>(`campaigns/${encodeURIComponent(row.id)}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      toast.success('Campaign deleted');
      client.removeQueries({ queryKey: queryKey('campaigns', row.id) });
      client.invalidateQueries({
        queryKey: queryKey('campaigns'),
        exact: true,
      });
      onDeleted();
    },
    onError: (error) => toast.error(describeMarketingError(error)),
  });
  return (
    <Button
      loading={remove.isPending}
      onClick={() =>
        showConfirm({
          title: `Delete ${row.name}?`,
          text: 'The draft is removed. This cannot be undone.',
          onConfirm: () => remove.mutate(),
        })
      }
      type="button"
      variant="ghost"
    >
      Delete
    </Button>
  );
}

function ProblemSummary({
  problems,
}: {
  problems: { path: string; message: string }[];
}) {
  const labels = [
    ...new Set(problems.map((p) => PROBLEM_LABELS[p.path]).filter(Boolean)),
  ];
  const unplaced = problems.filter((p) => !PROBLEM_LABELS[p.path]);
  return (
    <div className="px-4 pb-2 text-destructive text-sm" role="alert">
      {labels.length > 0 && <p>{`Check these fields: ${labels.join(', ')}`}</p>}
      {unplaced.map((problem) => (
        <p key={`${problem.path}-${problem.message}`}>{problem.message}</p>
      ))}
    </div>
  );
}

export function CampaignEditor({
  row,
  onClose,
  onSaved,
}: {
  row?: CampaignRow;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const marketingFetch = useMarketingFetch();
  const queryKey = useMarketingQueryKey();
  const client = useQueryClient();
  const { isAdmin } = useMarketingRole();
  const channelId = useId();
  const [form, setForm] = useState<CampaignForm>(() =>
    row ? fromRow(row) : emptyCampaign()
  );
  const [loaded, setLoaded] = useState({
    version: row?.version,
    initial: form,
  });
  const [conflict, setConflict] = useState(false);
  const [showProblems, setShowProblems] = useState(false);
  const problems = campaignProblems(form);
  const errorOf: ErrorOf = (path) =>
    showProblems ? problems.find((p) => p.path === path)?.message : undefined;
  const set: SetField = (key, value) =>
    setForm((current) => ({ ...current, [key]: value }));
  const dirty = !sameDraft(form, loaded.initial);
  const reload = () =>
    row &&
    client.invalidateQueries({ queryKey: queryKey('campaigns', row.id) });
  const adopt = (fresh: CampaignRow) => {
    const next = fromRow(fresh);
    setForm(next);
    setLoaded({ version: fresh.version, initial: next });
  };

  // A refetch can change the version under an open editor: adopt it when
  // nothing was typed, otherwise keep the typed values and warn.
  if (row && row.version !== loaded.version && !conflict) {
    if (dirty) {
      setConflict(true);
    } else {
      adopt(row);
    }
  }

  const save = useMutation({
    mutationFn: () => {
      const body = toDraftBody(form) as Record<string, unknown>;
      if (row) {
        return marketingFetch<CampaignRow>(
          `campaigns/${encodeURIComponent(row.id)}`,
          {
            method: 'PATCH',
            body: JSON.stringify({ ...body, expectedVersion: row.version }),
          }
        );
      }
      return marketingFetch<CampaignRow>('campaigns', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    onSuccess(saved) {
      adopt(saved);
      setConflict(false);
      client.setQueryData(queryKey('campaigns', saved.id), saved);
      client.invalidateQueries({
        queryKey: queryKey('campaigns'),
        exact: true,
      });
      toast.success('Campaign saved');
      if (!row) {
        onSaved(saved.id);
      }
    },
    onError(error) {
      const code = error instanceof MarketingApiError ? error.code : '';
      if (code === VERSION_CONFLICT) {
        setConflict(true);
        reload();
        return;
      }
      if (code === NOT_DRAFT) {
        toast.error(
          'This campaign is no longer a draft, so it cannot be edited.'
        );
        reload();
        return;
      }
      toast.error(describeMarketingError(error));
    },
  });

  const changeChannel = (channel: CampaignChannel) => {
    if (!row) {
      setForm((current) => withChannel(current, channel));
      return;
    }
    showConfirm({
      title: `Send by ${CHANNEL_LABELS[channel]} instead?`,
      text: 'The message is cleared, because it was written for another channel. Nothing changes until you save.',
      onConfirm: () => setForm((current) => withChannel(current, channel)),
    });
  };

  const back = () => {
    if (!dirty) {
      onClose();
      return;
    }
    showConfirm({
      title: 'Discard unsaved changes?',
      text: 'Your edits to this campaign have not been saved.',
      onConfirm: onClose,
    });
  };

  return (
    <div className="col gap-4">
      <form
        className="card col"
        onSubmit={(event) => {
          event.preventDefault();
          setShowProblems(true);
          if (problems.length === 0) {
            save.mutate();
          }
        }}
      >
        {conflict && (
          <div
            className="col mx-4 mt-4 gap-2 rounded border border-destructive p-3 text-sm"
            role="alert"
          >
            <p>
              Someone else changed this campaign. Discard my edits to see the
              latest version, or save again to replace it with what is below.
            </p>
            {row && (
              <div>
                <Button
                  onClick={() => {
                    adopt(row);
                    setConflict(false);
                  }}
                  type="button"
                  variant="outline"
                >
                  Discard my edits and load the latest version
                </Button>
              </div>
            )}
          </div>
        )}
        <h2 className="p-4 font-medium text-lg">
          {row ? `Edit ${row.name}` : 'New campaign'}
        </h2>
        <Section title="Basics">
          <InputWithLabel
            error={errorOf('name')}
            hint="Only for you, to recognise the campaign in lists"
            label="Name"
            onChange={(event) => set('name', event.target.value)}
            value={form.name}
          />
          <WithLabel
            hint={
              row
                ? 'Changing it clears the message'
                : 'How the message reaches students'
            }
            id={channelId}
            label="Channel"
          >
            <select
              className={SELECT_CLASS}
              id={channelId}
              onChange={(event) =>
                changeChannel(event.target.value as CampaignChannel)
              }
              value={form.channel}
            >
              {CAMPAIGN_CHANNELS.map((channel) => (
                <option key={channel} value={channel}>
                  {CHANNEL_LABELS[channel]}
                </option>
              ))}
            </select>
          </WithLabel>
          <AudienceField
            error={errorOf('audienceId')}
            onChange={(audienceId) => set('audienceId', audienceId)}
            value={form.audienceId}
          />
        </Section>
        <Section title="Message">
          <MessageFields errorOf={errorOf} form={form} set={set} />
        </Section>
        <Section title="When">
          <WhenFields errorOf={errorOf} form={form} set={set} />
        </Section>
        <Section title="Limits">
          <QuietHoursFields errorOf={errorOf} form={form} set={set} />
          <CapFields errorOf={errorOf} form={form} set={set} />
          <KeyFields errorOf={errorOf} form={form} set={set} />
        </Section>
        {showProblems && problems.length > 0 && (
          <ProblemSummary problems={problems} />
        )}
        <div className="row items-center justify-between gap-2 border-t p-4">
          <div className="row items-center gap-2">
            {row && isAdmin && <DeleteButton onDeleted={onClose} row={row} />}
            {row && !isAdmin && (
              <>
                <Button disabled type="button" variant="ghost">
                  Delete
                </Button>
                <p className="text-muted-foreground text-xs">
                  {NOT_ADMIN_NOTE}
                </p>
              </>
            )}
          </div>
          <div className="row gap-2">
            <Button onClick={back} type="button" variant="ghost">
              Back
            </Button>
            <Button loading={save.isPending} type="submit">
              Save
            </Button>
          </div>
        </div>
      </form>
      {row && !dirty && !conflict && <CampaignLaunchPanel campaign={row} />}
    </div>
  );
}
