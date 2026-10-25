import { createFileRoute } from '@tanstack/react-router';
import { ResultsPage } from '@/components/nudge/results-page';

export const Route = createFileRoute(
  '/_app/$organizationId/$projectId/nudge/_tabs/results'
)({
  component: ResultsPage,
});
