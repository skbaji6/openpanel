import { createFileRoute } from '@tanstack/react-router';
import { createMarketingProxy } from '@/components/marketing/proxy';

// Read per request: the Cloudflare plugin injects env at runtime. Blank counts as unset.
const proxy = createMarketingProxy({
  env: () => ({
    marketingUrl: process.env.MARKETING_URL || undefined,
    proxySecret: process.env.MARKETING_PROXY_SECRET || undefined,
    apiUrl: process.env.API_URL_SSR || process.env.API_URL || undefined,
    dashboardUrl: process.env.DASHBOARD_URL || undefined,
  }),
});

function handle({ request }: { request: Request }) {
  return proxy.handle(request);
}

export const Route = createFileRoute('/marketing-api/$')({
  server: {
    handlers: {
      GET: handle,
      POST: handle,
      PUT: handle,
      PATCH: handle,
      DELETE: handle,
    },
  },
});
