import { createFileRoute } from '@tanstack/react-router';
import { TemplatesPage } from '@/components/marketing/templates-page';

interface TemplatesSearch {
  channel?: 'sms' | 'whatsapp' | 'push' | 'email';
  id?: string;
  new?: true;
}

export const Route = createFileRoute(
  '/_app/$organizationId/$projectId/marketing/_tabs/templates'
)({
  component: TemplatesPage,
  validateSearch: (search: Record<string, unknown>): TemplatesSearch => ({
    channel:
      search.channel === 'sms' ||
      search.channel === 'whatsapp' ||
      search.channel === 'push' ||
      search.channel === 'email'
        ? search.channel
        : undefined,
    id: typeof search.id === 'string' ? search.id : undefined,
    new: search.new === true || search.new === 1 || search.new === '1' ? true : undefined,
  }),
});
