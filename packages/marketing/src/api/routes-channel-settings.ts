import { z } from 'zod';
import {
  CAMPAIGN_CHANNELS,
  type CampaignChannel,
  checkChannelSettings,
  getChannelSettings,
  putChannelSettings,
  zChannelSettings,
} from '../channels/settings';
import type { Queryable } from '../engine/engine';
import { HttpError, json, parseJsonBody, type Route } from './http';

// Other issues block starting a campaign, not saving.
const BLOCKING_ON_SAVE = ['consent_not_supported', 'quota_not_supported'];
const SETTINGS_PATH = new RegExp(
  `^/marketing/channels/(${CAMPAIGN_CHANNELS.join('|')})/settings$`
);

const zUpdate = z.strictObject({
  settings: zChannelSettings,
  expectedVersion: z.number().int().min(0),
});

export function channelSettingsRoutes(sql: Queryable): Route[] {
  const respond = (
    channel: CampaignChannel,
    state: Awaited<ReturnType<typeof getChannelSettings>>
  ) =>
    json({
      channel,
      settings: state.settings,
      version: state.version,
      configured: state.configured,
      issues: checkChannelSettings(channel, state.settings),
    });

  return [
    {
      method: 'GET',
      pattern: SETTINGS_PATH,
      auth: 'dashboard',
      async handle(ctx) {
        const channel = ctx.params[0] as CampaignChannel;
        return respond(
          channel,
          await getChannelSettings(sql, ctx.projectId, channel)
        );
      },
    },
    {
      method: 'PUT',
      pattern: SETTINGS_PATH,
      auth: 'dashboard',
      async handle(ctx) {
        const channel = ctx.params[0] as CampaignChannel;
        const { settings, expectedVersion } = await parseJsonBody(
          ctx.req,
          zUpdate
        );
        const rejected = checkChannelSettings(channel, settings).filter(
          (issue) => BLOCKING_ON_SAVE.includes(issue)
        );
        if (rejected.length > 0) {
          throw new HttpError(400, 'invalid_settings', undefined, {
            issues: rejected,
          });
        }
        const saved = await putChannelSettings(
          sql,
          ctx.projectId,
          channel,
          settings,
          expectedVersion
        );
        return respond(channel, { ...saved, configured: true });
      },
    },
  ];
}
