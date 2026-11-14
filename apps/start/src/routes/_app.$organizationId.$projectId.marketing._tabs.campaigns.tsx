import { createFileRoute } from '@tanstack/react-router';
import { CampaignsPage } from '@/components/marketing/campaigns-page';

export const Route = createFileRoute(
  '/_app/$organizationId/$projectId/marketing/_tabs/campaigns'
)({
  component: CampaignsPage,
});
