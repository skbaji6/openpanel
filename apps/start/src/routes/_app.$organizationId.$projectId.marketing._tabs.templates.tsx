import { createFileRoute } from '@tanstack/react-router';
import { TemplatesPage } from '@/components/marketing/templates-page';

export const Route = createFileRoute(
  '/_app/$organizationId/$projectId/marketing/_tabs/templates'
)({
  component: TemplatesPage,
});
