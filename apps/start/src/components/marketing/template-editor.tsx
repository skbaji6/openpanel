import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  describeMarketingError,
  MarketingApiError,
  useMarketingFetch,
  useMarketingQueryKey,
} from './api';
import type { TemplateInput, TemplateRow } from './campaign-contract';
import {
  syncWhatsappVariables,
  templateProblems,
  toTemplateBody,
  traitsOf,
} from './template-form';
import { InputWithLabel, WithLabel } from '@/components/forms/input-with-label';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

const VERSION_CONFLICT = 'version_conflict';
const NOT_ADMIN_NOTE = 'Only owners and admins can do this';
const MISSING_VARIABLE_TEXT =
  'A variable could not be filled: a trait it uses is missing or empty in the sample, so a real send would skip this student.';

type PreviewResult =
  | { ok: true; variables: { slot: string; value: string }[]; text: string }
  | { ok: false; reason: string };

type Ref = Record<string, string | undefined>;

export function formFromRow(row: TemplateRow): TemplateInput {
  return {
    channel: row.channel,
    displayName: row.displayName,
    category: row.category,
    providerRef: row.providerRef as TemplateInput['providerRef'],
    approvedText: row.approvedText,
    variables: row.variables.map((v) => ({ ...v })),
  };
}

function ProviderFields({
  form,
  setRef,
  errorOf,
}: {
  form: TemplateInput;
  setRef: (key: string, value: string) => void;
  errorOf: (path: string) => string | undefined;
}) {
  const ref = form.providerRef as Ref;
  const field = (key: string, label: string, hint: string) => (
    <InputWithLabel
      error={errorOf(`providerRef.${key}`)}
      hint={hint}
      label={label}
      onChange={(event) => setRef(key, event.target.value)}
      value={ref[key] ?? ''}
    />
  );
  if (form.channel === 'sms') {
    return (
      <>
        {field('flowId', 'Flow ID', "Flow ID from MSG91's flow")}
        {field(
          'senderId',
          'Sender ID (optional)',
          'Six capital letters. Leave empty to use the flow default'
        )}
      </>
    );
  }
  return (
    <>
      {field(
        'templateName',
        'Template name',
        'Template name exactly as approved by Meta'
      )}
      {field('namespace', 'Namespace', 'Namespace from MSG91')}
      {field('language', 'Language', 'Language code, for example en')}
      {field(
        'integratedNumber',
        'Integrated number (optional)',
        'The WhatsApp number connected in MSG91, digits only'
      )}
    </>
  );
}

function VariableRows({
  form,
  isWhatsapp,
  errorOf,
  onChange,
}: {
  form: TemplateInput;
  isWhatsapp: boolean;
  errorOf: (path: string) => string | undefined;
  onChange: (variables: TemplateInput['variables']) => void;
}) {
  const update = (
    index: number,
    patch: Partial<{ slot: string; value: string }>
  ) =>
    onChange(
      form.variables.map((v, i) => (i === index ? { ...v, ...patch } : v))
    );
  return (
    <div className="col gap-3">
      <p className="text-muted-foreground text-xs">
        {isWhatsapp
          ? 'One row per {{n}} in the approved text. Each value is plain text and {{profile.<trait>}} placeholders, for example {{profile.first_name}}'
          : 'The names the flow expects, for example var1. Each value is plain text and {{profile.<trait>}} placeholders'}
      </p>
      {form.variables.map((variable, index) => (
        <div
          className="grid grid-cols-[10rem_1fr_auto] items-start gap-2"
          key={isWhatsapp ? variable.slot : index}
        >
          <InputWithLabel
            disabled={isWhatsapp && variable.slot.startsWith('body_')}
            error={errorOf(`variables.${index}.slot`)}
            label="Variable"
            onChange={(event) => update(index, { slot: event.target.value })}
            value={variable.slot}
          />
          <InputWithLabel
            error={errorOf(`variables.${index}.value`)}
            label="Value"
            onChange={(event) => update(index, { value: event.target.value })}
            value={variable.value}
          />
          {!isWhatsapp && (
            <Button
              className="mt-6"
              onClick={() =>
                onChange(form.variables.filter((_, i) => i !== index))
              }
              type="button"
              variant="ghost"
            >
              Remove
            </Button>
          )}
        </div>
      ))}
      {!isWhatsapp && (
        <div>
          <Button
            onClick={() =>
              onChange([
                ...form.variables,
                { slot: `var${form.variables.length + 1}`, value: '' },
              ])
            }
            type="button"
            variant="outline"
          >
            Add variable
          </Button>
        </div>
      )}
    </div>
  );
}

function PreviewPanel({
  row,
  form,
}: {
  row: TemplateRow;
  form: TemplateInput;
}) {
  const marketingFetch = useMarketingFetch();
  const traits = traitsOf(form.variables);
  const [sample, setSample] = useState<Record<string, string>>({});
  const preview = useMutation({
    mutationFn: () =>
      marketingFetch<PreviewResult>(
        `templates/${encodeURIComponent(row.templateId)}/preview`,
        {
          method: 'POST',
          body: JSON.stringify({ sample: { profile: sample } }),
        }
      ),
    onError: (error) => toast.error(describeMarketingError(error)),
  });
  return (
    <section aria-label="Preview" className="col gap-3 border-t p-4">
      <h3 className="font-medium text-sm">Preview</h3>
      <p className="text-muted-foreground text-xs">
        Renders the saved version with sample values. Save your edits first.
      </p>
      {traits.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {traits.map((trait) => (
            <InputWithLabel
              key={trait}
              label={`Sample ${trait}`}
              onChange={(event) =>
                setSample((current) => ({
                  ...current,
                  [trait]: event.target.value,
                }))
              }
              value={sample[trait] ?? ''}
            />
          ))}
        </div>
      )}
      <div>
        <Button
          loading={preview.isPending}
          onClick={() => preview.mutate()}
          type="button"
          variant="outline"
        >
          Preview
        </Button>
      </div>
      {preview.data?.ok === true && (
        <p
          className="whitespace-pre-wrap rounded border p-3 text-sm"
          role="status"
        >
          {preview.data.text}
        </p>
      )}
      {preview.data?.ok === false && (
        <p className="text-destructive text-sm" role="alert">
          {preview.data.reason === 'missing_variable'
            ? MISSING_VARIABLE_TEXT
            : preview.data.reason}
        </p>
      )}
    </section>
  );
}

export function TemplateEditor({
  row,
  initial,
  isAdmin,
  onClose,
}: {
  row?: TemplateRow;
  initial: TemplateInput;
  isAdmin: boolean;
  onClose: () => void;
}) {
  const marketingFetch = useMarketingFetch();
  const queryKey = useMarketingQueryKey();
  const client = useQueryClient();
  const [form, setForm] = useState<TemplateInput>(initial);
  const [showProblems, setShowProblems] = useState(false);
  const isWhatsapp = form.channel === 'whatsapp';
  const problems = templateProblems(form);
  const errorOf = (path: string) =>
    showProblems ? problems.find((p) => p.path === path)?.message : undefined;
  const refresh = () =>
    client.invalidateQueries({ queryKey: queryKey('templates') });

  const save = useMutation({
    mutationFn: () => {
      const body = toTemplateBody(form);
      if (row) {
        return marketingFetch<TemplateRow>(
          `templates/${encodeURIComponent(row.templateId)}`,
          {
            method: 'PUT',
            body: JSON.stringify({
              ...body,
              expectedVersion: row.currentVersion,
            }),
          }
        );
      }
      return marketingFetch<TemplateRow>('templates', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    onSuccess(saved) {
      client.setQueryData<{ templates: TemplateRow[] }>(
        queryKey('templates', form.channel),
        (current) => {
          if (!current) {
            return current;
          }
          const exists = current.templates.some(
            (t) => t.templateId === saved.templateId
          );
          return {
            templates: exists
              ? current.templates.map((t) =>
                  t.templateId === saved.templateId ? saved : t
                )
              : [saved, ...current.templates],
          };
        }
      );
      toast.success('Template saved');
      onClose();
    },
    onError(error) {
      if (
        error instanceof MarketingApiError &&
        error.code === VERSION_CONFLICT
      ) {
        refresh();
        toast.error(
          'Someone else changed this template. It was reloaded, so review it and save again.'
        );
        onClose();
        return;
      }
      toast.error(describeMarketingError(error));
    },
  });

  const setRef = (key: string, value: string) =>
    setForm((current) => ({
      ...current,
      providerRef: {
        ...(current.providerRef as Ref),
        [key]: value,
      } as TemplateInput['providerRef'],
    }));

  return (
    <form
      className="card col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setShowProblems(true);
        if (problems.length === 0) {
          save.mutate();
        }
      }}
    >
      <h2 className="p-4 pb-0 font-medium text-lg">
        {row
          ? `Edit ${row.displayName}`
          : `New ${isWhatsapp ? 'WhatsApp' : 'SMS'} template`}
      </h2>
      <fieldset className="col gap-4 p-4" disabled={!isAdmin}>
        <InputWithLabel
          error={errorOf('displayName')}
          hint="Only for you, to recognise the template in lists"
          label="Name"
          onChange={(event) =>
            setForm((c) => ({ ...c, displayName: event.target.value }))
          }
          value={form.displayName}
        />
        <WithLabel
          hint="Promotional messages respect quiet hours and consent; service messages are transactional"
          id="template-category"
          label="Category"
        >
          <select
            className="h-8 rounded-md border bg-background px-2 text-sm"
            id="template-category"
            onChange={(event) =>
              setForm((c) => ({
                ...c,
                category: event.target.value as TemplateInput['category'],
              }))
            }
            value={form.category}
          >
            <option value="promotional">Promotional</option>
            <option value="service">Service</option>
          </select>
        </WithLabel>
        <ProviderFields errorOf={errorOf} form={form} setRef={setRef} />
        <WithLabel
          error={errorOf('approvedText')}
          hint={
            isWhatsapp
              ? 'The body exactly as approved by Meta, with {{1}}, {{2}} placeholders'
              : 'The text of the flow, for your reference. The provider sends the flow, not this text'
          }
          id="template-approved-text"
          label="Approved text"
        >
          <Textarea
            id="template-approved-text"
            onChange={(event) => {
              const approvedText = event.target.value;
              setForm((c) => ({
                ...c,
                approvedText,
                variables: isWhatsapp
                  ? syncWhatsappVariables(approvedText, c.variables)
                  : c.variables,
              }));
            }}
            rows={5}
            value={form.approvedText}
          />
        </WithLabel>
        <VariableRows
          errorOf={errorOf}
          form={form}
          isWhatsapp={isWhatsapp}
          onChange={(variables) => setForm((c) => ({ ...c, variables }))}
        />
        {showProblems && problems.length > 0 && (
          <ul className="text-destructive text-sm">
            {problems.map((problem) => (
              <li key={`${problem.path}-${problem.message}`}>
                {problem.message}
              </li>
            ))}
          </ul>
        )}
      </fieldset>
      {row && <PreviewPanel form={form} row={row} />}
      <div className="row items-center justify-between gap-2 border-t p-4">
        {isAdmin ? (
          <span />
        ) : (
          <p className="text-muted-foreground text-xs">{NOT_ADMIN_NOTE}</p>
        )}
        <div className="row gap-2">
          <Button onClick={onClose} type="button" variant="ghost">
            {isAdmin ? 'Cancel' : 'Back'}
          </Button>
          {isAdmin && (
            <Button loading={save.isPending} type="submit">
              Save
            </Button>
          )}
        </div>
      </div>
    </form>
  );
}
