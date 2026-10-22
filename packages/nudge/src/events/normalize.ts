import { createHash } from 'node:crypto';
import { z } from 'zod';
import { sanitizeText } from './sanitize';

export const MAX_PROPERTY_KEYS = 200;
export const MAX_PROPERTY_STRING_LENGTH = 1000;

export interface NormalizedEvent {
  eventId: string;
  projectId: string;
  profileId: string;
  name: string;
  time: Date;
  properties: Record<string, string | number | boolean | null>;
}

// The subset of IncomingEventPayload the plugin reads; the topic is untrusted.
const zIncomingEvent = z.object({
  id: z.string().optional(),
  projectId: z.string().min(1),
  deviceId: z.string().optional(),
  event: z.object({
    name: z.string().min(1),
    profileId: z.union([z.string().min(1), z.number()]),
    properties: z.record(z.string(), z.unknown()).nullish(),
    timestamp: z.union([z.string(), z.number()]),
  }),
});

function normalizeProperties(
  raw: Record<string, unknown> | null | undefined
): NormalizedEvent['properties'] {
  const properties: NormalizedEvent['properties'] = {};
  for (const [key, value] of Object.entries(raw ?? {}).slice(
    0,
    MAX_PROPERTY_KEYS
  )) {
    const cleanKey = sanitizeText(key);
    if (typeof value === 'string') {
      // sanitize after slicing: the cut can split a surrogate pair
      properties[cleanKey] = sanitizeText(
        value.slice(0, MAX_PROPERTY_STRING_LENGTH)
      );
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      properties[cleanKey] = value;
    } else if (typeof value === 'boolean' || value === null) {
      properties[cleanKey] = value;
    }
  }
  return properties;
}

export function normalizeEvent(raw: unknown): NormalizedEvent | null {
  const parsed = zIncomingEvent.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const { id, projectId, deviceId, event } = parsed.data;

  const time = new Date(event.timestamp);
  if (Number.isNaN(time.getTime())) {
    return null;
  }

  const profileId = String(event.profileId);
  const eventId =
    id ||
    createHash('sha256')
      .update(
        `${projectId}|${deviceId}|${event.name}|${event.timestamp}|${profileId}`
      )
      .digest('hex');

  return {
    eventId: sanitizeText(eventId),
    projectId,
    profileId: sanitizeText(profileId),
    name: sanitizeText(event.name),
    time,
    properties: normalizeProperties(event.properties),
  };
}
