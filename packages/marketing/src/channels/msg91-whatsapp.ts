import { z } from 'zod';
import { zWhatsAppProviderRef } from '../templates/registry';
import type {
  BatchChannelAdapter,
  BatchItem,
  DeliveryOutcome,
  ProviderMessage,
} from './batch';
import {
  digitsOf,
  msg91BaseUrl,
  phoneSecrets,
  providerReason,
  sendMsg91Groups,
} from './msg91-http';

export const MSG91_WHATSAPP_BASE_URL = 'https://api.msg91.com';
export const MSG91_WHATSAPP_MAX_RECIPIENTS = 100;
const BULK_PATH = '/api/v5/whatsapp/whatsapp-outbound-message/bulk/';
const NO_PHONE_REASON = 'no_phone';
const URL_BUTTON_SLOT = /^button_/;

// Allow-listed hosts (MARKETING_WEBHOOK_ALLOW_HOSTS) may stand in for MSG91, as a local fake does.
export const msg91WhatsAppConfigSchema = (allowHosts: readonly string[] = []) =>
  z.strictObject({
    authKey: z.string().min(8).max(128),
    integratedNumber: z.string().regex(/^[0-9]{8,15}$/),
    baseUrl: msg91BaseUrl(allowHosts).optional(),
  });
export const zMsg91WhatsAppConfig = msg91WhatsAppConfigSchema();
export type Msg91WhatsAppConfig = z.infer<typeof zMsg91WhatsAppConfig>;

type WhatsAppRef = z.infer<typeof zWhatsAppProviderRef>;
type Outcome = Omit<DeliveryOutcome, 'profileId'>;
type Slots = ProviderMessage['variables'];

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};

function buildBody(
  items: BatchItem[],
  slotsOf: Map<BatchItem, Slots>,
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
            (slotsOf.get(item) ?? []).map(({ slot, value }) => [
              slot,
              URL_BUTTON_SLOT.test(slot)
                ? { type: 'text', value, subtype: 'url' }
                : { type: 'text', value },
            ])
          ),
        })),
      },
    },
  };
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
      const outcome: Outcome | undefined =
        status === 'success'
          ? { outcome: 'sent' }
          : status === 'failed'
            ? {
                outcome: 'failed',
                reason: providerReason(code, secrets, 'failed'),
              }
            : undefined;
      if (!outcome) {
        continue;
      }
      const key = digitsOf(to);
      const earlier = byPhone.get(key);
      // The provider contradicting itself about one phone settles nothing.
      byPhone.set(
        key,
        earlier && earlier.outcome !== outcome.outcome
          ? { outcome: 'uncertain', reason: 'msg91 conflicting' }
          : (earlier ?? outcome)
      );
    }
    return {
      success: false,
      requestId,
      perItem: (item: BatchItem): Outcome =>
        byPhone.get(digitsOf(item.to.phone ?? '')) ?? {
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
  opts: { timeoutMs?: number; now?: () => number; allowHosts?: string[] } = {}
): BatchChannelAdapter<Msg91WhatsAppConfig> {
  return {
    id: 'whatsapp',
    configSchema: msg91WhatsAppConfigSchema(opts.allowHosts),
    maxBatch: MSG91_WHATSAPP_MAX_RECIPIENTS,
    async sendBatch(items, config, sendOpts) {
      const groups = new Map<
        string,
        { ref: WhatsAppRef; integratedNumber: string; items: BatchItem[] }
      >();
      const results: DeliveryOutcome[] = [];
      const slotsOf = new Map<BatchItem, Slots>();
      for (const item of items) {
        if (!('kind' in item.message)) {
          throw new Error('the whatsapp adapter only sends provider messages');
        }
        slotsOf.set(item, item.message.variables);
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
          ...group.items.flatMap((item) => phoneSecrets(item.to.phone)),
        ]),
      ];
      results.push(
        ...(await sendMsg91Groups(
          [...groups.values()].map((group) => ({
            items: group.items,
            buildBody: (chunk) =>
              buildBody(chunk, slotsOf, group.ref, group.integratedNumber),
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
