import { useId, useState } from 'react';
import {
  describeMarketingError,
  MarketingApiError,
  useMarketingFetch,
} from './api';
import { formatCount, parseIdInput } from './audience-filter';
import {
  addIdsInChunks,
  describePasteError,
  describeProgress,
  parseContactInput,
  resolveContacts,
} from './audience-paste';
import {
  type AudienceRow,
  MAX_LIST_IDS,
  type ResolveResponse,
} from './campaign-contract';
import { useAudienceRow } from './use-audience-row';
import { WithLabel } from '@/components/forms/input-with-label';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { showConfirm } from '@/modals';

type IdList = 'include' | 'exclude';
type PasteKind = 'ids' | 'contacts';

const VERSION_CONFLICT = 'version_conflict';
const MAX_LINES_SHOWN = 20;
const LIST_COPY: Record<IdList, { title: string; hint: string }> = {
  include: {
    title: 'Add specific students',
    hint: 'These students are in even when the filter does not match them.',
  },
  exclude: {
    title: 'Always leave out',
    hint: 'These students never receive this campaign, whatever the filters say.',
  },
};

interface Outcome {
  matched?: number;
  notFoundLines?: number[];
  tooLongLines?: number[];
  added?: number;
  error?: string;
}

function describeLines(lines: number[]): string {
  const shown = lines.slice(0, MAX_LINES_SHOWN).join(', ');
  const more = lines.length - MAX_LINES_SHOWN;
  return more > 0 ? `${shown} and ${formatCount(more)} more` : shown;
}

function OutcomeText({ outcome }: { outcome: Outcome }) {
  const notFound = outcome.notFoundLines ?? [];
  const tooLong = outcome.tooLongLines ?? [];
  return (
    <div className="col gap-1 text-sm" role="status">
      {outcome.matched !== undefined && (
        <p>
          {formatCount(outcome.matched)} matched, {formatCount(notFound.length)}{' '}
          not found
        </p>
      )}
      {notFound.length > 0 && (
        <p className="text-muted-foreground text-xs">
          Not found on lines {describeLines(notFound)}
        </p>
      )}
      {tooLong.length > 0 && (
        <p className="text-muted-foreground text-xs">
          Skipped as too long on lines {describeLines(tooLong)}
        </p>
      )}
      {outcome.added !== undefined && (
        <p>{formatCount(outcome.added)} added to the list</p>
      )}
      {outcome.error && (
        <p className="text-destructive" role="alert">
          {outcome.error}
        </p>
      )}
    </div>
  );
}

export function AudienceList({
  row,
  list,
  disabled,
}: {
  row: AudienceRow;
  list: IdList;
  disabled: boolean;
}) {
  const marketingFetch = useMarketingFetch();
  const cache = useAudienceRow(row);
  const fieldId = useId();
  // Pasted contacts live only here until resolved; they never reach the query cache, a URL or a toast.
  const [text, setText] = useState('');
  const [kind, setKind] = useState<PasteKind>('ids');
  const [progress, setProgress] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const size = list === 'include' ? row.includeCount : row.excludeCount;
  const busy = progress !== null;

  const changeIds = (body: Record<string, unknown>, expectedVersion: number) =>
    marketingFetch<AudienceRow>(`audiences/${encodeURIComponent(row.id)}/ids`, {
      method: 'POST',
      body: JSON.stringify({ list, ...body, expectedVersion }),
    });

  const describeWriteError = (error: unknown) => {
    if (error instanceof MarketingApiError && error.code === VERSION_CONFLICT) {
      cache.reload();
      return 'Someone else changed this audience. It was reloaded; check the list and try again.';
    }
    return describeMarketingError(error);
  };

  const addIds = async (ids: string[], base: Outcome) => {
    let added = 0;
    try {
      await addIdsInChunks({
        ids,
        version: cache.currentVersion(),
        post: (chunk, expectedVersion) =>
          changeIds({ add: chunk }, expectedVersion),
        onChunk: (saved, done) => {
          added = done;
          cache.store(saved);
          setProgress(describeProgress('Adding', done, ids.length));
        },
      });
      setOutcome({ ...base, added });
    } catch (error) {
      setOutcome({ ...base, added, error: describeWriteError(error) });
    }
  };

  const resolveChunk = (inputs: string[]) =>
    marketingFetch<ResolveResponse>('audience/resolve', {
      method: 'POST',
      body: JSON.stringify({ inputs }),
    });

  const addContacts = async () => {
    const { entries, tooLongLines } = parseContactInput(text);
    let resolved: { ids: string[]; unmatchedLines: number[] };
    try {
      resolved = await resolveContacts(entries, resolveChunk, (done) =>
        setProgress(describeProgress('Checking', done, entries.length))
      );
    } catch (error) {
      setOutcome({ error: describePasteError(error) });
      return;
    }
    setText('');
    await addIds(resolved.ids, {
      matched: resolved.ids.length,
      notFoundLines: resolved.unmatchedLines,
      tooLongLines,
    });
  };

  const add = async () => {
    setOutcome(null);
    setProgress('Working');
    try {
      if (kind === 'contacts') {
        await addContacts();
        return;
      }
      const ids = parseIdInput(text);
      setText('');
      await addIds(ids, {});
    } finally {
      setProgress(null);
    }
  };

  const clear = async () => {
    setOutcome(null);
    try {
      cache.store(await changeIds({ clear: true }, cache.currentVersion()));
    } catch (error) {
      setOutcome({ error: describeWriteError(error) });
    }
  };

  const copy = LIST_COPY[list];
  return (
    <section aria-label={copy.title} className="col gap-3 border-t p-4">
      <div className="row items-center justify-between gap-2">
        <h3 className="font-medium text-sm">{copy.title}</h3>
        <span className="text-muted-foreground text-xs">
          {formatCount(size)} on this list, at most {formatCount(MAX_LIST_IDS)}
        </span>
      </div>
      <p className="text-muted-foreground text-xs">{copy.hint}</p>
      <fieldset className="col gap-3" disabled={disabled || busy}>
        <WithLabel
          hint="Phone numbers and emails are matched by the audience API; only the matching student ids are kept."
          id={`${fieldId}-kind`}
          label="What are you pasting?"
        >
          <select
            className="h-8 self-start rounded-md border bg-background px-2 text-sm"
            id={`${fieldId}-kind`}
            onChange={(event) =>
              setKind(event.target.value === 'contacts' ? 'contacts' : 'ids')
            }
            value={kind}
          >
            <option value="ids">Student ids</option>
            <option value="contacts">Phone numbers or emails</option>
          </select>
        </WithLabel>
        <WithLabel
          hint={
            kind === 'ids'
              ? 'One id per line, or separated by commas or spaces'
              : 'One phone number or email per line, or separated by commas'
          }
          id={`${fieldId}-paste`}
          label="Paste"
        >
          <Textarea
            autoComplete="off"
            id={`${fieldId}-paste`}
            onChange={(event) => setText(event.target.value)}
            rows={4}
            spellCheck={false}
            value={text}
          />
        </WithLabel>
        <div className="row items-center gap-2">
          <Button
            disabled={text.trim() === ''}
            loading={busy}
            onClick={add}
            type="button"
            variant="outline"
          >
            Add to list
          </Button>
          <Button
            disabled={size === 0}
            onClick={() =>
              showConfirm({
                title: `Clear "${copy.title}"?`,
                text: `All ${formatCount(size)} students are removed from this list.`,
                onConfirm: clear,
              })
            }
            type="button"
            variant="ghost"
          >
            Clear list
          </Button>
          {progress && (
            <span className="text-muted-foreground text-xs" role="status">
              {progress}
            </span>
          )}
        </div>
      </fieldset>
      {outcome && <OutcomeText outcome={outcome} />}
    </section>
  );
}
