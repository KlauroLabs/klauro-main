import assert from 'node:assert/strict';
import test from 'node:test';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import type { CASCausalJourney } from '../../../packages/analyzer-core/src/types/causal-journey.types';
import { getCausalJourneys, hasCausalJourneys, scopeCausalJourneys } from './causal-journeys';

function journey(rank: number, representative: boolean, file: string): CASCausalJourney {
  return {
    id: `journey:${rank}`,
    label: `Journey ${rank}`,
    does: `does ${rank}`,
    rank,
    representative,
    steps: [
      { file, symbol: 'send', does: 'Send: sends chat:run over the ipc bridge', via: undefined },
      { file: 'src/handler.rs', symbol: 'handle', does: 'Handle: starts an external process', via: 'ipc', effect: 'process:Command::new' },
    ],
  };
}

const cas = { causal_journeys: [journey(2, false, 'b.ts'), journey(1, true, 'a.ts')] } as unknown as CASOutput;

test('the engine journeys are returned in rank order with their steps', () => {
  const result = getCausalJourneys(cas) as { total: number; journeys: CASCausalJourney[] };
  assert.equal(result.total, 2);
  assert.deepEqual(result.journeys.map(item => item.rank), [1, 2]);
  assert.equal(result.journeys[0].steps[1].via, 'ipc');
  assert.equal(result.journeys[0].steps[1].effect, 'process:Command::new');
});

test('representative journeys can be asked for alone and paged', () => {
  const result = getCausalJourneys(cas, { kind: 'representative' }) as { total: number };
  assert.equal(result.total, 1);
  const paged = getCausalJourneys(cas, { limit: 1, offset: 1 }) as { journeys: CASCausalJourney[] };
  assert.equal(paged.journeys[0].rank, 2);
});

test('a journey is found by id and steps can be left out', () => {
  assert.equal((getCausalJourneys(cas, { journeyId: 'journey:1' }) as { journey: CASCausalJourney }).journey.rank, 1);
  const slim = getCausalJourneys(cas, { includeSteps: false }) as { journeys: Array<{ steps?: unknown; step_count: number }> };
  assert.equal(slim.journeys[0].steps, undefined);
  assert.equal(slim.journeys[0].step_count, 2);
});

test('an analysis without engine journeys is not claimed to have them', () => {
  assert.equal(hasCausalJourneys({} as CASOutput), false);
  assert.equal(hasCausalJourneys(cas), true);
});

test('a slice keeps only the journeys that touch its files', () => {
  const scoped = scopeCausalJourneys(cas.causal_journeys, new Set(['a.ts']));
  assert.deepEqual(scoped?.map(item => item.rank), [1]);
  assert.equal(scopeCausalJourneys(cas.causal_journeys, new Set(['z.ts'])), undefined);
});
