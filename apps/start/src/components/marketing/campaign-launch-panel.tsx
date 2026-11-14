import type { CampaignRow } from './campaign-contract';

export function CampaignLaunchPanel(_props: { campaign: CampaignRow }) {
  return (
    <section aria-label="Check and send" className="border-t p-4">
      <h3 className="font-medium text-sm">Check and send</h3>
    </section>
  );
}
