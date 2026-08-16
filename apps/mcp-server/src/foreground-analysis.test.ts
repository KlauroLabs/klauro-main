import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  beginForegroundAnalysis,
  foregroundAnalysisActive,
  waitForForegroundAnalysisIdle,
} from './foreground-analysis';

test('foreground analysis remains active until every overlapping run ends', async () => {
  const endFirst = beginForegroundAnalysis();
  const endSecond = beginForegroundAnalysis();
  let idle = false;
  const waiting = waitForForegroundAnalysisIdle(0).then(() => { idle = true; });

  endFirst();
  await Promise.resolve();
  assert.equal(foregroundAnalysisActive(), true);
  assert.equal(idle, false);

  endSecond();
  await waiting;
  assert.equal(foregroundAnalysisActive(), false);
  assert.equal(idle, true);
});

test('foreground analysis completion handles repeated release safely', () => {
  const end = beginForegroundAnalysis();
  end();
  end();
  assert.equal(foregroundAnalysisActive(), false);
});
