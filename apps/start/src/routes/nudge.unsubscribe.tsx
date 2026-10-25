import { createFileRoute } from '@tanstack/react-router';
import { createUnsubscribeProxy } from '@/components/nudge/unsubscribe-proxy';

// Read per request: the Cloudflare plugin injects env at runtime. Blank counts as unset.
const proxy = createUnsubscribeProxy({
  nudgeUrl: () => process.env.NUDGE_URL || undefined,
});

function handle({ request }: { request: Request }) {
  return proxy.handle(request);
}

export const Route = createFileRoute('/nudge/unsubscribe')({
  server: {
    handlers: {
      GET: handle,
      POST: handle,
    },
  },
});
