import { createFileRoute } from '@tanstack/react-router';
import { RulesPage } from '@/components/nudge/rules-page';

export const Route = createFileRoute(
  '/_app/$organizationId/$projectId/nudge/_tabs/'
)({
  component: RulesPage,
});
