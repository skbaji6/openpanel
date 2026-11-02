import { createFileRoute } from '@tanstack/react-router';
import { RulesPage } from '@/components/marketing/rules-page';

export const Route = createFileRoute(
  '/_app/$organizationId/$projectId/marketing/_tabs/'
)({
  component: RulesPage,
});
