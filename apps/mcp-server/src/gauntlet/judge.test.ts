import test from 'node:test';
import assert from 'node:assert/strict';
import { parseScore, resolveJudgeCommand, judgeQuality } from './judge';

test('parseScore extracts a 0..100 integer, preferring the last', () => {
  assert.equal(parseScore('87'), 87);
  assert.equal(parseScore('I would score this 92.'), 92);
  assert.equal(parseScore('scores: 45 then settles on 78'), 78);
  assert.equal(parseScore('100'), 100);
});

test('parseScore rejects out-of-range and non-numeric', () => {
  assert.equal(parseScore('no number here'), null);
  assert.equal(parseScore('120 is too high but 65 fits'), 65); // 120 rejected, 65 kept
  assert.equal(parseScore(''), null);
});

test('resolveJudgeCommand is off unless explicitly enabled', () => {
  const savedJudge = process.env.KLAURO_JUDGE;
  const savedCmd = process.env.KLAURO_JUDGE_CMD;
  delete process.env.KLAURO_JUDGE; delete process.env.KLAURO_JUDGE_CMD;
  assert.equal(resolveJudgeCommand(), null);
  process.env.KLAURO_JUDGE_CMD = 'my-judge {prompt_file}';
  assert.deepEqual(resolveJudgeCommand(), { command: 'my-judge {prompt_file}', label: 'configured-judge' });
  if (savedJudge === undefined) delete process.env.KLAURO_JUDGE; else process.env.KLAURO_JUDGE = savedJudge;
  if (savedCmd === undefined) delete process.env.KLAURO_JUDGE_CMD; else process.env.KLAURO_JUDGE_CMD = savedCmd;
});

test('judgeQuality returns null when judging is unavailable (no fabricated score)', async () => {
  const saved = process.env.KLAURO_JUDGE; const savedCmd = process.env.KLAURO_JUDGE_CMD;
  delete process.env.KLAURO_JUDGE; delete process.env.KLAURO_JUDGE_CMD;
  const out = await judgeQuality({ task: 't', expected: 'e', armLabel: 'klauro', resultText: 'some answer' });
  assert.equal(out, null);
  if (saved !== undefined) process.env.KLAURO_JUDGE = saved;
  if (savedCmd !== undefined) process.env.KLAURO_JUDGE_CMD = savedCmd;
});

test('judgeQuality uses an explicit command and parses its integer output', async () => {
  // A deterministic fake judge: prints a fixed score regardless of input.
  const out = await judgeQuality(
    { task: 't', expected: 'e', armLabel: 'klauro', resultText: 'a real answer' },
    { command: 'echo 83', label: 'fake' }
  );
  assert.equal(out?.score, 83);
  assert.equal(out?.judge, 'fake');
});

test('judgeQuality returns null on empty result text', async () => {
  const out = await judgeQuality(
    { task: 't', expected: 'e', armLabel: 'klauro', resultText: '   ' },
    { command: 'echo 50' }
  );
  assert.equal(out, null);
});
