import { useQuery } from '@tanstack/react-query';
import { useMarketingFetch, useMarketingQueryKey } from './api';
import type { AudienceRow, CampaignRow } from './campaign-contract';

export function useCampaign(campaignId: string) {
  const marketingFetch = useMarketingFetch();
  const queryKey = useMarketingQueryKey();
  return useQuery({
    queryKey: queryKey('campaigns', campaignId),
    queryFn: () =>
      marketingFetch<CampaignRow>(
        `campaigns/${encodeURIComponent(campaignId)}`
      ),
    retry: false,
  });
}

export function useAudiences() {
  const marketingFetch = useMarketingFetch();
  const queryKey = useMarketingQueryKey();
  return useQuery({
    queryKey: queryKey('audiences'),
    queryFn: () => marketingFetch<{ audiences: AudienceRow[] }>('audiences'),
  });
}
