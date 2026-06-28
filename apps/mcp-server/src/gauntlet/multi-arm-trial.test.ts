import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreArmQuality } from './multi-arm-trial';
import { buildArmSpecs, liveCapableArmIds } from './arm-registry';

test('scoreArmQuality: error result floors at 5', () => {
  assert.equal(scoreArmQuality({ command_passed: true, files_changed: 1, error: 'boom' }), 5);
});

test('scoreArmQuality: passing validation beats failing validation', () => {
  const pass = scoreArmQuality({ command_passed: true, validation_passed: true, task_success: true, self_reported_quality: 9, files_changed: 1 });
  const fail = scoreArmQuality({ command_passed: true, validation_passed: false, task_success: false, self_reported_quality: 3, files_changed: 1 });
  assert.ok(pass > fail, `${pass} !> ${fail}`);
  assert.ok(pass <= 100 && fail >= 0);
});

test('scoreArmQuality: no-validation is neutral-positive (between fail and pass)', () => {
  const none = scoreArmQuality({ command_passed: true, files_changed: 1 });
  const fail = scoreArmQuality({ command_passed: true, validation_passed: false, files_changed: 1 });
  const pass = scoreArmQuality({ command_passed: true, validation_passed: true, files_changed: 1 });
  assert.ok(none > fail && none < pass);
});

test('scoreArmQuality: clean command contributes, failed command costs', () => {
  const ok = scoreArmQuality({ command_passed: true, files_changed: 1 });
  const bad = scoreArmQuality({ command_passed: false, files_changed: 1 });
  assert.ok(ok > bad);
});

test('scoreArmQuality: sprawling change is not rewarded like a focused one', () => {
  const focused = scoreArmQuality({ command_passed: true, files_changed: 3 });
  const sprawling = scoreArmQuality({ command_passed: true, files_changed: 50 });
  assert.ok(focused > sprawling);
});

test('scoreArmQuality: bounded 0..100', () => {
  const hi = scoreArmQuality({ command_passed: true, validation_passed: true, task_success: true, self_reported_quality: 10, files_changed: 2 });
  assert.ok(hi >= 0 && hi <= 100);
});

const cfg = { withKlauro: 'KCMD {prompt_file}', withoutKlauro: 'NCMD {prompt_file}' };

test('buildArmSpecs: klauro arm uses the Klauro launcher', () => {
  const specs = buildArmSpecs(['klauro'], cfg);
  assert.equal(specs.length, 1);
  assert.equal(specs[0].kind, 'klauro');
  assert.match(specs[0].command, /KCMD/);
});

test('buildArmSpecs: no-tools uses the plain launcher', () => {
  const specs = buildArmSpecs(['no-tools'], cfg);
  assert.equal(specs[0].kind, 'no-tools');
  assert.match(specs[0].command, /NCMD/);
});

test('buildArmSpecs: competitor arms attach a retrieval backend + plain launcher', () => {
  const specs = buildArmSpecs(['ctags', 'embeddings-rag', 'cursor-proxy'], cfg);
  assert.equal(specs.length, 3);
  for (const s of specs) {
    assert.equal(s.kind, 'competitor');
    assert.ok(s.retrieval, `${s.id} has no backend`);
    assert.match(s.command, /NCMD/);
  }
  assert.deepEqual(specs.map(s => s.retrieval!.id).sort(), ['ctags', 'cursor-proxy', 'embeddings-rag']);
});

test('buildArmSpecs: omits arms whose launcher command is missing', () => {
  assert.equal(buildArmSpecs(['klauro'], { withoutKlauro: 'NCMD' }).length, 0);
  assert.equal(buildArmSpecs(['no-tools'], { withKlauro: 'KCMD' }).length, 0);
  assert.equal(buildArmSpecs(['ctags'], { withKlauro: 'KCMD' }).length, 0);
});

test('buildArmSpecs: preserves requested arm order', () => {
  const specs = buildArmSpecs(['no-tools', 'klauro', 'cursor-proxy'], cfg);
  assert.deepEqual(specs.map(s => s.id), ['no-tools', 'klauro', 'cursor-proxy']);
});

test('buildArmSpecs: unknown arm id is dropped', () => {
  const specs = buildArmSpecs(['klauro', 'does-not-exist'], cfg);
  assert.deepEqual(specs.map(s => s.id), ['klauro']);
});

test('liveCapableArmIds: reflects configured launchers', () => {
  const ids = liveCapableArmIds(['klauro', 'no-tools', 'ctags', 'cursor-proxy'], cfg);
  assert.deepEqual([...ids].sort(), ['ctags', 'cursor-proxy', 'klauro', 'no-tools']);
  const klOnly = liveCapableArmIds(['klauro', 'no-tools', 'ctags'], { withKlauro: 'K' });
  assert.deepEqual([...klOnly], ['klauro']);
});
