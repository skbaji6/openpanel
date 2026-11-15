import { useMutation, useQuery } from '@tanstack/react-query';
import { UsersIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import {
  describeMarketingError,
  useMarketingFetch,
  useMarketingQueryKey,
} from './api';
import {
  emptyGroup,
  filterProblems,
  nameProblems,
  normalizeFilter,
} from './audience-filter';
import { AudienceList } from './audience-lists';
import { AudienceVerify } from './audience-verify';
import type {
  AudienceRow,
  Dimension,
  FilterGroup,
  FilterTree,
} from './campaign-contract';
import { FilterBuilder } from './filter-builder';
import { isVersionConflict, useAudienceRow } from './use-audience-row';
import { InputWithLabel, WithLabel } from '@/components/forms/input-with-label';
import { FullPageEmptyState } from '@/components/full-page-empty-state';
import FullPageLoadingState from '@/components/full-page-loading-state';
import { Button } from '@/components/ui/button';
import { showConfirm } from '@/modals';

const IN_USE_NOTE =
  'A campaign uses this audience, so it cannot be changed. You can still check it.';

interface AudienceForm {
  name: string;
  mode: AudienceRow['mode'];
  filter: FilterGroup;
  excludeFilter: FilterGroup;
}

export interface SchemaState {
  dimensions: Dimension[] | null;
  error: unknown;
}

function asGroup(tree: FilterTree | null): FilterGroup {
  if (tree === null) {
    return emptyGroup();
  }
  return 'children' in tree ? tree : { op: 'and', children: [tree] };
}

function formFromRow(row: AudienceRow | undefined): AudienceForm {
  return {
    name: row?.name ?? '',
    mode: row?.mode ?? 'dynamic',
    filter: asGroup(row?.filter ?? null),
    excludeFilter: asGroup(row?.excludeFilter ?? null),
  };
}

function toBody(form: AudienceForm) {
  return {
    name: form.name.trim(),
    mode: form.mode,
    filter: normalizeFilter(form.filter),
    excludeFilter: normalizeFilter(form.excludeFilter),
  };
}

const definitionOf = (row: AudienceRow | undefined) =>
  JSON.stringify(toBody(formFromRow(row)));

function FilterSection({
  title,
  hint,
  idPrefix,
  value,
  onChange,
  schema,
}: {
  title: string;
  hint: string;
  idPrefix: string;
  value: FilterGroup;
  onChange: (next: FilterGroup) => void;
  schema: SchemaState;
}) {
  return (
    <section aria-label={title} className="col gap-2 border-t p-4">
      <h3 className="font-medium text-sm">{title}</h3>
      <p className="text-muted-foreground text-xs">{hint}</p>
      {schema.dimensions ? (
        <FilterBuilder
          dimensions={schema.dimensions}
          idPrefix={idPrefix}
          onChange={onChange}
          value={value}
        />
      ) : (
        <p className="rounded border p-3 text-muted-foreground text-sm">
          Filters are not available: {describeMarketingError(schema.error)} You
          can still name and save the audience, and add students by list.
        </p>
      )}
    </section>
  );
}

function EditorForm({
  row,
  schema,
  onClose,
  onSaved,
}: {
  row?: AudienceRow;
  schema: SchemaState;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const marketingFetch = useMarketingFetch();
  const cache = useAudienceRow();
  const fieldId = useId();
  const [form, setForm] = useState<AudienceForm>(() => formFromRow(row));
  const [loaded, setLoaded] = useState(() => definitionOf(row));
  const [conflict, setConflict] = useState(false);
  const [uploads, setUploads] = useState<Record<string, boolean>>({});
  const [showProblems, setShowProblems] = useState(false);
  const [blankForm] = useState(() => JSON.stringify(toBody(form)));
  const body = toBody(form);
  const typed = JSON.stringify(body);
  const problems = [
    ...nameProblems(form.name),
    ...[body.filter, body.excludeFilter].flatMap((tree) =>
      tree && schema.dimensions ? filterProblems(tree, schema.dimensions) : []
    ),
  ];
  const current = row ? definitionOf(row) : null;
  const hasUnsavedChanges = typed !== current;
  const locked = row?.inUse === true;
  const edited = row ? hasUnsavedChanges : typed !== blankForm;
  const back = () => {
    if (!edited || locked) {
      onClose();
      return;
    }
    showConfirm({
      title: 'Discard unsaved changes?',
      text: 'Your edits to this audience have not been saved.',
      onConfirm: onClose,
    });
  };
  const uploading = Object.values(uploads).some(Boolean);

  // List changes and freezes bump the version without touching the definition, so only a
  // changed definition counts: adopt it when nothing was typed, otherwise keep the typed values and warn.
  if (current !== null && current !== loaded && !conflict) {
    if (typed === loaded) {
      setForm(formFromRow(row));
      setLoaded(current);
    } else {
      setConflict(true);
    }
  }

  const save = useMutation({
    mutationFn: () => {
      if (!row) {
        return marketingFetch<AudienceRow>('audiences', {
          method: 'POST',
          body: JSON.stringify(body),
        });
      }
      return marketingFetch<AudienceRow>(
        `audiences/${encodeURIComponent(row.id)}`,
        {
          method: 'PUT',
          body: JSON.stringify({
            ...body,
            expectedVersion: cache.currentVersion(row),
          }),
        }
      );
    },
    onSuccess(saved) {
      setLoaded(definitionOf(saved));
      setConflict(false);
      cache.store(saved);
      toast.success('Audience saved');
      onSaved(saved.id);
    },
    onError(error) {
      if (row && isVersionConflict(error)) {
        setConflict(true);
        cache.reload(row.id);
        return;
      }
      toast.error(describeMarketingError(error));
    },
  });

  const discardEdits = () => {
    setForm(formFromRow(row));
    setLoaded(definitionOf(row));
    setConflict(false);
  };
  const setUploading = (list: string) => (busy: boolean) =>
    setUploads((state) => ({ ...state, [list]: busy }));

  const submit = () => {
    setShowProblems(true);
    if (problems.length === 0) {
      save.mutate();
    }
  };

  return (
    <div className="card col">
      <h2 className="p-4 pb-0 font-medium text-lg">
        {row ? `Edit ${row.name}` : 'New audience'}
      </h2>
      {conflict && (
        <div
          className="col mx-4 mt-4 gap-2 rounded border border-destructive p-3 text-sm"
          role="alert"
        >
          <p>
            Someone else changed this audience. Your edits are kept below;
            review them against the latest version before saving again.
          </p>
          <div>
            <Button onClick={discardEdits} type="button" variant="outline">
              Discard my edits and load the latest version
            </Button>
          </div>
        </div>
      )}
      {locked && (
        <p className="px-4 pt-2 text-muted-foreground text-sm">{IN_USE_NOTE}</p>
      )}
      <fieldset className="col" disabled={locked}>
        <section aria-label="Name and mode" className="col gap-4 p-4">
          <InputWithLabel
            hint="Only for you, to recognise the audience when picking it in a campaign"
            label="Name"
            onChange={(event) =>
              setForm((current) => ({ ...current, name: event.target.value }))
            }
            value={form.name}
          />
          <WithLabel
            hint={
              form.mode === 'dynamic'
                ? 'Re-checked when the campaign starts, so students who match later are included'
                : 'Students are fixed when you press Freeze now'
            }
            id={`${fieldId}-mode`}
            label="Mode"
          >
            <select
              className="h-8 self-start rounded-md border bg-background px-2 text-sm"
              id={`${fieldId}-mode`}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  mode:
                    event.target.value === 'snapshot' ? 'snapshot' : 'dynamic',
                }))
              }
              value={form.mode}
            >
              <option value="dynamic">Dynamic</option>
              <option value="snapshot">Snapshot</option>
            </select>
          </WithLabel>
        </section>
        <FilterSection
          hint="Students who match these conditions are in. Leave it empty to use only hand-picked students."
          idPrefix={`${fieldId}-in`}
          onChange={(filter) => setForm((current) => ({ ...current, filter }))}
          schema={schema}
          title="Who is in"
          value={form.filter}
        />
      </fieldset>
      {row && (
        <AudienceList
          disabled={locked || uploading}
          list="include"
          onBusyChange={setUploading('include')}
          row={row}
        />
      )}
      {row && (
        <AudienceList
          disabled={locked || uploading}
          list="exclude"
          onBusyChange={setUploading('exclude')}
          row={row}
        />
      )}
      <fieldset className="col" disabled={locked}>
        <FilterSection
          hint="Students who match these conditions never receive the campaign."
          idPrefix={`${fieldId}-out`}
          onChange={(excludeFilter) =>
            setForm((current) => ({ ...current, excludeFilter }))
          }
          schema={schema}
          title="Leave out by filter"
          value={form.excludeFilter}
        />
      </fieldset>
      {row ? (
        <AudienceVerify
          hasUnsavedChanges={hasUnsavedChanges}
          key={row.version}
          row={row}
        />
      ) : (
        <p className="border-t p-4 text-muted-foreground text-xs">
          Save the audience to add specific students, leave students out by
          list, and count or preview it.
        </p>
      )}
      {showProblems && problems.length > 0 && (
        <ul className="px-4 pb-2 text-destructive text-sm" role="alert">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      <div className="row items-center justify-end gap-2 border-t p-4">
        <Button onClick={back} type="button" variant="ghost">
          Back
        </Button>
        {!locked && (
          <Button
            disabled={uploading}
            loading={save.isPending}
            onClick={submit}
            type="button"
          >
            Save
          </Button>
        )}
      </div>
    </div>
  );
}

export function AudienceEditor({
  audienceId,
  schema,
  onClose,
  onSaved,
}: {
  audienceId?: string;
  schema: SchemaState;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const marketingFetch = useMarketingFetch();
  const queryKey = useMarketingQueryKey();
  const audience = useQuery({
    queryKey: queryKey('audiences', audienceId ?? ''),
    queryFn: () =>
      marketingFetch<AudienceRow>(
        `audiences/${encodeURIComponent(audienceId ?? '')}`
      ),
    enabled: audienceId !== undefined,
  });

  if (audienceId === undefined) {
    return <EditorForm onClose={onClose} onSaved={onSaved} schema={schema} />;
  }
  if (audience.data) {
    return (
      <EditorForm
        key={audience.data.id}
        onClose={onClose}
        onSaved={onSaved}
        row={audience.data}
        schema={schema}
      />
    );
  }
  if (audience.error) {
    return (
      <div className="col gap-2">
        <FullPageEmptyState
          description={describeMarketingError(audience.error)}
          icon={UsersIcon}
          title="This audience could not be loaded"
        />
        <Button className="self-center" onClick={onClose} variant="ghost">
          Back to audiences
        </Button>
      </div>
    );
  }
  return <FullPageLoadingState />;
}
