import { createFileRoute } from '@tanstack/react-router';
import { ChannelsPage } from '@/components/nudge/channels-page';

export const Route = createFileRoute(
  '/_app/$organizationId/$projectId/nudge/_tabs/channels'
)({
  component: ChannelsPage,
});
