import { useId, useState } from 'react';
import { describeMarketingError, useMarketingFetch } from './api';
import { formatCount } from './audience-filter';
import {
  addIdsInChunks,
  describePasteError,
  describeProgress,
  describeSent,
  listCapacityProblem,
  looksLikeContacts,
  parseContactInput,
  parseIdLines,
  resolveContacts,
} from './audience-paste';
import {
  type AudienceRow,
  MAX_LIST_IDS,
  type ResolveResponse,
} from './campaign-contract';
import { isVersionConflict, useAudienceRow } from './use-audience-row';
import { WithLabel } from '@/components/forms/input-with-label';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { showConfirm } from '@/modals';

type IdList = 'include' | 'exclude';
type PasteKind = 'ids' | 'contacts';

const MAX_LINES_SHOWN = 20;
const CONFLICT_TEXT =
  'Someone else changed this audience. It was reloaded; check the list and try again.';
const CONTACTS_AS_IDS =
  "These look like phone numbers or emails. Choose 'Phone numbers or emails' so they are matched to students and never stored.";
const CONTACTS_REPASTE =
  'The pasted contacts were cleared after matching; paste them again once the list has room.';
const RESOLVE_FAILED_SUFFIX =
  'The pasted contacts were cleared; paste them again to retry.';
const KIND_HINTS: Record<PasteKind | 'none', string> = {
  none: 'Choose what you are pasting first.',
  ids: 'Paste student ids only. A phone number typed as digits would be stored as if it were an id.',
  contacts:
    'Matched by the audience API; only the matching student ids are kept, the contacts are not stored.',
};
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

const writeErrorText = (error: unknown) =>
  isVersionConflict(error) ? CONFLICT_TEXT : describeMarketingError(error);

interface Outcome {
  matched?: number;
  notFoundLines?: number[];
  tooLongLines?: number[];
  sent?: number;
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
      {outcome.sent !== undefined && <p>{describeSent(outcome.sent)}</p>}
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
  onBusyChange,
}: {
  row: AudienceRow;
  list: IdList;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const marketingFetch = useMarketingFetch();
  const cache = useAudienceRow();
  const fieldId = useId();
  // Pasted contacts live only here until resolved; they never reach the query cache, a URL or a toast.
  const [text, setText] = useState('');
  const [kind, setKind] = useState<PasteKind | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const size = list === 'include' ? row.includeCount : row.excludeCount;
  const busy = progress !== null;

  const changeIds = (body: Record<string, unknown>, expectedVersion: number) =>
    marketingFetch<AudienceRow>(`audiences/${encodeURIComponent(row.id)}/ids`, {
      method: 'POST',
      body: JSON.stringify({ list, ...body, expectedVersion }),
    });

  const reloadOnConflict = (error: unknown) => {
    if (isVersionConflict(error)) {
      cache.reload(row.id);
    }
  };

  const addIds = async (ids: string[], base: Outcome) => {
    let sent = 0;
    try {
      await addIdsInChunks({
        ids,
        version: cache.currentVersion(row),
        post: (chunk, expectedVersion) =>
          changeIds({ add: chunk }, expectedVersion),
        onChunk: (saved, done) => {
          sent = done;
          cache.store(saved);
          setProgress(describeProgress('Adding', done, ids.length));
        },
      });
      setOutcome({ ...base, sent });
    } catch (error) {
      reloadOnConflict(error);
      setOutcome({ ...base, sent, error: writeErrorText(error) });
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
      setText('');
      setOutcome({
        error: `${describePasteError(error)} ${RESOLVE_FAILED_SUFFIX}`,
      });
      return;
    }
    setText('');
    const outcome = {
      matched: resolved.ids.length,
      notFoundLines: resolved.unmatchedLines,
      tooLongLines,
    };
    const capacity = listCapacityProblem(size, resolved.ids.length);
    if (capacity) {
      setOutcome({ ...outcome, error: `${capacity} ${CONTACTS_REPASTE}` });
      return;
    }
    await addIds(resolved.ids, outcome);
  };

  const addPastedIds = async () => {
    if (looksLikeContacts(text)) {
      setOutcome({ error: CONTACTS_AS_IDS });
      return;
    }
    const { ids, tooLongLines } = parseIdLines(text);
    // Refused pastes stay in the box so the operator can trim them.
    const capacity = listCapacityProblem(size, ids.length);
    if (capacity) {
      setOutcome({ tooLongLines, error: capacity });
      return;
    }
    setText('');
    await addIds(ids, { tooLongLines });
  };

  const add = async () => {
    setOutcome(null);
    setProgress('Working');
    onBusyChange(true);
    try {
      await (kind === 'contacts' ? addContacts() : addPastedIds());
    } finally {
      setProgress(null);
      onBusyChange(false);
    }
  };

  const clear = async () => {
    setOutcome(null);
    try {
      cache.store(await changeIds({ clear: true }, cache.currentVersion(row)));
    } catch (error) {
      reloadOnConflict(error);
      setOutcome({ error: writeErrorText(error) });
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
          hint={KIND_HINTS[kind ?? 'none']}
          id={`${fieldId}-kind`}
          label="What are you pasting?"
        >
          <select
            className="h-8 self-start rounded-md border bg-background px-2 text-sm"
            id={`${fieldId}-kind`}
            onChange={(event) => {
              const picked = event.target.value;
              setKind(
                picked === 'ids' || picked === 'contacts' ? picked : null
              );
            }}
            value={kind ?? ''}
          >
            <option value="">Choose</option>
            <option value="ids">Student ids</option>
            <option value="contacts">Phone numbers or emails</option>
          </select>
        </WithLabel>
        <WithLabel
          hint={
            kind === 'contacts'
              ? 'One phone number or email per line, or separated by commas'
              : 'One id per line, or separated by commas or spaces'
          }
          id={`${fieldId}-paste`}
          label="Paste"
        >
          <Textarea
            autoComplete="off"
            disabled={kind === null}
            id={`${fieldId}-paste`}
            onChange={(event) => setText(event.target.value)}
            rows={4}
            spellCheck={false}
            value={text}
          />
        </WithLabel>
        <div className="row items-center gap-2">
          <Button
            disabled={kind === null || text.trim() === ''}
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
