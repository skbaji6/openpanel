import type { MarketingConfig } from '../config';
import type { Queryable } from '../engine/engine';
import { webhookPath, webhookSecret } from '../tracking/keys';
import {
  putTrackingSettings,
  type TrackingSettings,
  type TrackingSettingsCache,
  zTrackingSettings,
} from '../tracking/settings';
import { json, parseJsonBody, type Route } from './http';

const SETTINGS_PATH = /^\/marketing\/tracking-settings$/;
const WEBHOOK_PATH = /^\/marketing\/tracking-settings\/webhook$/;

export function routesTracking(deps: {
  sql: Queryable;
  cfg: Pick<MarketingConfig, 'publicUrl' | 'encryptionKey'>;
  settings: TrackingSettingsCache;
}): Route[] {
  const effectivePublicUrl = (settings: TrackingSettings) =>
    settings.publicUrl ?? deps.cfg.publicUrl;
  const respond = (settings: TrackingSettings) =>
    json({ settings, effectivePublicUrl: effectivePublicUrl(settings) });

  return [
    {
      method: 'GET',
      pattern: SETTINGS_PATH,
      auth: 'dashboard',
      async handle(ctx) {
        return respond(await deps.settings.get(ctx.projectId));
      },
    },
    {
      method: 'PUT',
      pattern: SETTINGS_PATH,
      auth: 'dashboard',
      async handle(ctx) {
        const body = await parseJsonBody(ctx.req, zTrackingSettings);
        const saved = await putTrackingSettings(deps.sql, ctx.projectId, body);
        return respond(deps.settings.set(ctx.projectId, saved));
      },
    },
    {
      // Carries the webhook secret: the proxy lets only organization admins reach it.
      method: 'GET',
      pattern: WEBHOOK_PATH,
      auth: 'dashboard',
      async handle(ctx) {
        const settings = await deps.settings.get(ctx.projectId);
        const secret = webhookSecret(deps.cfg.encryptionKey, ctx.projectId);
        return json({
          url: `${effectivePublicUrl(settings)}${webhookPath(ctx.projectId, secret)}`,
        });
      },
    },
  ];
}
