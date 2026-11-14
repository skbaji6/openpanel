import { getRouteApi } from '@tanstack/react-router';
import { MegaphoneIcon } from 'lucide-react';
import { describeMarketingError } from './api';
import { CampaignSummary } from './campaign-detail';
import { CampaignEditor } from './campaign-editor';
import { CampaignList } from './campaign-list';
import { useCampaign } from './use-campaign';
import { FullPageEmptyState } from '@/components/full-page-empty-state';
import FullPageLoadingState from '@/components/full-page-loading-state';
import { Button } from '@/components/ui/button';

const route = getRouteApi(
  '/_app/$organizationId/$projectId/marketing/_tabs/campaigns'
);

function OpenCampaign({
  campaignId,
  onClose,
  onSaved,
}: {
  campaignId: string;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const campaign = useCampaign(campaignId);
  if (campaign.isPending) {
    return <FullPageLoadingState />;
  }
  if (campaign.error) {
    return (
      <FullPageEmptyState
        description={describeMarketingError(campaign.error)}
        icon={MegaphoneIcon}
        title="Campaign not found"
      >
        <Button onClick={onClose}>Back to campaigns</Button>
      </FullPageEmptyState>
    );
  }
  if (campaign.data.state !== 'draft') {
    return <CampaignSummary campaignId={campaignId} onClose={onClose} />;
  }
  return (
    <CampaignEditor onClose={onClose} onSaved={onSaved} row={campaign.data} />
  );
}

export function CampaignsPage() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const close = () => navigate({ search: {} });
  const open = (id: string) => navigate({ search: { id } });

  if (search.id) {
    return (
      <OpenCampaign
        campaignId={search.id}
        key={search.id}
        onClose={close}
        onSaved={open}
      />
    );
  }
  if (search.new) {
    return <CampaignEditor onClose={close} onSaved={open} />;
  }
  return (
    <CampaignList
      onNew={() => navigate({ search: { new: true } })}
      onOpen={open}
    />
  );
}
