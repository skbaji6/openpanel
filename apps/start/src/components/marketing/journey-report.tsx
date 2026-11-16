import type { JourneyReport as Report } from './contract';
import { DailyChart, FunnelBars } from './report-charts';
import { ReportShell, StatusTable, useReport } from './report-shared';
import {
  funnelSteps,
  journeyNotReported,
  reportCopy,
  variantRows,
} from './report-view';

function StepsTable({ steps }: { steps: Report['steps'] }) {
  if (steps.length === 0) {
    return <p className="text-muted-foreground text-sm">No messages yet.</p>;
  }
  return (
    <table className="w-full text-left text-sm">
      <caption className="sr-only">Funnel per step</caption>
      <thead>
        <tr>
          <th className="p-2" scope="col">
            Step
          </th>
          <th className="p-2" scope="col">
            Channel
          </th>
          {funnelSteps(steps[0].funnel, []).map((column) => (
            <th className="p-2 text-right" key={column.key} scope="col">
              {column.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {steps.map((step) => (
          <tr className="border-t" key={step.stepIndex}>
            <th className="p-2 font-normal" scope="row">
              Step {step.stepIndex + 1}
            </th>
            <td className="p-2">{step.channel ?? 'Unknown'}</td>
            {funnelSteps(step.funnel, step.notReported).map((cell) => (
              <td className="p-2 text-right tabular-nums" key={cell.key}>
                {cell.count ?? 'Not reported'}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function VariantTable({ report }: { report: Report }) {
  const rows = variantRows(report);
  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">No variant counts yet.</p>
    );
  }
  return (
    <table className="w-full text-left text-sm">
      <caption className="sr-only">Messages per step and variant</caption>
      <thead>
        <tr>
          <th className="p-2" scope="col">
            Step
          </th>
          <th className="p-2" scope="col">
            Variant
          </th>
          <th className="p-2 text-right" scope="col">
            Sent
          </th>
          <th className="p-2 text-right" scope="col">
            Skipped
          </th>
          <th className="p-2 text-right" scope="col">
            Failed
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr className="border-t" key={`${row.stepIndex}:${row.label}`}>
            <th className="p-2 font-normal" scope="row">
              Step {row.stepIndex + 1}
            </th>
            <td className="p-2">{row.label}</td>
            <td className="p-2 text-right tabular-nums">{row.sent}</td>
            <td className="p-2 text-right tabular-nums">{row.skipped}</td>
            <td className="p-2 text-right tabular-nums">{row.failed}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function JourneyReport({
  ruleId,
  name,
  onClose,
}: {
  ruleId: string;
  name: string;
  onClose: () => void;
}) {
  const query = useReport<Report>('journeys', ruleId);
  return (
    <ReportShell noun="journey" onClose={onClose} query={query}>
      {(report) => {
        const notReported = journeyNotReported(report.steps);
        return (
          <div className="col gap-6">
            <h2 className="font-medium text-lg">{name}</h2>
            <section className="col gap-2">
              <h3 className="font-medium">Funnel</h3>
              <FunnelBars
                funnel={report.funnel}
                notReported={notReported.all}
              />
              {notReported.some.length > 0 && (
                <p className="text-muted-foreground text-sm">
                  Delivered and read cover only the channels that report them.
                </p>
              )}
              <p className="text-muted-foreground text-sm">
                {reportCopy(report.conversion)}
              </p>
            </section>
            <section className="col gap-2">
              <h3 className="font-medium">Per day</h3>
              <DailyChart daily={report.daily} />
            </section>
            <section className="col gap-2">
              <h3 className="font-medium">Per step</h3>
              <StepsTable steps={report.steps} />
            </section>
            <section className="col gap-2">
              <h3 className="font-medium">Per state variant</h3>
              <p className="text-muted-foreground text-sm">
                Counts only, by the variant name set in the journey. No student
                or state value is stored.
              </p>
              <VariantTable report={report} />
            </section>
            <section className="col gap-2">
              <h3 className="font-medium">Messages by furthest status</h3>
              <StatusTable statuses={report.statuses} />
            </section>
          </div>
        );
      }}
    </ReportShell>
  );
}
