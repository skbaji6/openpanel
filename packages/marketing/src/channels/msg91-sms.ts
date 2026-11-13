import { z } from 'zod';
import { zSmsProviderRef } from '../templates/registry';
import type { BatchChannelAdapter, BatchItem, DeliveryOutcome } from './batch';
import {
  MSG91_SMS_BASE_URL,
  sendMsg91Groups,
  zMsg91BaseUrl,
} from './msg91-http';

export const MSG91_SMS_MAX_RECIPIENTS = 100;
const FLOW_PATH = '/api/v5/flow';
const NO_PHONE_REASON = 'no_phone';

export const zMsg91SmsConfig = z.strictObject({
  authKey: z.string().min(8).max(128),
  baseUrl: zMsg91BaseUrl.optional(),
});
export type Msg91SmsConfig = z.infer<typeof zMsg91SmsConfig>;

type SmsRef = z.infer<typeof zSmsProviderRef>;

function buildBody(items: BatchItem[], ref: SmsRef) {
  return {
    template_id: ref.flowId,
    short_url: '0',
    realTimeResponse: '1',
    recipients: items.map((item) => ({
      ...Object.fromEntries(
        'kind' in item.message
          ? item.message.variables.map(({ slot, value }) => [slot, value])
          : []
      ),
      mobiles: item.to.phone,
    })),
    ...(ref.senderId ? { sender: ref.senderId } : {}),
  };
}

function readSuccess(json: unknown) {
  const record =
    typeof json === 'object' && json !== null
      ? (json as Record<string, unknown>)
      : {};
  return { success: record.type === 'success', requestId: record.message };
}

export function createMsg91SmsAdapter(
  opts: { timeoutMs?: number; now?: () => number } = {}
): BatchChannelAdapter<Msg91SmsConfig> {
  return {
    id: 'sms',
    configSchema: zMsg91SmsConfig,
    maxBatch: MSG91_SMS_MAX_RECIPIENTS,
    async sendBatch(items, config, sendOpts) {
      const groups = new Map<string, { ref: SmsRef; items: BatchItem[] }>();
      const results: DeliveryOutcome[] = [];
      for (const item of items) {
        if (!('kind' in item.message)) {
          throw new Error('the sms adapter only sends provider messages');
        }
        const ref = zSmsProviderRef.parse(item.message.version.providerRef);
        if (!item.to.phone) {
          results.push({
            profileId: item.profileId,
            outcome: 'failed',
            reason: NO_PHONE_REASON,
          });
          continue;
        }
        const key = `${ref.flowId}|${ref.senderId ?? ''}`;
        const group = groups.get(key) ?? { ref, items: [] };
        group.items.push(item);
        groups.set(key, group);
      }
      const url = `${config.baseUrl ?? MSG91_SMS_BASE_URL}${FLOW_PATH}`;
      results.push(
        ...(await sendMsg91Groups(
          [...groups.values()].map(({ ref, items: groupItems }) => ({
            items: groupItems,
            buildBody: (chunk) => buildBody(chunk, ref),
          })),
          {
            url,
            authKey: config.authKey,
            maxBatch: MSG91_SMS_MAX_RECIPIENTS,
            concurrency: sendOpts.concurrency,
            timeoutMs: opts.timeoutMs,
            signal: sendOpts.signal,
            deadlineAt: sendOpts.deadlineAt,
            now: opts.now,
            readSuccess,
          }
        ))
      );
      return results;
    },
  };
}
