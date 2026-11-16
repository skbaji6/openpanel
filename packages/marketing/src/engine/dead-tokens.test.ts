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
import { filterLiveTokens, hashToken, recordDeadTokens } from './dead-tokens';

const KEY = 'k'.repeat(32);
const OTHER_KEY = 'o'.repeat(32);

describe('dead tokens', () => {
  beforeAll(async () => {
    await migrate();
  });
  beforeEach(async () => {
    await resetMarketingTables();
  });
  afterAll(async () => {
    await resetMarketingTables();
    await sql.$disconnect();
  });

  it('recordDeadTokens then filterLiveTokens removes only those tokens', async () => {
    await recordDeadTokens(sql, 'p', ['b', 'b', 'd'], KEY);
    await recordDeadTokens(sql, 'p', [], KEY);
    expect(
      await filterLiveTokens(sql, 'p', ['a', 'b', 'c', 'd', 'a'], KEY)
    ).toEqual(['a', 'c', 'a']);
    expect(await filterLiveTokens(sql, 'other', ['b'], KEY)).toEqual(['b']);
    expect(await filterLiveTokens(sql, 'p', [], KEY)).toEqual([]);
  });

  it('the stored hash is not the token and differs per project key', async () => {
    expect(hashToken(KEY, 'tok').equals(hashToken(OTHER_KEY, 'tok'))).toBe(
      false
    );
    expect(hashToken(KEY, 'tok').equals(hashToken(KEY, 'tok'))).toBe(true);
    await recordDeadTokens(sql, 'p', ['tok'], KEY);
    const [row] = await sql.$queryRawUnsafe<{ token_hash: Uint8Array }[]>(
      'SELECT token_hash FROM marketing.dead_tokens'
    );
    expect(Buffer.from(row?.token_hash ?? []).equals(Buffer.from('tok'))).toBe(
      false
    );
    expect(await filterLiveTokens(sql, 'p', ['tok'], OTHER_KEY)).toEqual([
      'tok',
    ]);
  });
});
