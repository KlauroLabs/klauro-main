import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePack } from './pack-schema';
import { ENTRY_POINT_TYPES } from '../../types/cas.types';

test('validatePack accepts a well-formed pack', () => {
  const result = validatePack({
    pack: 'koa-routes',
    language: 'typescript',
    applies_when: { dependency: ['koa'] },
    rules: [
      {
        name: 'route-call',
        query: '(call_expression) @call',
        emit: [{ fact: 'entry_point', kind: 'http', path: '@call' }],
      },
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.pack?.pack, 'koa-routes');
});

test('validatePack rejects a pack missing required fields with field-specific errors', () => {
  const result = validatePack({ pack: 'broken' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.startsWith('language:')), 'should report missing language');
  assert.ok(result.errors.some(e => e.startsWith('rules:')), 'should report missing rules');
});

test('validatePack rejects a rule with no emit entries', () => {
  const result = validatePack({
    pack: 'no-emit',
    language: 'typescript',
    rules: [{ name: 'r1', query: '(call_expression) @c', emit: [] }],
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.includes('rules.0.emit')));
});

test('validatePack rejects an unknown emit fact discriminator', () => {
  const result = validatePack({
    pack: 'bad-emit',
    language: 'typescript',
    rules: [{ name: 'r1', query: '(call_expression) @c', emit: [{ fact: 'not_a_real_fact' }] }],
  });
  assert.equal(result.ok, false);
});

test('validatePack accepts every entry-point kind in the ENTRY_POINT_TYPES source of truth', () => {
  for (const kind of ENTRY_POINT_TYPES) {
    const result = validatePack({
      pack: `k-${kind}`,
      language: 'typescript',
      rules: [{ name: 'r1', query: '(call_expression) @c', emit: [{ fact: 'entry_point', kind, path: '@c' }] }],
    });
    assert.equal(result.ok, true, `kind "${kind}" should be a valid entry-point emit kind`);
  }
});

test('validatePack rejects a bogus entry-point kind with a clear, scoped error and no fabricated pack', () => {
  const result = validatePack({
    pack: 'bad-kind',
    language: 'typescript',
    rules: [{ name: 'r1', query: '(call_expression) @c', emit: [{ fact: 'entry_point', kind: 'htttp', path: '@c' }] }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.pack, undefined, 'an invalid kind must not yield a usable pack (no silently-dropped fact)');
  const kindErr = result.errors.find(e => e.startsWith('rules.0.emit.0.kind'));
  assert.ok(kindErr, `error should be scoped to the offending field: ${JSON.stringify(result.errors)}`);
  assert.ok(kindErr!.includes('http'), 'error should list the allowed kinds');
});

test('validatePack rejects a non-array applies_when.dependency', () => {
  const result = validatePack({
    pack: 'bad-applies',
    language: 'typescript',
    applies_when: { dependency: 'koa' }, // should be an array
    rules: [{ name: 'r1', query: '(call_expression) @c', emit: [{ fact: 'entry_point', kind: 'http', path: '@c' }] }],
  });
  assert.equal(result.ok, false);
});

test('validatePack defaults applies_when to an empty object when omitted', () => {
  const result = validatePack({
    pack: 'no-gate',
    language: 'typescript',
    rules: [{ name: 'r1', query: '(call_expression) @c', emit: [{ fact: 'entry_point', kind: 'http', path: '@c' }] }],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.pack?.applies_when, {});
});
