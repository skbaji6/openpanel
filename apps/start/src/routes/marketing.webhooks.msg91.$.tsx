import { createFileRoute } from '@tanstack/react-router';
import { createTrackingProxy } from '@/components/marketing/tracking-proxy';

const proxy = createTrackingProxy({
  marketingUrl: () => process.env.MARKETING_URL || undefined,
});

export const Route = createFileRoute('/marketing/webhooks/msg91/$')({
  server: {
    handlers: {
      POST: ({ request }: { request: Request }) => proxy.handle(request),
    },
  },
});
