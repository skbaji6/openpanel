import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  describeMarketingError,
  MarketingApiError,
  useMarketingFetch,
  useMarketingQueryKey,
} from './api';
import { SECRET_MASK } from './contract';
import { InputWithLabel, WithLabel } from '@/components/forms/input-with-label';
import {
  IntegrationCardFooter,
  IntegrationCardHeader,
} from '@/components/integrations/integration-card';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type SourceKind = 'stored' | 'http';

interface AudienceSource {
  kind: SourceKind;
  baseUrl: string | null;
  keyId: string | null;
  hasSecret: boolean;
  status: string;
}

type TestResult =
  | { ok: true; dimensions: unknown[]; latencyMs: number }
  | { ok: false; error: string };

const KIND_LABELS: Record<SourceKind, string> = {
  stored: 'Stored contacts',
  http: 'HTTP API',
};

const FAILURE_MESSAGES: Record<string, string> = {
  source_auth_failed: 'The source rejected our key',
  unreachable: 'Could not reach the source',
  protocol_error: 'The source answered in an unexpected format',
  not_configured: 'Save the source first',
};

const SAVE_ERROR_MESSAGES: Record<string, string> = {
  invalid_body: 'Fill in the base URL, key id and secret',
  invalid_base_url:
    'The base URL must be https (http is only allowed for localhost) and have no credentials, query or fragment',
};

function failureMessage(code: string): string {
  return FAILURE_MESSAGES[code] ?? 'The test failed';
}

function saveErrorMessage(error: unknown): string {
  if (error instanceof MarketingApiError && SAVE_ERROR_MESSAGES[error.code]) {
    return SAVE_ERROR_MESSAGES[error.code];
  }
  return describeMarketingError(error);
}

// Keyed on saved values so a background refetch keeps edits but a save refreshes the form.
function savedKey(source: AudienceSource): string {
  return JSON.stringify([
    source.kind,
    source.baseUrl,
    source.keyId,
    source.hasSecret,
  ]);
}

function AudienceSourceForm({ loaded }: { loaded: AudienceSource }) {
  const marketingFetch = useMarketingFetch();
  const queryKey = useMarketingQueryKey();
  const client = useQueryClient();
  const [kind, setKind] = useState<SourceKind>(loaded.kind);
  const [baseUrl, setBaseUrl] = useState(loaded.baseUrl ?? '');
  const [keyId, setKeyId] = useState(loaded.keyId ?? '');
  const [secret, setSecret] = useState('');
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const hasUnsavedChanges =
    kind !== loaded.kind ||
    secret !== '' ||
    (kind === 'http' &&
      (baseUrl !== (loaded.baseUrl ?? '') || keyId !== (loaded.keyId ?? '')));

  const save = useMutation({
    mutationFn: () =>
      marketingFetch<AudienceSource>('audience-source', {
        method: 'PUT',
        // An empty secret is left out so the service keeps the stored one.
        body: JSON.stringify(
          kind === 'http'
            ? { kind, baseUrl, keyId, ...(secret ? { secret } : {}) }
            : { kind }
        ),
      }),
    onSuccess() {
      setSecret('');
      setTestResult(null);
      toast.success('Audience source saved');
      client.invalidateQueries({ queryKey: queryKey('audience-source') });
    },
    onError: (error) => toast.error(saveErrorMessage(error)),
  });

  const test = useMutation({
    mutationFn: () =>
      marketingFetch<TestResult>('audience-source/test', { method: 'POST' }),
    onSuccess: setTestResult,
    onError(error) {
      // not_configured arrives as a 400 with the code in the body.
      const code = error instanceof MarketingApiError ? error.code : '';
      setTestResult({ ok: false, error: code });
    },
  });

  return (
    <form
      className="col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <div className="col gap-4 p-4">
        {loaded.status === 'source_auth_failed' && (
          <p className="text-destructive text-sm" role="alert">
            The source rejected our key. Check the key id and secret.
          </p>
        )}
        <WithLabel id="audience-source-kind" label="Where contacts come from">
          <Select
            onValueChange={(value) => setKind(value as SourceKind)}
            value={kind}
          >
            <SelectTrigger id="audience-source-kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(KIND_LABELS) as SourceKind[]).map((option) => (
                <SelectItem key={option} value={option}>
                  {KIND_LABELS[option]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </WithLabel>
        {kind === 'http' && (
          <>
            <InputWithLabel
              autoComplete="off"
              label="Base URL"
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://api.example.com/audience"
              value={baseUrl}
            />
            <InputWithLabel
              autoComplete="off"
              label="Key id"
              onChange={(event) => setKeyId(event.target.value)}
              value={keyId}
            />
            <InputWithLabel
              autoComplete="new-password"
              hint={
                loaded.hasSecret
                  ? 'Secret saved. Leave empty to keep it.'
                  : undefined
              }
              label="Secret"
              onChange={(event) => setSecret(event.target.value)}
              placeholder={loaded.hasSecret ? SECRET_MASK : undefined}
              type="password"
              value={secret}
            />
          </>
        )}
        {testResult && (
          <p
            className={testResult.ok ? 'text-sm' : 'text-destructive text-sm'}
            role="status"
          >
            {testResult.ok
              ? `Connected: ${testResult.dimensions.length} dimensions, ${testResult.latencyMs} ms`
              : failureMessage(testResult.error)}
          </p>
        )}
      </div>
      <IntegrationCardFooter className="justify-end">
        {loaded.kind === 'http' && (
          <>
            <Button
              disabled={hasUnsavedChanges || save.isPending}
              loading={test.isPending}
              onClick={() => test.mutate()}
              type="button"
              variant="outline"
            >
              Test connection
            </Button>
            <span className="text-muted-foreground text-xs">
              Tests the saved settings — save first
            </span>
          </>
        )}
        <Button loading={save.isPending} type="submit">
          Save
        </Button>
      </IntegrationCardFooter>
    </form>
  );
}

export function AudienceSourceCard() {
  const marketingFetch = useMarketingFetch();
  const queryKey = useMarketingQueryKey();
  const source = useQuery({
    queryKey: queryKey('audience-source'),
    queryFn: () => marketingFetch<AudienceSource>('audience-source'),
    retry: false,
  });
  return (
    <section aria-label="Audience source" className="card">
      <IntegrationCardHeader>
        <h2 className="title">Audience source</h2>
      </IntegrationCardHeader>
      {source.error && (
        <p className="p-4 text-destructive text-sm">
          {describeMarketingError(source.error)}
        </p>
      )}
      {source.data && (
        <AudienceSourceForm key={savedKey(source.data)} loaded={source.data} />
      )}
    </section>
  );
}
