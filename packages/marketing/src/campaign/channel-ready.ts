import { z } from 'zod';
import {
  CAMPAIGN_CHANNELS,
  checkChannelSettings,
  getChannelSettings,
} from '../channels/settings';
import type { Queryable, Sql } from '../engine/engine';
import type { createTemplateRegistry } from '../templates/registry';

const REGISTRY_CHANNELS = new Set(['sms', 'whatsapp']);
// Channels without a template registry have nothing to pin.
const UNVERSIONED = 0;
const zTemplateRef = z.object({ templateId: z.string() });
const zPinnableRef = z.object({ templateId: z.uuid() });

export function createChannelReady(deps: {
  sql: Sql;
  registry: ReturnType<typeof createTemplateRegistry>;
}) {
  return async (
    projectId: string,
    channel: string,
    template: unknown
  ): Promise<string | null> => {
    const known = CAMPAIGN_CHANNELS.find((name) => name === channel);
    const [config] = await deps.sql.$queryRawUnsafe<unknown[]>(
      'SELECT 1 FROM marketing.channel_configs WHERE project_id = $1 AND channel = $2',
      projectId,
      channel
    );
    if (!(known && config)) {
      return 'channel_not_configured';
    }
    const { settings } = await getChannelSettings(deps.sql, projectId, known);
    const [issue] = checkChannelSettings(known, settings);
    if (issue) {
      return issue;
    }
    if (!REGISTRY_CHANNELS.has(known)) {
      return null;
    }
    const ref = zTemplateRef.safeParse(template);
    if (!ref.success) {
      return 'template_not_found';
    }
    const readiness = await deps.registry.readiness(
      projectId,
      ref.data.templateId
    );
    if (!readiness.ok) {
      return readiness.code;
    }
    return readiness.channel === known ? null : 'template_channel_mismatch';
  };
}

// FOR SHARE holds the template row until the caller commits, so it cannot be disabled under a starting campaign.
export async function pinTemplate(
  tx: Queryable,
  projectId: string,
  channel: string,
  template: unknown
): Promise<number | null> {
  if (!REGISTRY_CHANNELS.has(channel)) {
    return UNVERSIONED;
  }
  const ref = zPinnableRef.safeParse(template);
  if (!ref.success) {
    return null;
  }
  const [row] = await tx.$queryRawUnsafe<{ current_version: number }[]>(
    `SELECT current_version FROM marketing.message_templates
     WHERE id = $1::uuid AND project_id = $2 AND channel = $3 AND enabled FOR SHARE`,
    ref.data.templateId,
    projectId,
    channel
  );
  return row?.current_version ?? null;
}
