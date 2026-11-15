import { createFileRoute } from '@tanstack/react-router';
import { createTrackingProxy } from '@/components/marketing/tracking-proxy';

// Read per request: the Cloudflare plugin injects env at runtime. Blank counts as unset.
const proxy = createTrackingProxy({
  marketingUrl: () => process.env.MARKETING_URL || undefined,
});

export const Route = createFileRoute('/marketing/r/$token')({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) => proxy.handle(request),
    },
  },
});
