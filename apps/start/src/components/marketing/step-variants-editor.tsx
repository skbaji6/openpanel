import { useQuery } from '@tanstack/react-query';
import { PlusIcon, TrashIcon } from 'lucide-react';
import { useId, useState } from 'react';
import {
  describeMarketingError,
  useMarketingFetch,
  useMarketingQueryKey,
} from './api';
import type { TemplateRow } from './campaign-contract';
import {
  MAX_BODY_LENGTH,
  MAX_SUBJECT_LENGTH,
  type Preview,
  type Step,
  type StepTemplate,
} from './contract';
import {
  copyMessage,
  DEFAULT_VARIANT,
  messageFor,
  previewRequest,
  resolveMessage,
  setMessage,
  unpinLatest,
  variantKeyProblem,
  variantKeys,
} from './step-variants';
import { InputWithLabel, WithLabel } from '@/components/forms/input-with-label';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useDebounceValue } from '@/hooks/use-debounce-value';

const PREVIEW_DEBOUNCE_MS = 500;
const CHANNELS_WITH_SUBJECT = new Set<Step['channel']>(['email', 'push']);
const TEMPLATE_SOURCE = 'template';
const INLINE_SOURCE = 'inline';
const EMPTY_MESSAGE: StepTemplate = { subject: '', body: '' };
const ONLY_MESSAGE_NOTE =
  'A step needs at least one message, so the last one stays.';

const tabLabel = (tab: string) => (tab === DEFAULT_VARIANT ? 'Default' : tab);

function MessagePreview({
  step,
  tab,
  content,
  allowedEventProps,
}: {
  step: Step;
  tab: string;
  content: { subject?: string; body: string };
  allowedEventProps: string[];
}) {
  const marketingFetch = useMarketingFetch();
  const queryKey = useMarketingQueryKey();
  const request = useDebounceValue(
    JSON.stringify(previewRequest(step, content, tab, allowedEventProps)),
    PREVIEW_DEBOUNCE_MS
  );
  const preview = useQuery({
    queryKey: queryKey('preview', request),
    queryFn: () =>
      marketingFetch<Preview>('preview', { method: 'POST', body: request }),
    placeholderData: (previous) => previous,
    retry: false,
  });
  return (
    <section
      aria-label={`Preview of ${tabLabel(tab)}`}
      className="col gap-2 rounded-md bg-def-100 p-3"
    >
      <h4 className="font-medium text-muted-foreground text-xs uppercase">
        {tab === DEFAULT_VARIANT
          ? 'Preview with a sample profile'
          : `Preview with a sample profile in state ${tab}`}
      </h4>
      {preview.error && (
        <p className="text-destructive text-sm">
          {describeMarketingError(preview.error)}
        </p>
      )}
      {preview.data?.subject && (
        <p className="font-medium text-sm">{preview.data.subject}</p>
      )}
      {preview.data && step.channel === 'email' && (
        // Rendered HTML stays in a sandbox with scripts disabled.
        <iframe
          className="h-48 w-full rounded border bg-white"
          sandbox=""
          srcDoc={preview.data.body}
          title="Email preview"
        />
      )}
      {preview.data && step.channel !== 'email' && (
        <pre className="whitespace-pre-wrap text-sm">{preview.data.body}</pre>
      )}
    </section>
  );
}

function InlineFields({
  step,
  message,
  onChange,
}: {
  step: Step;
  message: StepTemplate;
  onChange: (message: StepTemplate) => void;
}) {
  const bodyId = useId();
  return (
    <>
      {CHANNELS_WITH_SUBJECT.has(step.channel) && (
        <InputWithLabel
          label={step.channel === 'push' ? 'Title' : 'Subject'}
          maxLength={MAX_SUBJECT_LENGTH}
          onChange={(event) =>
            onChange({ ...message, subject: event.target.value })
          }
          value={message.subject ?? ''}
        />
      )}
      <WithLabel
        hint="Use {{profile.firstName}}, {{event.<property>}} (listed under allowed event properties) and {{missing}}."
        id={bodyId}
        label="Body"
      >
        <Textarea
          id={bodyId}
          maxLength={MAX_BODY_LENGTH}
          onChange={(event) =>
            onChange({ ...message, body: event.target.value })
          }
          rows={5}
          value={message.body ?? ''}
        />
      </WithLabel>
    </>
  );
}

function TemplateFields({
  message,
  templates,
  onChange,
}: {
  message: StepTemplate;
  templates: TemplateRow[];
  onChange: (message: StepTemplate) => void;
}) {
  const selectId = useId();
  const chosen = templates.find((row) => row.templateId === message.templateId);
  const options = templates.filter(
    (row) => row.enabled || row.templateId === message.templateId
  );
  const pinned = message.version;
  const newer =
    chosen !== undefined &&
    pinned !== undefined &&
    chosen.currentVersion > pinned;
  const shownVersion = pinned ?? chosen?.currentVersion;
  return (
    <div className="col gap-2">
      <WithLabel
        hint="Pinned to the newest version when the journey starts, or when you save a journey that is already running."
        id={selectId}
        label="Template"
      >
        <select
          className="h-8 rounded-md border bg-background px-2 text-sm"
          id={selectId}
          onChange={(event) => onChange({ templateId: event.target.value })}
          value={message.templateId ?? ''}
        >
          {chosen === undefined && (
            <option value={message.templateId ?? ''}>Template not found</option>
          )}
          {options.map((row) => (
            <option key={row.templateId} value={row.templateId}>
              {`${row.displayName} · v${row.currentVersion}${row.enabled ? '' : ' (disabled)'}`}
            </option>
          ))}
        </select>
      </WithLabel>
      {chosen && shownVersion !== undefined && (
        <p className="text-muted-foreground text-xs">
          {`Uses ${chosen.displayName} · v${shownVersion}${pinned === undefined ? ' (newest)' : ''}`}
        </p>
      )}
      {newer && (
        <div>
          <Button
            onClick={() => onChange(unpinLatest(message))}
            size="sm"
            type="button"
            variant="outline"
          >
            Use newest version
          </Button>
        </div>
      )}
    </div>
  );
}

function MessageFields({
  step,
  tab,
  allowedEventProps,
  templates,
  onChange,
  onRemove,
}: {
  step: Step;
  tab: string;
  allowedEventProps: string[];
  templates: TemplateRow[];
  onChange: (message: StepTemplate) => void;
  onRemove: () => void;
}) {
  const sourceId = useId();
  const message = messageFor(step, tab) ?? EMPTY_MESSAGE;
  const canUseTemplates = step.channel === 'push';
  const isTemplate = message.templateId !== undefined;
  const hasEnabledTemplate = templates.some((row) => row.enabled);
  const isLast = variantKeys(step).length <= 1;
  const content = resolveMessage(
    message,
    templates.find((row) => row.templateId === message.templateId)
  );
  return (
    <div className="col gap-4">
      {(canUseTemplates || isTemplate) && (
        <WithLabel
          hint={
            canUseTemplates
              ? undefined
              : 'Only push steps can use a template. Switch to written text.'
          }
          id={sourceId}
          label="Message source"
        >
          <select
            className="h-8 rounded-md border bg-background px-2 text-sm"
            id={sourceId}
            onChange={(event) => {
              if (event.target.value === TEMPLATE_SOURCE) {
                const first = templates.find((row) => row.enabled);
                if (first) {
                  onChange({ templateId: first.templateId });
                }
                return;
              }
              onChange({ ...EMPTY_MESSAGE });
            }}
            value={isTemplate ? TEMPLATE_SOURCE : INLINE_SOURCE}
          >
            <option value={INLINE_SOURCE}>Written here</option>
            <option
              disabled={!(canUseTemplates && hasEnabledTemplate)}
              value={TEMPLATE_SOURCE}
            >
              From a template
            </option>
          </select>
        </WithLabel>
      )}
      {isTemplate ? (
        <TemplateFields
          message={message}
          onChange={onChange}
          templates={templates}
        />
      ) : (
        <InlineFields message={message} onChange={onChange} step={step} />
      )}
      {content && (
        <MessagePreview
          allowedEventProps={allowedEventProps}
          content={content}
          step={step}
          tab={tab}
        />
      )}
      <div className="col items-start gap-1">
        <Button
          className="text-destructive"
          disabled={isLast}
          icon={TrashIcon}
          onClick={onRemove}
          size="sm"
          type="button"
          variant="ghost"
        >
          {`Remove the ${tabLabel(tab)} message`}
        </Button>
        {isLast && (
          <p className="text-muted-foreground text-xs">{ONLY_MESSAGE_NOTE}</p>
        )}
      </div>
    </div>
  );
}

function MissingMessage({
  step,
  tab,
  onChange,
}: {
  step: Step;
  tab: string;
  onChange: (step: Step) => void;
}) {
  const copyId = useId();
  const sources = variantKeys(step);
  const [source, setSource] = useState(sources[0] ?? DEFAULT_VARIANT);
  const from = sources.includes(source) ? source : (sources[0] ?? source);
  return (
    <div className="col items-start gap-3 rounded-md border border-dashed p-3">
      <p className="text-sm">
        {tab === DEFAULT_VARIANT
          ? 'No default message. Students whose state has no message of its own get nothing at this step.'
          : `No message for ${tab}. Without a default message, students in this state get nothing at this step.`}
      </p>
      <div className="row flex-wrap items-end gap-2">
        <Button
          icon={PlusIcon}
          onClick={() => onChange(setMessage(step, tab, { ...EMPTY_MESSAGE }))}
          size="sm"
          type="button"
          variant="outline"
        >
          Add message
        </Button>
        <WithLabel id={copyId} label="Copy from">
          <select
            className="h-8 rounded-md border bg-background px-2 text-sm"
            id={copyId}
            onChange={(event) => setSource(event.target.value)}
            value={from}
          >
            {sources.map((key) => (
              <option key={key} value={key}>
                {tabLabel(key)}
              </option>
            ))}
          </select>
        </WithLabel>
        <Button
          onClick={() => onChange(copyMessage(step, from, tab))}
          size="sm"
          type="button"
          variant="outline"
        >
          Copy
        </Button>
      </div>
    </div>
  );
}

function AddState({
  step,
  onAdd,
}: {
  step: Step;
  onAdd: (key: string) => void;
}) {
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <div className="row items-end gap-2">
      <InputWithLabel
        error={problem ?? undefined}
        hint="A state value the audience API does not list. It must match the student's state exactly."
        label="Another state value"
        onChange={(event) => setText(event.target.value)}
        value={text}
      />
      <Button
        onClick={() => {
          const found = variantKeyProblem(step, text);
          setProblem(found);
          if (!found) {
            onAdd(text.trim());
            setText('');
          }
        }}
        size="sm"
        type="button"
        variant="outline"
      >
        Add state
      </Button>
    </div>
  );
}

export function StepMessagesEditor({
  step,
  states,
  allowedEventProps,
  onChange,
}: {
  step: Step;
  states: string[];
  allowedEventProps: string[];
  onChange: (step: Step) => void;
}) {
  const marketingFetch = useMarketingFetch();
  const queryKey = useMarketingQueryKey();
  const [tab, setTab] = useState(DEFAULT_VARIANT);
  const templates = useQuery({
    queryKey: queryKey('templates', 'push'),
    queryFn: () =>
      marketingFetch<{ templates: TemplateRow[] }>('templates?channel=push'),
    enabled: step.channel === 'push',
  });
  const tabs = [...new Set([DEFAULT_VARIANT, ...states, ...variantKeys(step)])];
  const activeTab = tabs.includes(tab) ? tab : DEFAULT_VARIANT;
  const hasMessage = messageFor(step, activeTab) !== undefined;
  return (
    <div className="col gap-3">
      <Tabs onValueChange={setTab} value={activeTab}>
        <TabsList aria-label="Messages by state">
          {tabs.map((key) => (
            <TabsTrigger key={key} value={key}>
              {`${tabLabel(key)}${messageFor(step, key) ? '' : ' (none)'}`}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {hasMessage ? (
        <MessageFields
          allowedEventProps={allowedEventProps}
          onChange={(message) => onChange(setMessage(step, activeTab, message))}
          onRemove={() => onChange(setMessage(step, activeTab, undefined))}
          step={step}
          tab={activeTab}
          templates={templates.data?.templates ?? []}
        />
      ) : (
        <MissingMessage onChange={onChange} step={step} tab={activeTab} />
      )}
      <AddState
        onAdd={(key) => {
          onChange(setMessage(step, key, { ...EMPTY_MESSAGE }));
          setTab(key);
        }}
        step={step}
      />
    </div>
  );
}
