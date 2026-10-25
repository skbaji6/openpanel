import { createFileRoute, Outlet, useRouter } from '@tanstack/react-router';
import { PageHeader } from '@/components/page-header';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { usePageTabs } from '@/hooks/use-page-tabs';
import { createProjectTitle } from '@/utils/title';

const RULES_TAB = 'rules';

export const Route = createFileRoute(
  '/_app/$organizationId/$projectId/nudge/_tabs'
)({
  component: Component,
  head: () => ({
    meta: [{ title: createProjectTitle('Nudges') }],
  }),
});

function Component() {
  const router = useRouter();
  const { activeTab, tabs } = usePageTabs([
    { id: RULES_TAB, label: 'Rules' },
    { id: 'channels', label: 'Channels' },
    { id: 'results', label: 'Results' },
  ]);

  const handleTabChange = (tabId: string) => {
    router.navigate({
      from: Route.fullPath,
      to: tabId === RULES_TAB ? '.' : tabId,
    });
  };

  return (
    <div className="container p-8">
      <PageHeader
        description="Nudge profiles by email, push or webhook until they reach a goal"
        title="Nudges"
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
