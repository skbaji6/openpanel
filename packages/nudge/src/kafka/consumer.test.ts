import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { EachBatchPayload } from 'kafkajs';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetNudgeTables } from '../db/test-helpers';
import { createEngine, type Queryable } from '../engine/engine';
import type { NormalizedEvent } from '../events/normalize';
import {
  createBatchHandler,
  createEachBatch,
  createKafka,
  startConsumer,
} from './consumer';
import { createMemoryInterestSet, type InterestSet } from './interest';

const PROJECT = 'project-a';
const ENROLLED = 'enrolled-user';
const RULE_EVENT = 'purchase';
const FAST_RETRIES = [1, 1, 1];
const BROKER_WAIT_MS = 30_000;
const POLL_MS = 250;

function payload(name: string, profileId: string, id = randomUUID()) {
  return Buffer.from(
    JSON.stringify({
      id,
      projectId: PROJECT,
      deviceId: 'device-1',
      sessionId: 'session-1',
      event: {
        name,
        profileId,
        properties: { path: '/x' },
        timestamp: new Date().toISOString(),
        isTimestampFromThePast: false,
      },
    })
  );
}

// Interested in RULE_EVENT for anyone and in every event of ENROLLED.
const fakeInterest: InterestSet = {
  has: (_projectId, name, profileId) =>
    Promise.resolve(name === RULE_EVENT || profileId === ENROLLED),
  refresh: () => Promise.resolve(),
  add: () => Promise.resolve(),
};

function fakeEngine(impl?: (events: NormalizedEvent[]) => Promise<void>) {
  return { handleEvents: mock(impl ?? (() => Promise.resolve())) };
}

function deadlock() {
  return Object.assign(new Error('Raw query failed. Code: `40P01`.'), {
    code: 'P2010',
    meta: { code: '40P01' },
  });
}

beforeAll(async () => {
  await migrate();
});

afterAll(async () => {
  await sql.$disconnect();
});

describe('batch handler', () => {
  it('handler drops a malformed message without throwing', async () => {
    const engine = fakeEngine();
    const handle = createBatchHandler({ engine, interest: fakeInterest });
    await handle([
      null,
      Buffer.from('not json{'),
      Buffer.from('{"projectId":1}'),
    ]);
    expect(engine.handleEvents).not.toHaveBeenCalled();
  });

  it('handler ignores an event whose name is not in the interest set and whose profile has no active enrollment', async () => {
    const engine = fakeEngine();
    const handle = createBatchHandler({ engine, interest: fakeInterest });
    await handle([payload('page_view', 'stranger')]);
    expect(engine.handleEvents).not.toHaveBeenCalled();
  });

  it('handler passes an event for an enrolled profile even if its name is not a rule event (inactivity activity)', async () => {
    const engine = fakeEngine();
    const handle = createBatchHandler({ engine, interest: fakeInterest });
    await handle([payload('page_view', ENROLLED)]);
    expect(engine.handleEvents).toHaveBeenCalledTimes(1);
    const [events] = engine.handleEvents.mock.calls[0] as [NormalizedEvent[]];
    expect(events.map((event) => event.name)).toEqual(['page_view']);
  });

  it('handler calls engine.handleEvents once per batch with every kept message', async () => {
    const engine = fakeEngine();
    const handle = createBatchHandler({ engine, interest: fakeInterest });
    await handle([
      payload(RULE_EVENT, 'a'),
      payload('page_view', 'stranger'),
      payload('page_view', ENROLLED),
      null,
    ]);
    expect(engine.handleEvents).toHaveBeenCalledTimes(1);
    const [events] = engine.handleEvents.mock.calls[0] as [NormalizedEvent[]];
    expect(events.map((event) => [event.name, event.profileId])).toEqual([
      [RULE_EVENT, 'a'],
      ['page_view', ENROLLED],
    ]);
  });

  it('kept profiles are added to the shared interest set after the batch is written', async () => {
    const order: string[] = [];
    const engine = fakeEngine(() => {
      order.push('write');
      return Promise.resolve();
    });
    const add = mock((_keys: { projectId: string; profileId: string }[]) => {
      order.push('add');
      return Promise.resolve();
    });
    const handle = createBatchHandler({
      engine,
      interest: { ...fakeInterest, add },
    });
    await handle([payload(RULE_EVENT, 'a')]);
    expect(order).toEqual(['write', 'add']);
    expect(add.mock.calls[0]?.[0]).toEqual([
      { projectId: PROJECT, profileId: 'a' },
    ]);
  });

  it('PERF the pre-filter rejects an uninteresting event without calling the engine or sql', async () => {
    const querySpy = mock(() => Promise.resolve([]));
    const spySql = {
      $queryRawUnsafe: querySpy,
      $executeRawUnsafe: mock(() => Promise.resolve(0)),
    };
    const interestNames = mock(() => Promise.resolve(new Set([RULE_EVENT])));
    const engine = { ...fakeEngine(), interestNames };
    const interest = createMemoryInterestSet({
      engine,
      sql: spySql as unknown as Queryable,
    });
    await interest.refresh();
    querySpy.mockClear();
    interestNames.mockClear();

    const handle = createBatchHandler({ engine, interest });
    await handle([payload('page_view', 'stranger')]);
    expect(engine.handleEvents).not.toHaveBeenCalled();
    expect(interestNames).not.toHaveBeenCalled();
    expect(querySpy).not.toHaveBeenCalled();
    expect(spySql.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('a deadlock is retried and the batch then succeeds', async () => {
    let calls = 0;
    const engine = fakeEngine(() => {
      calls++;
      return calls === 1 ? Promise.reject(deadlock()) : Promise.resolve();
    });
    const handle = createBatchHandler({
      engine,
      interest: fakeInterest,
      retryDelaysMs: FAST_RETRIES,
    });
    await handle([payload(RULE_EVENT, 'a')]);
    expect(engine.handleEvents).toHaveBeenCalledTimes(2);
  });

  it('a serialization failure exhausts its bounded retries and then rejects', async () => {
    const engine = fakeEngine(() =>
      Promise.reject(
        Object.assign(new Error('write conflict'), { code: 'P2034' })
      )
    );
    const handle = createBatchHandler({
      engine,
      interest: fakeInterest,
      retryDelaysMs: FAST_RETRIES,
    });
    await expect(handle([payload(RULE_EVENT, 'a')])).rejects.toThrow(
      'write conflict'
    );
    expect(engine.handleEvents).toHaveBeenCalledTimes(FAST_RETRIES.length + 1);
  });

  it('a non-transient error is not retried', async () => {
    const engine = fakeEngine(() =>
      Promise.reject(new Error('relation does not exist'))
    );
    const handle = createBatchHandler({
      engine,
      interest: fakeInterest,
      retryDelaysMs: FAST_RETRIES,
    });
    await expect(handle([payload(RULE_EVENT, 'a')])).rejects.toThrow(
      'relation does not exist'
    );
    expect(engine.handleEvents).toHaveBeenCalledTimes(1);
  });
});

describe('eachBatch', () => {
  function fakeBatch() {
    const resolveOffset = mock((_offset: string) => undefined);
    const commitOffsetsIfNecessary = mock(() => Promise.resolve());
    const payloadArg = {
      batch: {
        topic: 't',
        partition: 0,
        messages: [
          { offset: '7', value: payload(RULE_EVENT, 'a') },
          { offset: '8', value: payload(RULE_EVENT, 'b') },
        ],
      },
      resolveOffset,
      commitOffsetsIfNecessary,
      heartbeat: mock(() => Promise.resolve()),
      isRunning: () => true,
      isStale: () => false,
    } as unknown as EachBatchPayload;
    return { payloadArg, resolveOffset, commitOffsetsIfNecessary };
  }

  it('eachBatch handler resolves offsets only after engine.handleEvents resolves, and a handleEvents rejection leaves offsets uncommitted', async () => {
    let finishWrite: () => void = () => undefined;
    const engine = fakeEngine(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve;
        })
    );
    const eachBatch = createEachBatch(
      createBatchHandler({ engine, interest: fakeInterest })
    );
    const ok = fakeBatch();
    const running = eachBatch(ok.payloadArg);
    await Bun.sleep(10);
    expect(engine.handleEvents).toHaveBeenCalledTimes(1);
    expect(ok.resolveOffset).not.toHaveBeenCalled();
    finishWrite();
    await running;
    expect(ok.resolveOffset.mock.calls.map(([offset]) => offset)).toEqual([
      '7',
      '8',
    ]);
    expect(ok.commitOffsetsIfNecessary).toHaveBeenCalled();

    const failing = createEachBatch(
      createBatchHandler({
        engine: fakeEngine(() => Promise.reject(new Error('db down'))),
        interest: fakeInterest,
      })
    );
    const bad = fakeBatch();
    await expect(failing(bad.payloadArg)).rejects.toThrow('db down');
    expect(bad.resolveOffset).not.toHaveBeenCalled();
    expect(bad.commitOffsetsIfNecessary).not.toHaveBeenCalled();
  });
});

describe('real broker', () => {
  it(
    'an IncomingEventPayload published to the topic lands in nudge.events',
    async () => {
      await resetNudgeTables();
      await sql.$executeRawUnsafe(
        `INSERT INTO nudge.rules (id, project_id, name, status, definition)
         VALUES ($1::uuid, $2, 'r', 'active', $3::jsonb)`,
        randomUUID(),
        PROJECT,
        JSON.stringify({
          name: 'r',
          trigger: { event: RULE_EVENT },
          goal: { kind: 'event', event: 'opened' },
          steps: [
            { delaySeconds: 3600, channel: 'email', template: { body: 'x' } },
          ],
          reentry: { enabled: false, cooldownSeconds: 0 },
          allowedEventProps: [],
        })
      );
      const runId = randomUUID();
      const kafkaConfig = {
        brokers: (process.env.KAFKA_BROKERS ?? '127.0.0.1:23092').split(','),
        clientId: `nudge-test-${runId}`,
        topic: `nudge-test-${runId}`,
        groupId: `nudge-test-${runId}`,
        ssl: false as const,
      };
      const kafka = createKafka(kafkaConfig);
      const admin = kafka.admin();
      const producer = kafka.producer();
      await admin.connect();
      await admin.createTopics({
        topics: [{ topic: kafkaConfig.topic, numPartitions: 1 }],
        waitForLeaders: true,
      });
      await producer.connect();

      const engine = createEngine({ sql });
      const interest = createMemoryInterestSet({ engine, sql });
      await interest.refresh();
      const consumer = await startConsumer(
        kafkaConfig,
        createBatchHandler({ engine, interest })
      );
      try {
        const deadline = Date.now() + BROKER_WAIT_MS;
        let rows: { profile_id: string }[] = [];
        // fromBeginning: false skips anything sent before the group's first fetch, so keep publishing.
        while (rows.length === 0 && Date.now() < deadline) {
          await producer.send({
            topic: kafkaConfig.topic,
            messages: [{ value: payload(RULE_EVENT, 'broker-user') }],
          });
          await Bun.sleep(POLL_MS);
          rows = await sql.$queryRawUnsafe<{ profile_id: string }[]>(
            'SELECT profile_id FROM nudge.events WHERE project_id = $1 AND name = $2',
            PROJECT,
            RULE_EVENT
          );
        }
        expect(rows[0]?.profile_id).toBe('broker-user');
      } finally {
        await consumer.stop();
        await producer.disconnect();
        await admin.deleteTopics({ topics: [kafkaConfig.topic] });
        await admin.disconnect();
      }
    },
    BROKER_WAIT_MS + 15_000
  );
});
