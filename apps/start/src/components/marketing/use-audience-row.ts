import { useQueryClient } from '@tanstack/react-query';
import { MarketingApiError, useMarketingQueryKey } from './api';
import type { AudienceRow } from './campaign-contract';

const VERSION_CONFLICT = 'version_conflict';

export const isVersionConflict = (error: unknown) =>
  error instanceof MarketingApiError && error.code === VERSION_CONFLICT;

// Every write answers with the new row; keeping it in the cache keeps expectedVersion current.
export function useAudienceRow() {
  const queryKey = useMarketingQueryKey();
  const client = useQueryClient();
  const keyOf = (id: string) => queryKey('audiences', id);
  return {
    currentVersion: (row: AudienceRow) =>
      client.getQueryData<AudienceRow>(keyOf(row.id))?.version ?? row.version,
    store: (saved: AudienceRow) => {
      client.setQueryData(keyOf(saved.id), saved);
      client.invalidateQueries({
        queryKey: queryKey('audiences'),
        exact: true,
      });
    },
    reload: (id: string) => client.invalidateQueries({ queryKey: keyOf(id) }),
  };
}
