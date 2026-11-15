import type { z } from 'zod';

export type ChannelId = 'email' | 'webhook' | 'push';

export interface Recipient {
  profileId: string;
  email?: string;
  phone?: string;
  deviceTokens: string[];
  attributes: Record<string, unknown>;
}

export interface JourneyMeta {
  projectId: string;
  enrollmentId: string;
  ruleId: string;
  stepIndex: number;
}

export interface CampaignMeta {
  projectId: string;
  campaignId: string;
}

export interface RenderedMessage {
  subject?: string;
  title?: string;
  body: string;
  text?: string;
  imageUrl?: string;
  data?: Record<string, string>;
  meta: JourneyMeta | CampaignMeta;
}

export type SendResult =
  | { ok: true; invalidTokens?: string[] }
  | { ok: false; retryable: boolean; reason: string; invalidTokens?: string[] };

export interface SendOptions {
  idempotencyKey: string;
  unsubscribeUrl: string;
}

export interface ChannelAdapter<C> {
  id: ChannelId;
  configSchema: z.ZodType<C>;
  send(
    msg: RenderedMessage,
    to: Recipient,
    config: C,
    opts: SendOptions
  ): Promise<SendResult>;
}
