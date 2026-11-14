import {
  createFileRoute,
  Outlet,
  useLocation,
  useRouter,
} from '@tanstack/react-router';
import { PageHeader } from '@/components/page-header';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { usePageTabs } from '@/hooks/use-page-tabs';
import { createProjectTitle } from '@/utils/title';

const RULES_TAB = 'rules';

export const Route = createFileRoute(
  '/_app/$organizationId/$projectId/marketing/_tabs'
)({
  component: Component,
  head: () => ({
    meta: [{ title: createProjectTitle('Marketing') }],
  }),
});

function Component() {
  const router = useRouter();
  const location = useLocation();
  const { activeTab: matchedTab, tabs } = usePageTabs([
    { id: 'campaigns', label: 'Campaigns' },
    { id: 'audiences', label: 'Audiences' },
    { id: RULES_TAB, label: 'Journeys' },
    { id: 'templates', label: 'Templates' },
    { id: 'channels', label: 'Channels' },
    { id: 'results', label: 'Results' },
    { id: 'guide', label: 'How it works' },
  ]);

  // usePageTabs falls back to the first tab, but the index route is Journeys.
  const lastSegment = location.pathname.split('/').filter(Boolean).at(-1);
  const activeTab = tabs.some((tab) => tab.id === lastSegment)
    ? matchedTab
    : RULES_TAB;

  const handleTabChange = (tabId: string) => {
    router.navigate({
      from: Route.fullPath,
      to: tabId === RULES_TAB ? '.' : tabId,
    });
  };

  return (
    <div className="container p-8">
      <PageHeader
        description="Campaigns and journeys that message students by push, WhatsApp, SMS or email"
        title="Marketing"
      />
      <Tabs
        className="mt-2 mb-8"
        onValueChange={handleTabChange}
        value={activeTab}
      >
        <TabsList>
          {tabs.map((tab) => (
            <TabsTrigger key={tab.id} value={tab.id}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <Outlet />
    </div>
  );
}
