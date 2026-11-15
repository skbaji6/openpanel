import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FlagIcon, PlusIcon, TrashIcon, ZapIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import {
  describeMarketingError,
  MarketingApiError,
  useMarketingFetch,
  useMarketingQueryKey,
} from './api';
import type { DimensionValue } from './campaign-contract';
import {
  CHANNELS,
  type Channel,
  GOAL_KINDS,
  type Goal,
  type GoalKind,
  type JourneyField,
  MAX_DELAY_SECONDS,
  MAX_STEPS,
  type ReferenceSetSummary,
  type Rule,
  type RuleDefinition,
  type Step,
  zRuleDefinition,
} from './contract';
import { JourneyTestSend } from './journey-test-send';
import { coverage, describeCoverage, emptyMessages } from './step-variants';
import { StepMessagesEditor } from './step-variants-editor';
import { InputWithLabel, WithLabel } from '@/components/forms/input-with-label';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useAppParams } from '@/hooks/use-app-params';
import { useEventNames } from '@/hooks/use-event-names';
import { cn } from '@/utils/cn';

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const DELAY_UNITS = [
  { value: 'minutes', label: 'minutes', seconds: MINUTE },
  { value: 'hours', label: 'hours', seconds: HOUR },
  { value: 'days', label: 'days', seconds: DAY },
] as const;
const STATE_DIMENSION = 'state';
const ACTIVE_SAVE_NOTE =
  'This journey is running. Saving pins the newest template versions; students already in it keep the text they were enrolled with.';
const GUESS_NOTES: Record<JourneyField, string> = {
  trigger:
    'Imported guess, confirm: no student enters until this event is real.',
  goal: 'Imported guess, confirm: no student finishes until this event is real.',
};
const EVENT_NAMES_LIST_ID = 'marketing-event-names';
const CHANNEL_LABELS: Record<Channel, string> = {
  email: 'Email',
  webhook: 'Webhook',
  push: 'Push',
};
const GOAL_LABELS: Record<GoalKind, string> = {
  event: 'An event happens',
  set: 'Every item of a set is reached',
  inactivity: 'The profile stays inactive',
};
const GOAL_HELP: Record<GoalKind, string> = {
  event:
    'The journey ends, and remaining messages are cancelled, as soon as this event happens.',
  set: 'The journey ends when the profile has reached every value in a list you register, for example every section of a book.',
  inactivity:
    'Message only if the profile does nothing at all after the trigger.',
};

export function emptyRuleDefinition(): RuleDefinition {
  return {
    name: '',
    trigger: { event: '' },
    goal: { kind: 'event', event: '' },
    steps: [newStep(undefined)],
    reentry: { enabled: false, cooldownSeconds: 0 },
    allowedEventProps: [],
  };
}

function newStep(previous: Step | undefined): Step {
  return {
    delaySeconds: previous
      ? Math.min(previous.delaySeconds + DAY, MAX_DELAY_SECONDS)
      : HOUR,
    channel: previous?.channel ?? 'email',
    template: { subject: '', body: '' },
  };
}

function goalOfKind(kind: GoalKind): Goal {
  if (kind === 'set') {
    return { kind, event: '', property: '', setKey: '' };
  }
  if (kind === 'inactivity') {
    return { kind, excludeEvents: [] };
  }
  return { kind, event: '' };
}

function splitList(text: string): string[] {
  return text
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function replaceAt<T>(items: T[], index: number, item: T): T[] {
  return items.map((current, i) => (i === index ? item : current));
}

let nextRowKey = 0;

// Draft steps and filters have no ids; these keys keep each row's form state attached to its item.
function useRowKeys(count: number) {
  const createKey = () => {
    nextRowKey += 1;
    return `row-${nextRowKey}`;
  };
  const [keys, setKeys] = useState(() =>
    Array.from({ length: count }, createKey)
  );
  return {
    keys,
    add: () => setKeys((current) => [...current, createKey()]),
    remove: (index: number) =>
      setKeys((current) => current.filter((_, i) => i !== index)),
  };
}

function isGoalKind(value: string): value is GoalKind {
  return GOAL_KINDS.some((kind) => kind === value);
}

function isChannel(value: string): value is Channel {
  return CHANNELS.some((channel) => channel === value);
}

function SelectField<Value extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: Value;
  options: { value: Value; label: string }[];
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <WithLabel id={id} label={label}>
      <Select onValueChange={onChange} value={value}>
        <SelectTrigger className="w-full" id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </WithLabel>
  );
}

// Keeps the raw text so a trailing comma survives while typing.
function ListInput({
  label,
  values,
  hint,
  onChange,
}: {
  label: string;
  values: string[];
  hint?: string;
  onChange: (values: string[]) => void;
}) {
  const [text, setText] = useState(values.join(', '));
  return (
    <InputWithLabel
      hint={hint}
      label={label}
      onChange={(event) => {
        setText(event.target.value);
        onChange(splitList(event.target.value));
      }}
      value={text}
    />
  );
}

function unitFor(seconds: number) {
  const fitting = [...DELAY_UNITS]
    .reverse()
    .find((unit) => seconds > 0 && seconds % unit.seconds === 0);
  return fitting ?? DELAY_UNITS[1];
}

function DelayField({
  label,
  seconds,
  onChange,
}: {
  label: string;
  seconds: number;
  onChange: (seconds: number) => void;
}) {
  const id = useId();
  const [unit, setUnit] = useState(() => unitFor(seconds));
  const amount = seconds / unit.seconds;
  return (
    <WithLabel id={id} label={label}>
      <div className="row gap-2">
        <Input
          id={id}
          min={0}
          onChange={(event) =>
            onChange(Math.round(Number(event.target.value) * unit.seconds))
          }
          type="number"
          value={Number.isFinite(amount) ? amount : 0}
        />
        <Select
          onValueChange={(value) => {
            const next = DELAY_UNITS.find((option) => option.value === value);
            if (next) {
              setUnit(next);
              onChange(Math.round(amount * next.seconds));
            }
          }}
          value={unit.value}
        >
          <SelectTrigger aria-label={`${label} unit`} className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DELAY_UNITS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </WithLabel>
  );
}

function TimelineNode({
  icon: Icon,
  title,
  children,
  className,
}: {
  icon: typeof ZapIcon;
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <li className={cn('relative pb-8 pl-10', className)}>
      <span
        aria-hidden
        className="absolute top-0 bottom-0 left-[15px] w-px bg-border"
      />
      <span
        aria-hidden
        className="absolute top-0 left-0 flex size-8 items-center justify-center rounded-full border bg-card"
      >
        <Icon className="size-4" />
      </span>
      <section aria-label={title} className="card col gap-4 p-4">
        <h3 className="font-medium">{title}</h3>
        {children}
      </section>
    </li>
  );
}

function TriggerFields({
  definition,
  onChange,
}: {
  definition: RuleDefinition;
  onChange: (definition: RuleDefinition) => void;
}) {
  const { trigger } = definition;
  const filters = trigger.filters ?? [];
  const filterKeys = useRowKeys(filters.length);
  const setFilters = (next: typeof filters) =>
    onChange({
      ...definition,
      trigger: { ...trigger, filters: next.length > 0 ? next : undefined },
    });
  return (
    <>
      <InputWithLabel
        label="Trigger event"
        list={EVENT_NAMES_LIST_ID}
        onChange={(event) =>
          onChange({
            ...definition,
            trigger: { ...trigger, event: event.target.value },
          })
        }
        placeholder="add_to_cart"
        value={trigger.event}
      />
      {filters.map((filter, index) => (
        <div className="row items-end gap-2" key={filterKeys.keys[index]}>
          <InputWithLabel
            className="flex-1"
            label={`Filter ${index + 1} property`}
            onChange={(event) =>
              setFilters(
                replaceAt(filters, index, {
                  ...filter,
                  property: event.target.value,
                })
              )
            }
            value={filter.property}
          />
          <InputWithLabel
            className="flex-1"
            label="equals"
            onChange={(event) =>
              setFilters(
                replaceAt(filters, index, {
                  ...filter,
                  equals: event.target.value,
                })
              )
            }
            value={filter.equals}
          />
          <Button
            aria-label={`Remove filter ${index + 1}`}
            icon={TrashIcon}
            onClick={() => {
              filterKeys.remove(index);
              setFilters(filters.filter((_, i) => i !== index));
            }}
            size="icon"
            variant="ghost"
          />
        </div>
      ))}
      <Button
        className="self-start"
        icon={PlusIcon}
        onClick={() => {
          filterKeys.add();
          setFilters([...filters, { property: '', equals: '' }]);
        }}
        size="sm"
        variant="outline"
      >
        Add filter
      </Button>
      <InputWithLabel
        hint="Enroll the profile once per value of this event property (e.g. one journey per item). Leave empty for one journey per profile."
        label="Match on property"
        onChange={(event) =>
          onChange({
            ...definition,
            matchOn: event.target.value || undefined,
          })
        }
        placeholder="item_id"
        value={definition.matchOn ?? ''}
      />
    </>
  );
}

function ReferenceValues({
  setKey,
  values,
}: {
  setKey: string;
  values: string[];
}) {
  const marketingFetch = useMarketingFetch();
  const queryKey = useMarketingQueryKey();
  const client = useQueryClient();
  const id = useId();
  const [text, setText] = useState(values.join('\n'));
  const save = useMutation({
    mutationFn: () =>
      marketingFetch(`reference-sets/${encodeURIComponent(setKey)}`, {
        method: 'PUT',
        body: JSON.stringify({
          values: text
            .split('\n')
            .map((value) => value.trim())
            .filter(Boolean),
        }),
      }),
    onSuccess() {
      toast.success(`Saved set ${setKey}`);
      client.invalidateQueries({ queryKey: queryKey('reference-sets') });
    },
    onError(error) {
      toast.error(describeMarketingError(error));
    },
  });
  return (
    <div className="col gap-2">
      <WithLabel id={id} label={`Values of set ${setKey}, one per line`}>
        <Textarea
          id={id}
          onChange={(event) => setText(event.target.value)}
          rows={6}
          value={text}
        />
      </WithLabel>
      <Button
        className="self-start"
        loading={save.isPending}
        onClick={() => save.mutate()}
        size="sm"
        variant="outline"
      >
        Save set
      </Button>
    </div>
  );
}

function ReferenceSetEditor({ definition }: { definition: RuleDefinition }) {
  const marketingFetch = useMarketingFetch();
  const queryKey = useMarketingQueryKey();
  const defaultKey =
    !definition.matchOn && definition.goal.kind === 'set'
      ? definition.goal.setKey
      : '';
  const [setKey, setSetKey] = useState(defaultKey);
  const sets = useQuery({
    queryKey: queryKey('reference-sets'),
    queryFn: () =>
      marketingFetch<{ referenceSets: ReferenceSetSummary[] }>(
        'reference-sets'
      ),
  });
  const values = useQuery({
    queryKey: queryKey('reference-sets', setKey),
    enabled: setKey !== '',
    retry: false,
    queryFn: () =>
      marketingFetch<{ values: string[] }>(
        `reference-sets/${encodeURIComponent(setKey)}`
      ).catch((error: unknown) => {
        if (error instanceof MarketingApiError && error.status === 404) {
          return { values: [] };
        }
        throw error;
      }),
  });
  const explanation = definition.matchOn
    ? `One set per value of "${definition.matchOn}": name each set after that value (e.g. the item id).`
    : 'The set named by "Set key" above.';
  return (
    <div className="col gap-3 rounded-md border border-dashed p-3">
      <p className="text-muted-foreground text-sm">
        Reference sets list every value the goal property must reach.{' '}
        {explanation} Your backend can also sync them through the API.
      </p>
      <InputWithLabel
        label="Edit set"
        list="marketing-reference-sets"
        onChange={(event) => setSetKey(event.target.value.trim())}
        value={setKey}
      />
      <datalist id="marketing-reference-sets">
        {sets.data?.referenceSets.map((set) => (
          <option key={set.setKey} value={set.setKey}>
            {set.count} values
          </option>
        ))}
      </datalist>
      {values.data && (
        <ReferenceValues
          key={`${setKey}-${values.dataUpdatedAt}`}
          setKey={setKey}
          values={values.data.values}
        />
      )}
    </div>
  );
}

function GoalFields({
  definition,
  onChange,
}: {
  definition: RuleDefinition;
  onChange: (definition: RuleDefinition) => void;
}) {
  const { goal } = definition;
  const setGoal = (next: Goal) => onChange({ ...definition, goal: next });
  return (
    <>
      <SelectField
        label="Goal"
        onChange={(value) => {
          if (isGoalKind(value)) {
            setGoal(goalOfKind(value));
          }
        }}
        options={GOAL_KINDS.map((kind) => ({
          value: kind,
          label: GOAL_LABELS[kind],
        }))}
        value={goal.kind}
      />
      <p className="text-muted-foreground text-sm">{GOAL_HELP[goal.kind]}</p>
      {goal.kind !== 'inactivity' && (
        <InputWithLabel
          label="Goal event"
          list={EVENT_NAMES_LIST_ID}
          onChange={(event) => setGoal({ ...goal, event: event.target.value })}
          placeholder="purchase"
          value={goal.event}
        />
      )}
      {goal.kind === 'set' && (
        <>
          <InputWithLabel
            label="Goal event property"
            onChange={(event) =>
              setGoal({ ...goal, property: event.target.value })
            }
            placeholder="section_id"
            value={goal.property}
          />
          <InputWithLabel
            label="Set key"
            onChange={(event) =>
              setGoal({ ...goal, setKey: event.target.value })
            }
            placeholder="item_id"
            value={goal.setKey}
          />
          <ReferenceSetEditor definition={definition} />
        </>
      )}
      {goal.kind === 'inactivity' && (
        <ListInput
          hint="Comma separated. Any other event from the profile counts as activity."
          label="Events that do not count as activity"
          onChange={(excludeEvents) => setGoal({ ...goal, excludeEvents })}
          values={goal.excludeEvents}
        />
      )}
    </>
  );
}

function ConfirmGuess({
  field,
  checked,
  onChange,
}: {
  field: JourneyField;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div
      className="col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2"
      role="note"
    >
      <p className="font-medium text-sm">{GUESS_NOTES[field]}</p>
      <label className="row items-center gap-2 text-sm" htmlFor={id}>
        <input
          checked={checked}
          id={id}
          onChange={(event) => onChange(event.target.checked)}
          type="checkbox"
        />
        {`The ${field} event is correct`}
      </label>
    </div>
  );
}

function StepFields({
  index,
  step,
  states,
  allowedEventProps,
  canRemove,
  onChange,
  onRemove,
}: {
  index: number;
  step: Step;
  states: string[];
  allowedEventProps: string[];
  canRemove: boolean;
  onChange: (step: Step) => void;
  onRemove: () => void;
}) {
  return (
    <div className="col gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <DelayField
          label="Send after the trigger"
          onChange={(delaySeconds) => onChange({ ...step, delaySeconds })}
          seconds={step.delaySeconds}
        />
        <SelectField
          label="Channel"
          onChange={(value) => {
            if (isChannel(value)) {
              onChange({ ...step, channel: value });
            }
          }}
          options={CHANNELS.map((channel) => ({
            value: channel,
            label: CHANNEL_LABELS[channel],
          }))}
          value={step.channel}
        />
      </div>
      <StepMessagesEditor
        allowedEventProps={allowedEventProps}
        onChange={onChange}
        states={states}
        step={step}
      />
      {step.note && (
        <p className="whitespace-pre-wrap text-muted-foreground text-xs">
          {step.note}
        </p>
      )}
      {canRemove && (
        <Button
          className="self-start text-destructive"
          icon={TrashIcon}
          onClick={onRemove}
          size="sm"
          variant="ghost"
        >
          Remove step {index + 1}
        </Button>
      )}
    </div>
  );
}

export function RuleEditor({
  ruleId,
  rule,
  initial,
  onClose,
}: {
  ruleId?: string;
  rule?: Rule;
  initial: RuleDefinition;
  onClose: () => void;
}) {
  const { projectId } = useAppParams();
  const marketingFetch = useMarketingFetch();
  const queryKey = useMarketingQueryKey();
  const client = useQueryClient();
  const eventNames = useEventNames({ projectId, anyEvents: false });
  const [definition, setDefinition] = useState(initial);
  const stepKeys = useRowKeys(initial.steps.length);
  const [issues, setIssues] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState<JourneyField[]>([]);
  const unconfirmed = rule?.unconfirmed ?? [];
  const states = useQuery({
    queryKey: queryKey('audience-values', STATE_DIMENSION, ''),
    queryFn: () =>
      marketingFetch<{ values: DimensionValue[] }>(
        `audience/dimensions/${STATE_DIMENSION}/values`
      ),
    retry: false,
  });
  const stateValues = (states.data?.values ?? []).map((item) => item.value);
  const toggleConfirmed = (field: JourneyField, checked: boolean) =>
    setConfirmed((current) =>
      checked ? [...current, field] : current.filter((item) => item !== field)
    );

  const save = useMutation({
    mutationFn: (valid: RuleDefinition) =>
      ruleId
        ? marketingFetch(`rules/${encodeURIComponent(ruleId)}`, {
            method: 'PATCH',
            body: JSON.stringify({
              definition: valid,
              ...(confirmed.length > 0 ? { confirmed } : {}),
            }),
          })
        : marketingFetch('rules', {
            method: 'POST',
            body: JSON.stringify({ definition: valid, status: 'paused' }),
          }),
    onSuccess() {
      toast.success(ruleId ? 'Rule saved' : 'Rule created (paused)');
      client.invalidateQueries({ queryKey: queryKey('rules') });
      onClose();
    },
    onError(error) {
      toast.error(describeMarketingError(error));
    },
  });

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const parsed = zRuleDefinition.safeParse(definition);
    if (!parsed.success) {
      setIssues(
        parsed.error.issues.map(
          (issue) => `${issue.path.join('.') || 'rule'}: ${issue.message}`
        )
      );
      return;
    }
    const empty = emptyMessages(parsed.data.steps);
    if (empty.length > 0) {
      setIssues(empty);
      return;
    }
    setIssues([]);
    save.mutate(parsed.data);
  };

  const setStep = (index: number, step: Step) =>
    setDefinition({
      ...definition,
      steps: replaceAt(definition.steps, index, step),
    });

  return (
    <div className="col gap-6">
      <form className="col gap-6" onSubmit={submit}>
        <datalist id={EVENT_NAMES_LIST_ID}>
          {eventNames.map((event) => (
            <option key={event.name} value={event.name} />
          ))}
        </datalist>
        <InputWithLabel
          label="Rule name"
          onChange={(event) =>
            setDefinition({ ...definition, name: event.target.value })
          }
          value={definition.name}
        />
        <ol aria-label="Journey" className="col">
          <TimelineNode icon={ZapIcon} title="When this happens">
            <TriggerFields definition={definition} onChange={setDefinition} />
            {unconfirmed.includes('trigger') && (
              <ConfirmGuess
                checked={confirmed.includes('trigger')}
                field="trigger"
                onChange={(checked) => toggleConfirmed('trigger', checked)}
              />
            )}
          </TimelineNode>
          <TimelineNode icon={FlagIcon} title="Goal">
            <GoalFields definition={definition} onChange={setDefinition} />
            {unconfirmed.includes('goal') && (
              <ConfirmGuess
                checked={confirmed.includes('goal')}
                field="goal"
                onChange={(checked) => toggleConfirmed('goal', checked)}
              />
            )}
            <p
              className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 font-medium text-sm"
              role="note"
            >
              Goal cancels the rest: once the goal is reached, every step below
              that has not been sent yet is cancelled.
            </p>
          </TimelineNode>
          {definition.steps.map((step, index) => (
            <TimelineNode
              icon={PlusIcon}
              key={stepKeys.keys[index]}
              title={`Step ${index + 1}`}
            >
              <StepFields
                allowedEventProps={definition.allowedEventProps}
                canRemove={definition.steps.length > 1}
                index={index}
                onChange={(next) => setStep(index, next)}
                onRemove={() => {
                  stepKeys.remove(index);
                  setDefinition({
                    ...definition,
                    steps: definition.steps.filter((_, i) => i !== index),
                  });
                }}
                states={stateValues}
                step={step}
              />
            </TimelineNode>
          ))}
          <li className="pl-10">
            <Button
              disabled={definition.steps.length >= MAX_STEPS}
              icon={PlusIcon}
              onClick={() => {
                stepKeys.add();
                setDefinition({
                  ...definition,
                  steps: [
                    ...definition.steps,
                    newStep(definition.steps.at(-1)),
                  ],
                });
              }}
              variant="outline"
            >
              Add step
            </Button>
          </li>
        </ol>
        {stateValues.length > 0 && (
          <p className="text-muted-foreground text-sm" role="status">
            {describeCoverage(coverage(definition.steps, stateValues))}
          </p>
        )}
        <section aria-label="Limits" className="card col gap-4 p-4">
          <h3 className="font-medium">Limits</h3>
          <ListInput
            hint="Comma separated. Only these trigger event properties may appear in templates."
            label="Allowed event properties"
            onChange={(allowedEventProps) =>
              setDefinition({ ...definition, allowedEventProps })
            }
            values={definition.allowedEventProps}
          />
          <label
            className="row items-center gap-2 text-sm"
            htmlFor="marketing-reentry"
          >
            <Switch
              checked={definition.reentry.enabled}
              id="marketing-reentry"
              onCheckedChange={(enabled) =>
                setDefinition({
                  ...definition,
                  reentry: { ...definition.reentry, enabled },
                })
              }
            />
            Let a profile enter this journey again
          </label>
          {definition.reentry.enabled && (
            <DelayField
              label="Wait before re-entry"
              onChange={(cooldownSeconds) =>
                setDefinition({
                  ...definition,
                  reentry: { ...definition.reentry, cooldownSeconds },
                })
              }
              seconds={definition.reentry.cooldownSeconds}
            />
          )}
        </section>
        {issues.length > 0 && (
          <ul
            aria-live="polite"
            className="text-destructive text-sm"
            role="alert"
          >
            {issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        )}
        {rule?.status === 'active' && (
          <p className="text-sm" role="note">
            {ACTIVE_SAVE_NOTE}
          </p>
        )}
        <div className="row gap-2">
          <Button loading={save.isPending} type="submit">
            {ruleId ? 'Save rule' : 'Create rule'}
          </Button>
          <Button onClick={onClose} variant="ghost">
            Cancel
          </Button>
        </div>
      </form>
      {rule ? (
        <JourneyTestSend rule={rule} />
      ) : (
        <p className="text-muted-foreground text-xs">
          Save the journey to send a test of a step.
        </p>
      )}
    </div>
  );
}
