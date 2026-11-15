import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  describeMarketingError,
  MarketingApiError,
  useMarketingFetch,
  useMarketingQueryKey,
} from './api';
import type {
  PushTemplateInput,
  TemplateRow,
  TemplateVersion,
} from './campaign-contract';
import { MAX_BODY_LENGTH, MAX_SUBJECT_LENGTH, type Preview } from './contract';
import { inlineContent } from './step-variants';
import {
  type PushTemplateForm,
  pushTraitsOf,
  templateProblems,
  toTemplateBody,
} from './template-form';
import { NOT_ADMIN_NOTE } from './use-marketing-role';
import { InputWithLabel, WithLabel } from '@/components/forms/input-with-label';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { showConfirm } from '@/modals';

const VERSION_CONFLICT = 'version_conflict';
const SHOWN_VERSIONS = 20;

export function pushFormFromRow(row: TemplateRow): PushTemplateForm {
  const content = inlineContent(row.content);
  return {
    channel: 'push',
    displayName: row.displayName,
    category: row.category,
    content: { subject: content?.subject ?? '', body: content?.body ?? '' },
  };
}

function VersionList({ row }: { row: TemplateRow }) {
  const marketingFetch = useMarketingFetch();
  const queryKey = useMarketingQueryKey();
  const numbers = Array.from(
    { length: Math.min(row.currentVersion, SHOWN_VERSIONS) },
    (_, index) => row.currentVersion - index
  );
  const versions = useQueries({
    queries: numbers.map((version) => ({
      queryKey: queryKey(
        'templates',
        'version',
        row.templateId,
        String(version)
      ),
      queryFn: () =>
        marketingFetch<TemplateVersion>(
          `templates/${encodeURIComponent(row.templateId)}/versions/${version}`
        ),
      staleTime: Number.POSITIVE_INFINITY,
    })),
  });
  return (
    <section aria-label="Versions" className="col gap-2 border-t p-4">
      <h3 className="font-medium text-sm">Versions</h3>
      <p className="text-muted-foreground text-xs">
        Saving creates a new version. Journeys keep the version they were
        started with until you choose the newest one.
      </p>
      <ul className="col gap-2 text-sm">
        {numbers.map((version, index) => {
          const loaded = versions[index]?.data;
          const content = inlineContent(loaded?.content);
          return (
            <li className="rounded border p-2" key={version}>
              <p className="font-medium">
                {`v${version}${version === row.currentVersion ? ' (current)' : ''}`}
                {loaded && (
                  <span className="font-normal text-muted-foreground text-xs">
                    {` · ${new Date(loaded.createdAt).toLocaleString()}`}
                  </span>
                )}
              </p>
              {content?.subject && <p>{content.subject}</p>}
              {content && (
                <p className="whitespace-pre-wrap text-muted-foreground">
                  {content.body}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function PreviewPanel({ form }: { form: PushTemplateForm }) {
  const marketingFetch = useMarketingFetch();
  const traits = pushTraitsOf(form.content);
  const [sample, setSample] = useState<Record<string, string>>({});
  const preview = useMutation({
    mutationFn: () => {
      const { subject, body } = form.content;
      return marketingFetch<Preview>('preview', {
        method: 'POST',
        body: JSON.stringify({
          channel: 'push',
          template: subject ? { subject, body } : { body },
          sample: { profile: sample },
        }),
      });
    },
    onError: (error) => toast.error(describeMarketingError(error)),
  });
  return (
    <section aria-label="Preview" className="col gap-3 border-t p-4">
      <h3 className="font-medium text-sm">Preview</h3>
      <p className="text-muted-foreground text-xs">
        Renders what you typed with sample values, saved or not.
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
      {preview.data && (
        <div className="col gap-1 rounded border p-3 text-sm" role="status">
          {preview.data.subject && (
            <p className="font-medium">{preview.data.subject}</p>
          )}
          <p className="whitespace-pre-wrap">{preview.data.body}</p>
        </div>
      )}
    </section>
  );
}

export function PushTemplateEditor({
  row,
  initial,
  isAdmin,
  onClose,
}: {
  row?: TemplateRow;
  initial: PushTemplateForm;
  isAdmin: boolean;
  onClose: () => void;
}) {
  const marketingFetch = useMarketingFetch();
  const queryKey = useMarketingQueryKey();
  const client = useQueryClient();
  const [form, setForm] = useState(initial);
  const [conflict, setConflict] = useState(false);
  const [showProblems, setShowProblems] = useState(false);
  const problems = templateProblems(form);
  const errorOf = (path: string) =>
    showProblems ? problems.find((p) => p.path === path)?.message : undefined;
  const dirty =
    isAdmin &&
    JSON.stringify(toTemplateBody(form)) !==
      JSON.stringify(toTemplateBody(initial));
  const back = () => {
    if (!dirty) {
      onClose();
      return;
    }
    showConfirm({
      title: 'Discard unsaved changes?',
      text: 'Your edits to this template have not been saved.',
      onConfirm: onClose,
    });
  };

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
        body: JSON.stringify(body satisfies PushTemplateInput),
      });
    },
    onSuccess(saved) {
      setConflict(false);
      client.setQueryData(
        queryKey('templates', 'one', saved.templateId),
        saved
      );
      client.invalidateQueries({ queryKey: queryKey('templates') });
      toast.success('Template saved');
      onClose();
    },
    onError(error) {
      if (
        error instanceof MarketingApiError &&
        error.code === VERSION_CONFLICT
      ) {
        setConflict(true);
        client.invalidateQueries({ queryKey: queryKey('templates') });
        return;
      }
      toast.error(describeMarketingError(error));
    },
  });

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
        <p
          className="mx-4 mt-4 rounded border border-destructive p-3 text-sm"
          role="alert"
        >
          Someone else changed this template. Close this editor and open it
          again to see the latest version before saving.
        </p>
      )}
      <h2 className="p-4 pb-0 font-medium text-lg">
        {row ? `Edit ${row.displayName}` : 'New push template'}
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
        <InputWithLabel
          error={errorOf('content.subject')}
          hint="The notification title. Leave empty for no title."
          label="Title"
          maxLength={MAX_SUBJECT_LENGTH}
          onChange={(event) =>
            setForm((c) => ({
              ...c,
              content: { ...c.content, subject: event.target.value },
            }))
          }
          value={form.content.subject}
        />
        <WithLabel
          error={errorOf('content.body')}
          hint="Use {{profile.firstName}}, {{profile.state}} or any other student trait as {{profile.<trait>}}."
          id="push-template-body"
          label="Body"
        >
          <Textarea
            id="push-template-body"
            maxLength={MAX_BODY_LENGTH}
            onChange={(event) =>
              setForm((c) => ({
                ...c,
                content: { ...c.content, body: event.target.value },
              }))
            }
            rows={5}
            value={form.content.body}
          />
        </WithLabel>
      </fieldset>
      <PreviewPanel form={form} />
      {row && <VersionList row={row} />}
      <div className="row items-center justify-between gap-2 border-t p-4">
        {isAdmin ? (
          <span />
        ) : (
          <p className="text-muted-foreground text-xs">{NOT_ADMIN_NOTE}</p>
        )}
        <div className="row gap-2">
          <Button onClick={back} type="button" variant="ghost">
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
