import type { z } from 'zod';

export type ChannelId = 'email' | 'webhook' | 'push';

export interface Recipient {
  profileId: string;
  email?: string;
  deviceTokens: string[];
  attributes: Record<string, unknown>;
}

export interface RenderedMessage {
  subject?: string;
  title?: string;
  body: string;
  meta: {
    projectId: string;
    enrollmentId: string;
    ruleId: string;
    stepIndex: number;
  };
}

export type SendResult =
  | { ok: true }
  | { ok: false; retryable: boolean; reason: string };

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
