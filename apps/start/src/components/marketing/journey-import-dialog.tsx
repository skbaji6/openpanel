import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import {
  describeMarketingError,
  useMarketingFetch,
  useMarketingQueryKey,
} from './api';
import type { DimensionValue } from './campaign-contract';
import {
  type ImportReport,
  type ImportRequest,
  MAX_IMPORT_BYTES,
} from './contract';
import {
  defaultStateMapping,
  fileToBase64,
  formatOf,
  summarizeImport,
} from './journey-import';
import { NOT_ADMIN_NOTE, useMarketingRole } from './use-marketing-role';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const STATE_DIMENSION = 'state';
const NOT_MAPPED = '';
const TOO_LARGE_NOTE = `That file is larger than ${MAX_IMPORT_BYTES / 1024} KiB. Remove unused sheets or rows and try again.`;
const WRONG_TYPE_NOTE = 'Choose an .xlsx or .csv file.';

interface Chosen {
  name: string;
  format: 'xlsx' | 'csv';
  contentBase64: string;
}

export function JourneyImportDialog({ onClose }: { onClose: () => void }) {
  const marketingFetch = useMarketingFetch();
  const queryKey = useMarketingQueryKey();
  const client = useQueryClient();
  const { isAdmin } = useMarketingRole();
  const fieldId = useId();
  const [chosen, setChosen] = useState<Chosen | null>(null);
  const [fileNote, setFileNote] = useState<string | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [overwriteEdited, setOverwriteEdited] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [checkedSignature, setCheckedSignature] = useState<string | null>(null);

  const states = useQuery({
    queryKey: queryKey('audience-values', STATE_DIMENSION, ''),
    queryFn: () =>
      marketingFetch<{ values: DimensionValue[] }>(
        `audience/dimensions/${STATE_DIMENSION}/values`
      ),
  });
  const stateValues = states.data?.values ?? [];

  const signatureOf = (file: Chosen | null) =>
    JSON.stringify([
      file?.contentBase64.length,
      file?.name,
      mapping,
      overwriteEdited,
    ]);

  const run = useMutation({
    mutationFn: (request: ImportRequest) =>
      marketingFetch<ImportReport>('rules/import', {
        method: 'POST',
        body: JSON.stringify(request),
      }),
    onError: (error) => toast.error(describeMarketingError(error)),
  });

  const requestFor = (
    file: Chosen,
    dryRun: boolean,
    stateMap: Record<string, string>
  ): ImportRequest => ({
    format: file.format,
    contentBase64: file.contentBase64,
    dryRun,
    options: {
      states: Object.fromEntries(
        Object.entries(stateMap).filter(([, value]) => value !== NOT_MAPPED)
      ),
      overwriteEdited,
    },
  });

  const choose = async (file: File | undefined) => {
    setReport(null);
    setCheckedSignature(null);
    setChosen(null);
    setFileNote(null);
    if (!file) {
      return;
    }
    const format = formatOf(file.name);
    if (!format) {
      setFileNote(WRONG_TYPE_NOTE);
      return;
    }
    // Checked before reading so an oversized file never enters memory.
    if (file.size > MAX_IMPORT_BYTES) {
      setFileNote(TOO_LARGE_NOTE);
      return;
    }
    const next: Chosen = {
      name: file.name,
      format,
      contentBase64: fileToBase64(new Uint8Array(await file.arrayBuffer())),
    };
    setChosen(next);
    // A first check with no mapping only discovers the sheet names.
    const discovered = await run
      .mutateAsync(requestFor(next, true, {}))
      .catch(() => null);
    if (discovered) {
      setMapping(defaultStateMapping(discovered.sheets, stateValues));
      setReport(discovered);
    }
  };

  const check = async () => {
    if (!chosen) {
      return;
    }
    const result = await run
      .mutateAsync(requestFor(chosen, true, mapping))
      .catch(() => null);
    if (result) {
      setReport(result);
      setCheckedSignature(signatureOf(chosen));
    }
  };

  const importNow = async () => {
    if (!chosen) {
      return;
    }
    const result = await run
      .mutateAsync(requestFor(chosen, false, mapping))
      .catch(() => null);
    if (!result) {
      return;
    }
    client.invalidateQueries({ queryKey: queryKey('rules') });
    toast.success('Journeys imported as drafts');
    onClose();
  };

  const summary = report ? summarizeImport(report) : null;
  const canImport =
    isAdmin && chosen !== null && checkedSignature === signatureOf(chosen);
  const sheets = report?.sheets ?? [];

  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import journeys</DialogTitle>
          <DialogDescription>
            Reads the journey workbook and saves each journey as a draft.
            Nothing is sent until you start a journey.
          </DialogDescription>
        </DialogHeader>
        <div className="col gap-1">
          <label className="font-medium text-sm" htmlFor={`${fieldId}-file`}>
            Workbook file
          </label>
          <input
            accept=".xlsx,.csv"
            disabled={!isAdmin}
            id={`${fieldId}-file`}
            onChange={(event) => choose(event.target.files?.[0])}
            type="file"
          />
          <p className="text-muted-foreground text-xs">
            An .xlsx or .csv file up to {MAX_IMPORT_BYTES / 1024} KiB.
          </p>
          {fileNote && (
            <p className="text-destructive text-sm" role="alert">
              {fileNote}
            </p>
          )}
        </div>
        {sheets.length > 0 && (
          <fieldset className="col gap-2">
            <legend className="font-medium text-sm">State of each sheet</legend>
            <p className="text-muted-foreground text-xs">
              Each sheet holds the messages for one state. Pick the state it
              belongs to; a sheet left unmapped is skipped.
            </p>
            {states.error && (
              <p className="text-destructive text-sm" role="alert">
                {describeMarketingError(states.error)}
              </p>
            )}
            {sheets.map((sheet) => (
              <label
                className="row items-center justify-between gap-2 text-sm"
                key={sheet}
              >
                {sheet}
                <select
                  className="h-8 rounded-md border bg-background px-2 text-sm"
                  onChange={(event) =>
                    setMapping((current) => ({
                      ...current,
                      [sheet]: event.target.value,
                    }))
                  }
                  value={mapping[sheet] ?? NOT_MAPPED}
                >
                  <option value={NOT_MAPPED}>Not mapped</option>
                  {stateValues.map((state) => (
                    <option key={state.value} value={state.value}>
                      {state.label}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </fieldset>
        )}
        <label className="col gap-1 text-sm">
          <span className="row items-center gap-2">
            <input
              checked={overwriteEdited}
              onChange={(event) => setOverwriteEdited(event.target.checked)}
              type="checkbox"
            />
            Overwrite drafts edited here
          </span>
          <span className="text-muted-foreground text-xs">
            By default a draft you changed in the dashboard is kept as it is.
            Tick this to replace it with the workbook version. Running journeys
            are never touched.
          </span>
        </label>
        {summary && (
          <section aria-label="Check result" className="col gap-2 text-sm">
            <p>
              {summary.created} new, {summary.updated} updated,{' '}
              {summary.unchanged} unchanged.
            </p>
            {summary.skippedLive.length > 0 && (
              <p>Running, left alone: {summary.skippedLive.join(', ')}</p>
            )}
            {summary.skippedEdited.length > 0 && (
              <p>
                Edited here, kept: {summary.skippedEdited.join(', ')}. Tick
                Overwrite to replace them.
              </p>
            )}
            {Object.entries(summary.problemsBySheet).map(
              ([sheet, problems]) => (
                <div key={sheet}>
                  <h3 className="font-medium">{sheet || 'Whole file'}</h3>
                  <ul className="list-disc pl-5">
                    {problems.map((problem, index) => (
                      <li key={`${problem.row ?? 'sheet'}-${index}`}>
                        {problem.row === null ? '' : `Row ${problem.row}: `}
                        {problem.label}
                      </li>
                    ))}
                  </ul>
                </div>
              )
            )}
          </section>
        )}
        <DialogFooter className="items-center">
          {!isAdmin && (
            <span className="text-muted-foreground text-xs">
              {NOT_ADMIN_NOTE}
            </span>
          )}
          <Button onClick={onClose} variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={!isAdmin || chosen === null}
            loading={run.isPending}
            onClick={check}
            title={isAdmin ? undefined : NOT_ADMIN_NOTE}
            variant="outline"
          >
            Check
          </Button>
          <Button
            disabled={!canImport || run.isPending}
            onClick={importNow}
            title={isAdmin ? undefined : NOT_ADMIN_NOTE}
          >
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
