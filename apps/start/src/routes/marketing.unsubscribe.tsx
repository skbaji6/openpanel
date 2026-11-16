import { createFileRoute } from '@tanstack/react-router';
import { createUnsubscribeProxy } from '@/components/marketing/unsubscribe-proxy';

// Read per request: the Cloudflare plugin injects env at runtime. Blank counts as unset.
const proxy = createUnsubscribeProxy({
  marketingUrl: () => process.env.MARKETING_URL || undefined,
});

function handle({ request }: { request: Request }) {
  return proxy.handle(request);
}

export const Route = createFileRoute('/marketing/unsubscribe')({
  server: {
    handlers: {
      GET: handle,
      POST: handle,
    },
  },
});
