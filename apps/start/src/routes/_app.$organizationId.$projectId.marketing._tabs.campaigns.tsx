import { createFileRoute } from '@tanstack/react-router';
import { CampaignsPage } from '@/components/marketing/campaigns-page';

interface CampaignsSearch {
  id?: string;
  new?: true;
}

export const Route = createFileRoute(
  '/_app/$organizationId/$projectId/marketing/_tabs/campaigns'
)({
  component: CampaignsPage,
  validateSearch: (search: Record<string, unknown>): CampaignsSearch => ({
    id: typeof search.id === 'string' ? search.id : undefined,
    new:
      search.new === true || search.new === 1 || search.new === '1'
        ? true
        : undefined,
  }),
});
