import type { Sql } from '../engine/engine';
import { campaignReport, journeyReport } from '../tracking/reports';
import { HttpError, json, type Route } from './http';
import { isTimeZone, ruleIdParam } from './routes-dashboard';

const DEFAULT_TIME_ZONE = 'Asia/Kolkata';
const MAX_TIME_ZONE_LENGTH = 64;

function timeZoneOf(url: URL): string {
  const timeZone = url.searchParams.get('tz') ?? DEFAULT_TIME_ZONE;
  if (timeZone.length > MAX_TIME_ZONE_LENGTH || !isTimeZone(timeZone)) {
    throw new HttpError(400, 'invalid_timezone');
  }
  return timeZone;
}

export function routesReports(deps: { sql: Sql }): Route[] {
  const report = (
    kind: 'campaigns' | 'journeys',
    build: typeof campaignReport | typeof journeyReport
  ): Route => ({
    method: 'GET',
    pattern: new RegExp(`^/marketing/reports/${kind}/([^/]+)$`),
    auth: 'dashboard',
    async handle(ctx) {
      const id = ruleIdParam(ctx.params);
      const result = await build(
        deps.sql,
        ctx.projectId,
        id,
        timeZoneOf(ctx.url)
      );
      if (!result) {
        throw new HttpError(404, 'not_found');
      }
      return json(result);
    },
  });
  return [
    report('campaigns', campaignReport),
    report('journeys', journeyReport),
  ];
}
