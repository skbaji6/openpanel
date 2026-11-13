import { z } from 'zod';
import { zWhatsAppProviderRef } from '../templates/registry';
import type { BatchChannelAdapter, BatchItem, DeliveryOutcome } from './batch';
import { sendMsg91Groups, zMsg91BaseUrl } from './msg91-http';

export const MSG91_WHATSAPP_BASE_URL = 'https://api.msg91.com';
export const MSG91_WHATSAPP_MAX_RECIPIENTS = 100;
const BULK_PATH = '/api/v5/whatsapp/whatsapp-outbound-message/bulk/';
const NO_PHONE_REASON = 'no_phone';
const PROVIDER_CODE = /^[A-Za-z0-9_]{1,32}$/;
const URL_BUTTON_SLOT = /^button_/;

export const zMsg91WhatsAppConfig = z.strictObject({
  authKey: z.string().min(8).max(128),
  integratedNumber: z.string().regex(/^[0-9]{8,15}$/),
  baseUrl: zMsg91BaseUrl.optional(),
});
export type Msg91WhatsAppConfig = z.infer<typeof zMsg91WhatsAppConfig>;

type WhatsAppRef = z.infer<typeof zWhatsAppProviderRef>;
type Outcome = Omit<DeliveryOutcome, 'profileId'>;

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};

function buildBody(
  items: BatchItem[],
  ref: WhatsAppRef,
  integratedNumber: string
) {
  return {
    integrated_number: integratedNumber,
    content_type: 'template',
    payload: {
      messaging_product: 'whatsapp',
      type: 'template',
      template: {
        name: ref.templateName,
        language: { code: ref.language, policy: 'deterministic' },
        namespace: ref.namespace,
        to_and_components: items.map((item) => ({
          to: [item.to.phone],
          components: Object.fromEntries(
            'kind' in item.message
              ? item.message.variables.map(({ slot, value }) => [
                  slot,
                  URL_BUTTON_SLOT.test(slot)
                    ? { type: 'text', value, subtype: 'url' }
                    : { type: 'text', value },
                ])
              : []
          ),
        })),
      },
    },
  };
}

// An error_code that echoes a phone, the key or the integrated number is not a code.
function reasonFor(code: unknown, secrets: string[]): string {
  const usable =
    typeof code === 'string' &&
    PROVIDER_CODE.test(code) &&
    !secrets.some((secret) => code.includes(secret));
  return `msg91 ${usable ? code : 'failed'}`;
}

function readResponse(json: unknown, secrets: string[]) {
  const body = record(json);
  const requestId = body.request_id;
  if (Array.isArray(body.results)) {
    const byPhone = new Map<string, Outcome>();
    for (const entry of body.results) {
      const { to, status, error_code: code } = record(entry);
      if (typeof to !== 'string') {
        continue;
      }
      if (status === 'success') {
        byPhone.set(to, { outcome: 'sent' });
      } else if (status === 'failed') {
        byPhone.set(to, {
          outcome: 'failed',
          reason: reasonFor(code, secrets),
        });
      }
    }
    return {
      success: false,
      requestId,
      perItem: (item: BatchItem): Outcome =>
        byPhone.get(item.to.phone ?? '') ?? {
          outcome: 'uncertain',
          reason: 'msg91 unlisted',
        },
    };
  }
  const accepted =
    (body.status === 'success' || body.type === 'success') &&
    body.hasError !== true;
  return { success: accepted, requestId };
}

export function createMsg91WhatsAppAdapter(
  opts: { timeoutMs?: number; now?: () => number } = {}
): BatchChannelAdapter<Msg91WhatsAppConfig> {
  return {
    id: 'whatsapp',
    configSchema: zMsg91WhatsAppConfig,
    maxBatch: MSG91_WHATSAPP_MAX_RECIPIENTS,
    async sendBatch(items, config, sendOpts) {
      const groups = new Map<
        string,
        { ref: WhatsAppRef; integratedNumber: string; items: BatchItem[] }
      >();
      const results: DeliveryOutcome[] = [];
      for (const item of items) {
        if (!('kind' in item.message)) {
          throw new Error('the whatsapp adapter only sends provider messages');
        }
        const ref = zWhatsAppProviderRef.parse(
          item.message.version.providerRef
        );
        if (!item.to.phone) {
          results.push({
            profileId: item.profileId,
            outcome: 'failed',
            reason: NO_PHONE_REASON,
          });
          continue;
        }
        const integratedNumber =
          ref.integratedNumber ?? config.integratedNumber;
        const key = [
          ref.templateName,
          ref.namespace,
          ref.language,
          integratedNumber,
        ].join('|');
        const group = groups.get(key) ?? { ref, integratedNumber, items: [] };
        group.items.push(item);
        groups.set(key, group);
      }
      const secrets = [
        config.authKey,
        config.integratedNumber,
        ...[...groups.values()].flatMap((group) => [
          group.integratedNumber,
          ...group.items.map((item) => item.to.phone ?? ''),
        ]),
      ];
      results.push(
        ...(await sendMsg91Groups(
          [...groups.values()].map((group) => ({
            items: group.items,
            buildBody: (chunk) =>
              buildBody(chunk, group.ref, group.integratedNumber),
          })),
          {
            url: `${config.baseUrl ?? MSG91_WHATSAPP_BASE_URL}${BULK_PATH}`,
            authKey: config.authKey,
            maxBatch: MSG91_WHATSAPP_MAX_RECIPIENTS,
            concurrency: sendOpts.concurrency,
            timeoutMs: opts.timeoutMs,
            signal: sendOpts.signal,
            deadlineAt: sendOpts.deadlineAt,
            now: opts.now,
            readSuccess: (json) => readResponse(json, secrets),
          }
        ))
      );
      return results;
    },
  };
}
