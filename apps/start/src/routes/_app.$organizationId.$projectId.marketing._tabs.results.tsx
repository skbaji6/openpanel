import { createFileRoute } from '@tanstack/react-router';
import { ResultsPage } from '@/components/marketing/results-page';

export const Route = createFileRoute(
  '/_app/$organizationId/$projectId/marketing/_tabs/results'
)({
  component: ResultsPage,
});
