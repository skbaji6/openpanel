import { beforeAll, describe, expect, it } from 'bun:test';
import { sql } from '../db/client';
import { migrate } from '../db/migrate';
import { MESSAGE_STATUSES, MILESTONES, statusRank } from './status';

const UNKNOWN_RANK = -1;

describe('message status order', () => {
  beforeAll(async () => {
    await migrate();
  });

  it('the SQL rank function orders statuses exactly as MESSAGE_STATUSES', async () => {
    const ranks: number[] = [];
    for (const status of MESSAGE_STATUSES) {
      const [row] = await sql.$queryRawUnsafe<{ rank: number }[]>(
        'SELECT marketing.message_status_rank($1) AS rank',
        status
      );
      ranks.push(row?.rank ?? Number.NaN);
    }
    expect(ranks).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(MESSAGE_STATUSES.map(statusRank)).toEqual(ranks);
  });

  it('an unknown status ranks below every known one', async () => {
    const [row] = await sql.$queryRawUnsafe<{ rank: number }[]>(
      `SELECT marketing.message_status_rank('pending') AS rank`
    );
    expect(row?.rank).toBe(UNKNOWN_RANK);
  });

  it('milestones are the six timestamps the funnel counts', () => {
    expect([...MILESTONES]).toEqual([
      'accepted',
      'delivered',
      'read',
      'clicked',
      'converted',
      'failed',
    ]);
  });
});
