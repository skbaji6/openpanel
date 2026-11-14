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
  type FormVariable,
  nextSlot,
  nextSmsSlot,
  syncWhatsappVariables,
  type TemplateForm,
  templateProblems,
  toTemplateBody,
  traitsOf,
  withRowIds,
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

export function formFromRow(row: TemplateRow): TemplateForm {
  return {
    channel: row.channel,
    displayName: row.displayName,
    category: row.category,
    providerRef: row.providerRef as TemplateInput['providerRef'],
    approvedText: row.approvedText,
    variables: withRowIds(row.variables),
  };
}

function ProviderFields({
  form,
  setRef,
  errorOf,
}: {
  form: TemplateForm;
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

const isBodySlot = (slot: string) => slot.startsWith('body_');

function VariableRows({
  form,
  isWhatsapp,
  errorOf,
  onChange,
}: {
  form: TemplateForm;
  isWhatsapp: boolean;
  errorOf: (path: string) => string | undefined;
  onChange: (variables: FormVariable[]) => void;
}) {
  const [extraKind, setExtraKind] = useState<'header' | 'button'>('header');
  const update = (index: number, patch: Partial<FormVariable>) =>
    onChange(
      form.variables.map((v, i) => (i === index ? { ...v, ...patch } : v))
    );
  const add = (slot: string) =>
    onChange(withRowIds([...form.variables, { slot, value: '' }]));
  return (
    <div className="col gap-3">
      <p className="text-muted-foreground text-xs">
        {isWhatsapp
          ? 'One body row per {{n}} in the approved text. Header and button variables are added separately. Each value is plain text and {{profile.<trait>}} placeholders, for example {{profile.first_name}}'
          : 'The names the flow expects, for example var1. Each value is plain text and {{profile.<trait>}} placeholders'}
      </p>
      {form.variables.map((variable, index) => {
        const generated = isWhatsapp && isBodySlot(variable.slot);
        return (
          <div
            className="grid grid-cols-[10rem_1fr_auto] items-start gap-2"
            key={variable.id}
          >
            <InputWithLabel
              disabled={generated}
              error={errorOf(`variables.${index}.slot`)}
              label={`Variable ${index + 1}`}
              onChange={(event) => update(index, { slot: event.target.value })}
              value={variable.slot}
            />
            <InputWithLabel
              error={errorOf(`variables.${index}.value`)}
              label={`Value for ${variable.slot}`}
              onChange={(event) => update(index, { value: event.target.value })}
              value={variable.value}
            />
            {!generated && (
              <Button
                aria-label={`Remove ${variable.slot}`}
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
        );
      })}
      {isWhatsapp ? (
        <div className="row items-center gap-2">
          <select
            aria-label="Kind of variable to add"
            className="h-8 rounded-md border bg-background px-2 text-sm"
            onChange={(event) =>
              setExtraKind(event.target.value as 'header' | 'button')
            }
            value={extraKind}
          >
            <option value="header">Header</option>
            <option value="button">Button</option>
          </select>
          <Button
            onClick={() => add(nextSlot(extraKind, form.variables))}
            type="button"
            variant="outline"
          >
            Add header or button variable
          </Button>
        </div>
      ) : (
        <div>
          <Button
            onClick={() => add(nextSmsSlot(form.variables))}
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

function PreviewPanel({ row, form }: { row: TemplateRow; form: TemplateForm }) {
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
  initial: TemplateForm;
  isAdmin: boolean;
  onClose: () => void;
}) {
  const marketingFetch = useMarketingFetch();
  const queryKey = useMarketingQueryKey();
  const client = useQueryClient();
  const [form, setForm] = useState<TemplateForm>(initial);
  const [loaded, setLoaded] = useState({
    version: row?.currentVersion,
    initial,
  });
  const [conflict, setConflict] = useState(false);
  const [showProblems, setShowProblems] = useState(false);
  const isWhatsapp = form.channel === 'whatsapp';
  const problems = templateProblems(form);
  const errorOf = (path: string) =>
    showProblems ? problems.find((p) => p.path === path)?.message : undefined;
  const refresh = () =>
    client.invalidateQueries({ queryKey: queryKey('templates') });

  // A refetch can change the version under an open editor: adopt it when
  // nothing was typed, otherwise keep the typed values and warn.
  const versionMoved =
    row !== undefined && row.currentVersion !== loaded.version;
  if (row && versionMoved && !conflict) {
    const untouched =
      JSON.stringify(toTemplateBody(form)) ===
      JSON.stringify(toTemplateBody(loaded.initial));
    if (untouched) {
      const fresh = formFromRow(row);
      setForm(fresh);
      setLoaded({ version: row.currentVersion, initial: fresh });
    } else {
      setConflict(true);
    }
  }

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
      setConflict(false);
      client.setQueryData(
        queryKey('templates', 'one', saved.templateId),
        saved
      );
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
        setConflict(true);
        refresh();
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
      {conflict && (
        <div
          className="col mx-4 mt-4 gap-2 rounded border border-destructive p-3 text-sm"
          role="alert"
        >
          <p>
            Someone else changed this template. Discard my edits to see the
            latest version, or save again to replace it with what is below.
          </p>
          {row && (
            <div>
              <Button
                onClick={() => {
                  const fresh = formFromRow(row);
                  setForm(fresh);
                  setLoaded({ version: row.currentVersion, initial: fresh });
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
