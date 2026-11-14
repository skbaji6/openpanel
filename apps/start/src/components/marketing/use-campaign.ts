import { useQuery } from '@tanstack/react-query';
import {
  MarketingApiError,
  useMarketingFetch,
  useMarketingQueryKey,
} from './api';
import type { AudienceRow, CampaignRow } from './campaign-contract';

const NOT_FOUND = 404;

export function campaignLoadErrorTitle(error: unknown): string {
  const notFound =
    error instanceof MarketingApiError && error.status === NOT_FOUND;
  return notFound ? 'Campaign not found' : 'Could not load the campaign';
}

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
