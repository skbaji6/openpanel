import { CHANNEL_LABELS } from './campaign-form';
import type { CampaignReport as Report } from './contract';
import { DailyChart, FunnelBars } from './report-charts';
import { ReportShell, StatusTable, useReport } from './report-shared';
import { reportCopy } from './report-view';

export function CampaignReport({
  campaignId,
  name,
  onClose,
}: {
  campaignId: string;
  name: string;
  onClose: () => void;
}) {
  const query = useReport<Report>('campaigns', campaignId);
  return (
    <ReportShell noun="campaign" onClose={onClose} query={query}>
      {(report) => (
        <div className="col gap-6">
          <h2 className="font-medium text-lg">
            {name}{' '}
            <span className="text-muted-foreground text-sm">
              ({CHANNEL_LABELS[report.channel]})
            </span>
          </h2>
          <section className="col gap-2">
            <h3 className="font-medium">Funnel</h3>
            <FunnelBars
              funnel={report.funnel}
              notReported={report.notReported}
            />
            <p className="text-muted-foreground text-sm">
              {reportCopy(report.conversion)}
            </p>
          </section>
          <section className="col gap-2">
            <h3 className="font-medium">Per day</h3>
            <DailyChart daily={report.daily} />
          </section>
          <section className="col gap-2">
            <h3 className="font-medium">Messages by furthest status</h3>
            <StatusTable statuses={report.statuses} />
          </section>
        </div>
      )}
    </ReportShell>
  );
}
