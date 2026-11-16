import { describe, expect, test } from 'vitest';
import type { DailyRow, JourneyReport } from './contract';
import {
  dailySeries,
  funnelSteps,
  journeyNotReported,
  reportCopy,
  statusLabel,
  variantRows,
} from './report-view';

const funnel = { sent: 10, delivered: 0, read: 0, clicked: 4, converted: 1 };

function day(date: string, sent: number): DailyRow {
  return {
    day: date,
    sent,
    delivered: 0,
    read: 0,
    clicked: 0,
    converted: 0,
    failed: 0,
    skipped: 0,
    uncertain: 0,
  };
}

describe('report view', () => {
  test('push funnel shows delivered and read as not reported', () => {
    const steps = funnelSteps(funnel, ['delivered', 'read']);
    expect(steps.map((s) => s.key)).toEqual([
      'sent',
      'delivered',
      'read',
      'clicked',
      'converted',
    ]);
    expect(steps[1]).toMatchObject({ count: null, percentOfSent: null });
    expect(steps[2]).toMatchObject({ count: null, percentOfSent: null });
    expect(steps[3]).toMatchObject({ count: 4, percentOfSent: 0.4 });
  });

  test('percent of sent is null when nothing was sent', () => {
    const steps = funnelSteps({ ...funnel, sent: 0 }, []);
    expect(steps.every((s) => s.percentOfSent === null)).toBe(true);
    expect(steps[3].count).toBe(4);
  });

  test('missing days are zero-filled in order', () => {
    const rows = dailySeries(
      [day('2026-03-30', 2), day('2026-04-02', 5)],
      ['sent']
    );
    expect(rows.map((r) => [r.day, r.sent])).toEqual([
      ['2026-03-30', 2],
      ['2026-03-31', 0],
      ['2026-04-01', 0],
      ['2026-04-02', 5],
    ]);
    expect(dailySeries([], ['sent'])).toEqual([]);
  });

  test("variant '' is labelled No message fitted and default is labelled Default", () => {
    const report = {
      variants: [
        { stepIndex: 0, variantKey: '', sent: 0, skipped: 3, failed: 0 },
        { stepIndex: 0, variantKey: 'default', sent: 4, skipped: 0, failed: 1 },
        { stepIndex: 1, variantKey: 'Delhi', sent: 2, skipped: 0, failed: 0 },
      ],
    } as JourneyReport;
    expect(variantRows(report).map((r) => r.label)).toEqual([
      'No message fitted',
      'Default',
      'Delhi',
    ]);
  });

  test('copy depends on the conversion event', () => {
    expect(reportCopy({ event: 'app_open', windowDays: 7 })).toContain(
      'within 7 days of their last message'
    );
    expect(reportCopy({ event: null, windowDays: 7 })).toContain(
      'Conversions are off; set the conversion event in Channels.'
    );
    expect(statusLabel('uncertain')).toBe('Uncertain');
  });

  test('journey milestone is not reported only when every step omits it', () => {
    const step = (notReported: string[]) => ({ notReported });
    expect(
      journeyNotReported([step(['delivered', 'read']), step(['delivered'])])
    ).toEqual({ all: ['delivered'], some: ['read'] });
    expect(journeyNotReported([])).toEqual({ all: [], some: [] });
  });
});
