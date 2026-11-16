import { describe, expect, it } from 'bun:test';
import {
  smsReportFor,
  whatsAppReportFor,
} from '../channels/fakes/msg91-reports';
import smsFixture from './fixtures/msg91-sms-report.json';
import whatsAppFixture from './fixtures/msg91-whatsapp-report.json';
import { parseMsg91Reports } from './msg91-reports';

const REASON_PATTERN = /^[a-z0-9_]{1,40}$/;
const RECEIVED = new Date('2026-11-15T12:00:00Z');

describe('parseMsg91Reports', () => {
  it('the sms fixture parses to delivered and failed with msg91_16', () => {
    const { reports, ignored } = parseMsg91Reports(smsFixture, RECEIVED);
    expect(ignored).toBe(1);
    expect(reports.map((r) => [r.number, r.status, r.reason])).toEqual([
      ['919000000001', 'delivered', null],
      ['919000000002', 'failed', 'msg91_16'],
    ]);
    expect(reports[0]?.requestId).toBe('req_sms_fixture_1');
    expect(reports[0]?.at.toISOString()).toBe('2026-11-15T10:00:00.000Z');
    expect(reports[1]?.reason).toMatch(REASON_PATTERN);
  });

  it('the whatsapp fixture parses read', () => {
    const { reports, ignored } = parseMsg91Reports(whatsAppFixture, RECEIVED);
    expect(ignored).toBe(1);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      requestId: 'req_wa_fixture_1',
      number: '919000000004',
      status: 'read',
      reason: null,
    });
  });

  it('form-encoded data parses', () => {
    const json = JSON.stringify(smsFixture);
    expect(parseMsg91Reports({ data: json }, RECEIVED).reports).toHaveLength(2);
    expect(
      parseMsg91Reports({ data: smsFixture }, RECEIVED).reports
    ).toHaveLength(2);
    const form = new URLSearchParams({ data: json }).toString();
    expect(parseMsg91Reports(form, RECEIVED).reports).toHaveLength(2);
  });

  it('builders round-trip through the parser', () => {
    const sms = parseMsg91Reports(
      smsReportFor('r1', [{ phone: '+91 90000 00009', status: '2' }])
    );
    expect(sms.reports[0]).toMatchObject({
      number: '919000000009',
      reason: 'msg91_2',
    });
    const wa = parseMsg91Reports(
      whatsAppReportFor('r2', [{ phone: '919000000009', status: 'failed' }])
    );
    expect(wa.reports[0]?.status).toBe('failed');
    expect(wa.reports[0]?.reason).toMatch(REASON_PATTERN);
  });

  it('unknown statuses are ignored and counted', () => {
    const body = [
      { requestId: 'r', customerNumber: '919000000001', status: 'sent' },
      { requestId: 'r', customerNumber: '919000000001', status: 'weird' },
      { requestId: 'r', report: [{ number: '919000000001', status: 99 }] },
    ];
    expect(parseMsg91Reports(body)).toEqual({ reports: [], ignored: 3 });
  });

  it('a missing or unparseable date is the receive time', () => {
    const body = [
      { requestId: 'r', customerNumber: '919000000001', status: 'delivered' },
      {
        requestId: 'r',
        customerNumber: '919000000002',
        status: 'read',
        timestamp: 'nope',
      },
    ];
    const { reports } = parseMsg91Reports(body, RECEIVED);
    expect(reports.map((r) => r.at.getTime())).toEqual([
      RECEIVED.getTime(),
      RECEIVED.getTime(),
    ]);
  });

  it('garbage, null, a string and a 10 MB-shaped array do not throw', () => {
    const big = Array.from({ length: 200_000 }, () => ({ x: 'y'.repeat(50) }));
    for (const body of [
      undefined,
      null,
      'x',
      '{',
      7,
      [null, 1, 'a', []],
      { data: '{' },
      big,
    ]) {
      const result = parseMsg91Reports(body);
      expect(result.reports).toEqual([]);
    }
  });

  it('desc text never appears in the output', () => {
    const output = JSON.stringify(parseMsg91Reports(smsFixture, RECEIVED));
    expect(output).not.toContain('SECRET-DESC');
    expect(output).not.toContain('Delivered to handset');
  });
});
