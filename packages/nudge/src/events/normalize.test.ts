import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  MAX_PROPERTY_KEYS,
  MAX_PROPERTY_STRING_LENGTH,
  normalizeEvent,
} from './normalize';

const base = {
  projectId: 'p1',
  deviceId: 'd1',
  sessionId: 's1',
  event: {
    name: 'add_to_cart',
    profileId: 'u1',
    properties: {},
    timestamp: '2026-10-22T10:00:00.000Z',
    isTimestampFromThePast: false,
  },
};

describe('normalizeEvent', () => {
  test('uses payload.id as eventId when present', () => {
    expect(normalizeEvent({ ...base, id: 'evt-1' })?.eventId).toBe('evt-1');
  });

  test('falls back to sha256 of projectId|deviceId|name|timestamp|profileId when id is missing and is stable across two calls', () => {
    const expected = createHash('sha256')
      .update('p1|d1|add_to_cart|2026-10-22T10:00:00.000Z|u1')
      .digest('hex');
    expect(normalizeEvent(base)?.eventId).toBe(expected);
    expect(normalizeEvent(base)?.eventId).toBe(expected);
  });

  test('returns null when event.profileId is missing', () => {
    const { profileId: _omit, ...event } = base.event;
    expect(normalizeEvent({ ...base, event })).toBeNull();
  });

  test('returns null for non-JSON-object input', () => {
    for (const input of [null, undefined, 'x', 42, [], true]) {
      expect(normalizeEvent(input)).toBeNull();
    }
  });

  test('parses timestamp given as ISO string and as epoch number', () => {
    const iso = normalizeEvent(base);
    const epoch = normalizeEvent({
      ...base,
      event: { ...base.event, timestamp: Date.parse(base.event.timestamp) },
    });
    expect(iso?.time.toISOString()).toBe('2026-10-22T10:00:00.000Z');
    expect(epoch?.time.getTime()).toBe(iso?.time.getTime());
    expect(
      normalizeEvent({ ...base, event: { ...base.event, timestamp: 'nope' } })
    ).toBeNull();
  });

  test('coerces property values to strings/numbers/booleans/null and drops nested objects', () => {
    const result = normalizeEvent({
      ...base,
      event: {
        ...base.event,
        properties: {
          s: 'a',
          n: 3,
          b: false,
          z: null,
          o: { x: 1 },
          a: [1],
          u: undefined,
          inf: Number.POSITIVE_INFINITY,
        },
      },
    });
    expect(result?.properties).toEqual({ s: 'a', n: 3, b: false, z: null });
  });

  test('drops properties beyond the key cap', () => {
    const properties = Object.fromEntries(
      Array.from({ length: MAX_PROPERTY_KEYS + 50 }, (_, i) => [`k${i}`, i])
    );
    const result = normalizeEvent({
      ...base,
      event: { ...base.event, properties },
    });
    expect(Object.keys(result?.properties ?? {})).toHaveLength(
      MAX_PROPERTY_KEYS
    );
  });

  test('truncates long string property values', () => {
    const result = normalizeEvent({
      ...base,
      event: {
        ...base.event,
        properties: { big: 'x'.repeat(MAX_PROPERTY_STRING_LENGTH + 500) },
      },
    });
    expect(result?.properties.big).toHaveLength(MAX_PROPERTY_STRING_LENGTH);
  });

  test('accepts a numeric profileId and stringifies it', () => {
    const result = normalizeEvent({
      ...base,
      event: { ...base.event, profileId: 7 },
    });
    expect(result?.profileId).toBe('7');
  });
});
