import { createFileRoute } from '@tanstack/react-router';
import { AudiencesPage } from '@/components/marketing/audiences-page';

export const Route = createFileRoute(
  '/_app/$organizationId/$projectId/marketing/_tabs/audiences'
)({
  component: AudiencesPage,
});
