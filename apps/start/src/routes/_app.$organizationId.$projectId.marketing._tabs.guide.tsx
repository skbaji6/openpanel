import { createFileRoute } from '@tanstack/react-router';
import { GuidePage } from '@/components/marketing/guide-page';

export const Route = createFileRoute(
  '/_app/$organizationId/$projectId/marketing/_tabs/guide'
)({
  component: GuidePage,
});
