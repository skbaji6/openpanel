import { describe, expect, it } from 'bun:test';
import {
  CAMPAIGN_STATES,
  type CampaignAction,
  type CampaignState,
  fromStates,
  nextState,
  TERMINAL_STATES,
} from './state';

const ACTIONS: CampaignAction[] = [
  'schedule',
  'unschedule',
  'start',
  'claim_due',
  'miss',
  'pause',
  'resume',
  'cancel',
  'complete',
  'fail',
];

const EXPECTED: Record<
  CampaignState,
  Partial<Record<CampaignAction, CampaignState>>
> = {
  draft: { schedule: 'scheduled', start: 'running' },
  scheduled: {
    unschedule: 'draft',
    start: 'running',
    claim_due: 'running',
    miss: 'missed',
    cancel: 'cancelled',
  },
  running: {
    pause: 'paused',
    cancel: 'cancelled',
    complete: 'completed',
    fail: 'failed',
  },
  paused: { resume: 'running', cancel: 'cancelled', fail: 'failed' },
  completed: {},
  cancelled: {},
  failed: {},
  missed: {},
};

const SEED = 20_261_103;
const SEQUENCES = 10_000;
const MAX_LENGTH = 20;

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d_2b_79_f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe('nextState', () => {
  it('matches the table exactly', () => {
    for (const state of CAMPAIGN_STATES) {
      for (const action of ACTIONS) {
        expect(nextState(state, action)).toBe(EXPECTED[state][action] ?? null);
      }
    }
  });

  it('terminal states accept no action', () => {
    for (const state of TERMINAL_STATES) {
      for (const action of ACTIONS) {
        expect(nextState(state, action)).toBeNull();
      }
    }
  });

  it('keeps its invariants over random action sequences', () => {
    const random = mulberry32(SEED);
    const reached = new Set<CampaignState>();
    for (let run = 0; run < SEQUENCES; run++) {
      let state: CampaignState = 'draft';
      const length = 1 + Math.floor(random() * MAX_LENGTH);
      for (let step = 0; step < length; step++) {
        const action = ACTIONS[Math.floor(random() * ACTIONS.length)]!;
        const next = nextState(state, action);
        if (!next) {
          continue;
        }
        expect(TERMINAL_STATES as readonly string[]).not.toContain(state);
        if (next === 'running') {
          expect(['start', 'claim_due', 'resume']).toContain(action);
        }
        expect(CAMPAIGN_STATES).toContain(next);
        reached.add(next);
        state = next;
      }
    }
    for (const state of CAMPAIGN_STATES) {
      if (state !== 'draft') {
        expect(reached.has(state)).toBe(true);
      }
    }
  });
});

describe('fromStates', () => {
  it('lists exactly the states that accept the action', () => {
    for (const action of ACTIONS) {
      const expected = CAMPAIGN_STATES.filter(
        (state) => EXPECTED[state][action]
      );
      expect(fromStates(action).sort()).toEqual([...expected].sort());
    }
  });

  // The campaign service's fenced update sets one target state per action.
  it('every from-state of an action leads to the same target', () => {
    for (const action of ACTIONS) {
      const targets = new Set(
        fromStates(action).map((state) => nextState(state, action))
      );
      expect(targets.size).toBe(1);
    }
  });
});
