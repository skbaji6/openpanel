// Builders for the report payload shapes the parser reads; test only.
const FAKE_DATE = '2026-11-15T10:00:00Z';

export function smsReportFor(
  requestId: string,
  entries: { phone: string; status: '1' | '2' | '16' }[]
): unknown {
  return [
    {
      requestId,
      report: entries.map((entry) => ({
        number: entry.phone,
        status: Number(entry.status),
        desc: 'provider description',
        date: FAKE_DATE,
      })),
    },
  ];
}

export function whatsAppReportFor(
  requestId: string,
  entries: { phone: string; status: 'delivered' | 'read' | 'failed' }[]
): unknown {
  return entries.map((entry) => ({
    requestId,
    customerNumber: entry.phone,
    status: entry.status,
    timestamp: FAKE_DATE,
  }));
}
