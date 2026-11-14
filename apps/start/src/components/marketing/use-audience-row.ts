import { useQueryClient } from '@tanstack/react-query';
import { useMarketingQueryKey } from './api';
import type { AudienceRow } from './campaign-contract';

// Every write answers with the new row; keeping it in the cache keeps expectedVersion current.
export function useAudienceRow(row: AudienceRow) {
  const queryKey = useMarketingQueryKey();
  const client = useQueryClient();
  const rowKey = queryKey('audiences', row.id);
  return {
    rowKey,
    currentVersion: () =>
      client.getQueryData<AudienceRow>(rowKey)?.version ?? row.version,
    store: (saved: AudienceRow) => {
      client.setQueryData(rowKey, saved);
      client.invalidateQueries({
        queryKey: queryKey('audiences'),
        exact: true,
      });
    },
    reload: () => client.invalidateQueries({ queryKey: rowKey }),
  };
}
