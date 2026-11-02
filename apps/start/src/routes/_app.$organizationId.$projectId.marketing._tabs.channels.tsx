import { createFileRoute } from '@tanstack/react-router';
import { ChannelsPage } from '@/components/marketing/channels-page';

export const Route = createFileRoute(
  '/_app/$organizationId/$projectId/marketing/_tabs/channels'
)({
  component: ChannelsPage,
});
