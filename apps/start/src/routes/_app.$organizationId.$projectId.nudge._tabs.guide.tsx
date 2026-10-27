import { createFileRoute } from '@tanstack/react-router';
import { GuidePage } from '@/components/nudge/guide-page';

export const Route = createFileRoute(
  '/_app/$organizationId/$projectId/nudge/_tabs/guide'
)({
  component: GuidePage,
});
