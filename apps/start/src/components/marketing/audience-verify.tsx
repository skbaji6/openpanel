import { useMutation } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { describeMarketingError, useMarketingFetch } from './api';
import {
  describeCount,
  EXPLANATION_LABELS,
  formatCount,
} from './audience-filter';
import {
  type AudienceCount,
  type AudiencePreview,
  type AudienceRow,
  type Explanation,
  MAX_ID_CONDITION_VALUES,
  MAX_PREVIEW_LIMIT,
} from './campaign-contract';
import { isVersionConflict, useAudienceRow } from './use-audience-row';
import { InputWithLabel } from '@/components/forms/input-with-label';
import { Button } from '@/components/ui/button';

const FREEZE_CONFLICT_TEXT =
  'Someone else changed this audience while it was freezing. It was reloaded; check it and freeze again.';

type Member = AudiencePreview['members'][number];

function ErrorText({ error }: { error: unknown }) {
  if (!error) {
    return null;
  }
  return (
    <p className="text-destructive text-sm" role="alert">
      {describeMarketingError(error)}
    </p>
  );
}

function CountCheck({ path }: { path: string }) {
  const marketingFetch = useMarketingFetch();
  const count = useMutation({
    mutationFn: () =>
      marketingFetch<AudienceCount>(`${path}/count`, { method: 'POST' }),
  });
  return (
    <div className="col gap-2">
      <div className="row items-center gap-3">
        <Button
          loading={count.isPending}
          onClick={() => count.mutate()}
          type="button"
          variant="outline"
        >
          Count
        </Button>
        {count.data && (
          <p className="text-sm" role="status">
            <strong>{describeCount(count.data)}</strong>{' '}
            <span className="text-muted-foreground text-xs">
              counted {new Date(count.data.countedAt).toLocaleTimeString()}
            </span>
          </p>
        )}
      </div>
      {count.data?.approximate && (
        <p className="text-muted-foreground text-xs">
          About: students both matched and hand-picked, or left out by a rule,
          may be counted more than once. The real send never messages anyone
          twice.
        </p>
      )}
      <ErrorText error={count.error} />
    </div>
  );
}

function PreviewCheck({ path, row }: { path: string; row: AudienceRow }) {
  const marketingFetch = useMarketingFetch();
  const [members, setMembers] = useState<Member[]>([]);
  const preview = useMutation({
    mutationFn: (cursor: string | null) =>
      marketingFetch<AudiencePreview>(`${path}/preview`, {
        method: 'POST',
        body: JSON.stringify({
          limit: MAX_PREVIEW_LIMIT,
          ...(cursor && { cursor }),
        }),
      }),
    onSuccess: (page, cursor) =>
      setMembers((current) =>
        cursor ? [...current, ...page.members] : page.members
      ),
  });
  const page = preview.data;
  const excludeListTooLong = row.excludeCount > MAX_ID_CONDITION_VALUES;
  return (
    <div className="col gap-2">
      <div>
        <Button
          loading={preview.isPending && preview.variables === null}
          onClick={() => preview.mutate(null)}
          type="button"
          variant="outline"
        >
          Preview
        </Button>
      </div>
      {page && row.filter === null && (
        <p className="text-muted-foreground text-xs">
          Without a "Who is in" filter the preview is empty; only the
          hand-picked students are in.
        </p>
      )}
      {page && !page.exclusionsApplied && (
        <p className="text-muted-foreground text-xs">
          The "Leave out by filter" rule is not applied to this preview, so some
          of these students may still be left out when sending.
        </p>
      )}
      {page && excludeListTooLong && (
        <p className="text-muted-foreground text-xs">
          The leave-out list is larger than the preview applies (
          {formatCount(MAX_ID_CONDITION_VALUES)}), so some of these students may
          still be left out when sending.
        </p>
      )}
      {members.length > 0 && (
        <table className="w-full text-left text-sm">
          <thead className="text-muted-foreground">
            <tr>
              <th className="p-2">Student id</th>
              <th className="p-2">Name</th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => (
              <tr className="border-t" key={member.id}>
                <td className="p-2 font-mono text-xs">{member.id}</td>
                <td className="p-2">{member.displayName ?? '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {page?.nextCursor && (
        <div>
          <Button
            loading={preview.isPending}
            onClick={() => preview.mutate(page.nextCursor)}
            size="sm"
            type="button"
            variant="ghost"
          >
            Show more
          </Button>
        </div>
      )}
      <ErrorText error={preview.error} />
    </div>
  );
}

function ExplainCheck({ path }: { path: string }) {
  const marketingFetch = useMarketingFetch();
  const fieldId = useId();
  const [studentId, setStudentId] = useState('');
  // Local state, not a mutation, so the typed id is not kept in the query cache.
  const [result, setResult] = useState<Explanation | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const check = async (id: string) => {
    setPending(true);
    setError(null);
    setResult(null);
    try {
      setResult(
        await marketingFetch<Explanation>(`${path}/explain`, {
          method: 'POST',
          body: JSON.stringify({ id }),
        })
      );
    } catch (failure) {
      setError(failure);
    } finally {
      setPending(false);
    }
  };
  return (
    <form
      className="col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (studentId.trim() !== '') {
          check(studentId.trim());
        }
      }}
    >
      <div className="row items-end gap-2">
        <InputWithLabel
          className="flex-1"
          hint="A student id from your system, not a phone number or email"
          id={fieldId}
          label="Why is this student in or out?"
          onChange={(event) => setStudentId(event.target.value)}
          value={studentId}
        />
        <Button loading={pending} type="submit" variant="outline">
          Check
        </Button>
      </div>
      {result && (
        <div className="text-sm" role="status">
          <p>
            <strong>
              {result.id} is {result.verdict === 'in' ? 'in' : 'out'}
            </strong>
          </p>
          <ul className="list-disc pl-5">
            {result.reasons.map((reason) => (
              <li key={reason}>{EXPLANATION_LABELS[reason]}</li>
            ))}
          </ul>
        </div>
      )}
      <ErrorText error={error} />
    </form>
  );
}

function FreezeCheck({ path, row }: { path: string; row: AudienceRow }) {
  const marketingFetch = useMarketingFetch();
  const cache = useAudienceRow();
  const freeze = useMutation({
    mutationFn: () =>
      marketingFetch<AudienceRow>(`${path}/freeze`, { method: 'POST' }),
    onSuccess: cache.store,
    // A toast, because the reload remounts this section and would hide an inline message.
    onError: (error) => {
      if (isVersionConflict(error)) {
        cache.reload(row.id);
        toast.error(FREEZE_CONFLICT_TEXT);
      }
    },
  });
  const freezeConflict = isVersionConflict(freeze.error);
  const neverFrozen = row.snapshotVersion === null;
  const changedSinceFreeze =
    !neverFrozen && row.snapshotVersion !== row.version;
  return (
    <div className="col gap-2 border-t pt-3">
      <p className="text-muted-foreground text-xs">
        A snapshot audience is frozen now; campaigns send to exactly the frozen
        students.
      </p>
      {row.snapshotAt && (
        <p className="text-sm">
          Frozen {new Date(row.snapshotAt).toLocaleString()} with{' '}
          {formatCount(row.snapshotCount ?? 0)} students
        </p>
      )}
      {neverFrozen && (
        <p className="text-sm text-yellow-600" role="status">
          Not frozen yet. Freeze it before using it in a campaign.
        </p>
      )}
      {changedSinceFreeze && (
        <p className="text-sm text-yellow-600" role="status">
          Changed since it was frozen. Freeze again so campaigns use the current
          version.
        </p>
      )}
      <div>
        <Button
          disabled={row.inUse}
          loading={freeze.isPending}
          onClick={() => freeze.mutate()}
          type="button"
          variant="outline"
        >
          Freeze now
        </Button>
      </div>
      {!freezeConflict && <ErrorText error={freeze.error} />}
    </div>
  );
}

export function AudienceVerify({
  row,
  hasUnsavedChanges,
}: {
  row: AudienceRow;
  hasUnsavedChanges: boolean;
}) {
  const path = `audiences/${encodeURIComponent(row.id)}`;
  return (
    <section aria-label="Check" className="col gap-4 border-t p-4">
      <h3 className="font-medium text-sm">Check</h3>
      <p className="text-muted-foreground text-xs">
        {hasUnsavedChanges
          ? 'Checks use the saved version. Save your edits first.'
          : 'Checks ask the audience API about the saved version.'}
      </p>
      <CountCheck path={path} />
      <PreviewCheck path={path} row={row} />
      <ExplainCheck path={path} />
      {row.mode === 'snapshot' && <FreezeCheck path={path} row={row} />}
    </section>
  );
}
