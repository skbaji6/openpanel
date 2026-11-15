import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { resetMarketingTables } from '../db/test-helpers';
import { type ImportOptions, planImport } from './import-plan';
import { applyImport } from './import-store';

const PROJECT = 'proj-a';
const OTHER_PROJECT = 'proj-b';
const PLATFORM = 'In-App Notification';
const options: ImportOptions = { states: { TS: 'TS' } };

function plan(messages: [string, string], extra: Partial<ImportOptions> = {}) {
  const rows = [
    ['Cart Abandoned', 'D0', messages[0]],
    ['Cart Abandoned', 'D1', messages[1]],
  ].map(([event, timing, message], index) => {
    const cells: Record<string, string> = Object.create(null);
    cells['Event Name'] = event ?? '';
    cells.Platform = PLATFORM;
    cells.Timing = timing ?? '';
    cells['Message (Content)'] = message ?? '';
    return { rowNumber: index + 2, cells };
  });
  const { journeys } = planImport([{ sheet: 'TS', rows }], {
    ...options,
    ...extra,
  });
  return journeys;
}

type RuleRow = {
  id: string;
  status: string;
  version: number;
  definition: {
    trigger: { event: string };
    goal: { event: string };
    steps: { variants: Record<string, { body: string }> }[];
  };
  unconfirmed: string[];
  imported_steps_hash: string | null;
};

async function rules(project = PROJECT) {
  return await sql.$queryRawUnsafe<RuleRow[]>(
    `SELECT id::text, status, version, definition, unconfirmed, imported_steps_hash
     FROM marketing.rules WHERE project_id = $1 AND journey_key = 'cart_abandoned'`,
    project
  );
}

const run = (
  planned: ReturnType<typeof plan>,
  extra: { overwriteEdited?: boolean; dryRun?: boolean } = {}
) => applyImport(sql, PROJECT, planned, { dryRun: false, ...extra });

beforeAll(async () => {
  await migrate();
});
beforeEach(async () => {
  await resetMarketingTables();
});
afterAll(() => sql.$disconnect());

describe('applyImport', () => {
  it('first import creates drafts', async () => {
    const [result] = await run(plan(['one', 'two']));
    expect(result).toMatchObject({ key: 'cart_abandoned', action: 'created' });
    const [row] = await rules();
    expect(row?.status).toBe('draft');
    expect(row?.id).toBe(result?.ruleId ?? '');
    expect(row?.unconfirmed).toEqual(['trigger', 'goal']);
    expect(row?.imported_steps_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.definition.steps).toHaveLength(2);
  });

  it('re-import with changed text updates the draft by key', async () => {
    await run(plan(['one', 'two']));
    const [result] = await run(plan(['one', 'changed']));
    expect(result?.action).toBe('updated');
    const found = await rules();
    expect(found).toHaveLength(1);
    expect(found[0]?.version).toBe(2);
    expect(found[0]?.definition.steps[1]?.variants.TS?.body).toBe('changed');
  });

  it('re-import with equal text is unchanged and keeps the version', async () => {
    await run(plan(['one', 'two']));
    const [result] = await run(plan(['one', 'two']));
    expect(result?.action).toBe('unchanged');
    expect((await rules())[0]?.version).toBe(1);
  });

  it('a draft whose step text was edited in the dashboard is skipped_edited', async () => {
    await run(plan(['one', 'two']));
    await sql.$executeRawUnsafe(
      `UPDATE marketing.rules SET definition = jsonb_set(definition, '{steps,0,variants,TS,body}', '"edited"')
       WHERE journey_key = 'cart_abandoned'`
    );
    const [result] = await run(plan(['one', 'changed']));
    expect(result?.action).toBe('skipped_edited');
    expect((await rules())[0]?.definition.steps[0]?.variants.TS?.body).toBe(
      'edited'
    );
  });

  it('a draft whose trigger and goal were confirmed is still updated by re-import', async () => {
    await run(plan(['one', 'two']));
    await sql.$executeRawUnsafe(
      `UPDATE marketing.rules SET unconfirmed = '{}',
         definition = jsonb_set(jsonb_set(definition, '{trigger,event}', '"my_trigger"'), '{goal,event}', '"my_goal"')
       WHERE journey_key = 'cart_abandoned'`
    );
    const [result] = await run(plan(['one', 'changed']));
    expect(result?.action).toBe('updated');
    const [row] = await rules();
    expect(row?.definition.trigger.event).toBe('my_trigger');
    expect(row?.definition.goal.event).toBe('my_goal');
    expect(row?.unconfirmed).toEqual([]);
    expect(row?.definition.steps[1]?.variants.TS?.body).toBe('changed');
  });

  it('overwriteEdited replaces only steps and keeps the edited trigger and goal', async () => {
    await run(plan(['one', 'two']));
    await sql.$executeRawUnsafe(
      `UPDATE marketing.rules SET unconfirmed = '{}',
         definition = jsonb_set(jsonb_set(jsonb_set(definition, '{trigger,event}', '"my_trigger"'), '{goal,event}', '"my_goal"'), '{steps,0,variants,TS,body}', '"edited"')
       WHERE journey_key = 'cart_abandoned'`
    );
    const [result] = await run(plan(['one', 'changed']), {
      overwriteEdited: true,
    });
    expect(result?.action).toBe('updated');
    const [row] = await rules();
    expect(row?.definition.trigger.event).toBe('my_trigger');
    expect(row?.definition.goal.event).toBe('my_goal');
    expect(row?.definition.steps[0]?.variants.TS?.body).toBe('one');
  });

  it('a supplied trigger or goal replaces that entry and confirms it', async () => {
    await run(plan(['one', 'two']));
    const [result] = await run(
      plan(['one', 'two'], {
        journeys: { cart_abandoned: { goalEvent: 'bought' } },
      })
    );
    expect(result?.action).toBe('updated');
    const [row] = await rules();
    expect(row?.definition.goal.event).toBe('bought');
    expect(row?.definition.trigger.event).toBe('cart_abandoned');
    expect(row?.unconfirmed).toEqual(['trigger']);
  });

  it.each([
    'active',
    'paused',
  ])('a %s journey with the same key is skipped_live and its definition is byte-identical afterwards', async (status) => {
    await run(plan(['one', 'two']));
    await sql.$executeRawUnsafe(
      `UPDATE marketing.rules SET status = $1 WHERE journey_key = 'cart_abandoned'`,
      status
    );
    const before = await sql.$queryRawUnsafe(
      `SELECT definition::text AS d, version, unconfirmed, imported_steps_hash, updated_at
         FROM marketing.rules WHERE journey_key = 'cart_abandoned'`
    );
    const [result] = await run(plan(['x', 'y']), { overwriteEdited: true });
    expect(result?.action).toBe('skipped_live');
    const after = await sql.$queryRawUnsafe(
      `SELECT definition::text AS d, version, unconfirmed, imported_steps_hash, updated_at
         FROM marketing.rules WHERE journey_key = 'cart_abandoned'`
    );
    expect(after).toEqual(before);
  });

  it('dryRun writes nothing and reports the same actions', async () => {
    const dry = await run(plan(['one', 'two']), { dryRun: true });
    expect(dry[0]).toEqual({
      key: 'cart_abandoned',
      action: 'created',
      ruleId: null,
    });
    expect(await rules()).toHaveLength(0);
    await run(plan(['one', 'two']));
    const dryUpdate = await run(plan(['one', 'changed']), { dryRun: true });
    expect(dryUpdate[0]?.action).toBe('updated');
    expect((await rules())[0]?.version).toBe(1);
  });

  it('keys are scoped to the project', async () => {
    await applyImport(sql, OTHER_PROJECT, plan(['one', 'two']), {
      dryRun: false,
    });
    const [result] = await run(plan(['one', 'two']));
    expect(result?.action).toBe('created');
    expect(await rules(OTHER_PROJECT)).toHaveLength(1);
  });

  it('two concurrent imports of the same key create one row', async () => {
    const results = await Promise.all([
      run(plan(['one', 'two'])),
      run(plan(['one', 'two'])),
      run(plan(['one', 'two'])),
    ]);
    const actions = results.map((r) => r[0]?.action).sort();
    expect(actions).toEqual(['created', 'unchanged', 'unchanged']);
    expect(await rules()).toHaveLength(1);
  });
});
