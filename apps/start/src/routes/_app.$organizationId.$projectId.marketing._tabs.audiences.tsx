import { createFileRoute } from '@tanstack/react-router';
import { AudiencesPage } from '@/components/marketing/audiences-page';

interface AudiencesSearch {
  id?: string;
  new?: true;
}

export const Route = createFileRoute(
  '/_app/$organizationId/$projectId/marketing/_tabs/audiences'
)({
  component: AudiencesPage,
  validateSearch: (search: Record<string, unknown>): AudiencesSearch => ({
    id: typeof search.id === 'string' ? search.id : undefined,
    new: search.new === true || search.new === 1 || search.new === '1' ? true : undefined,
  }),
});
