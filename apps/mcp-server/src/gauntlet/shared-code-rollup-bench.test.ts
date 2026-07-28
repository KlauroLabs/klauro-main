/**
 * Shared-code rollup bench — asserts the cross-deployable shared-code rollup
 * is real on the fixture monorepo: the `libs/auth` shared lib is consumed by
 * both `apps/service-a` and `apps/service-b`, with a non-empty consumed
 * surface per consumer and a correct blast radius (shared symbols map to
 * both consumers; a symbol only one app imports maps to just that one).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSharedCodeRollupBench, _resetSharedCodeRollupBenchCache } from './shared-code-rollup-bench';

test('shared-code rollup: libs/auth consumed by 2 deployables with non-empty surface + correct blast radius', async () => {
  _resetSharedCodeRollupBenchCache();
  const { graph, rollup, authRollup } = await runSharedCodeRollupBench();

  assert.ok(
    rollup.length > 0,
    `expected at least one shared-code rollup entry: ${JSON.stringify({ applications: graph.applications, links: graph.application_links }, null, 2)}`,
  );
  assert.ok(authRollup, 'expected a rollup entry for the auth lib');

  // Both consumers present.
  assert.equal(authRollup!.consumer_count, 2, `expected 2 consumers, got ${authRollup!.consumer_count}`);
  const consumerNames = authRollup!.consumers.map(c => c.deployable_name).sort();
  assert.deepEqual(consumerNames, ['service-a', 'service-b']);

  // Non-empty consumed surface, derivable from CAS import specifiers.
  assert.equal(authRollup!.surface_derivable, true, 'expected consumed surface to be derivable from CAS import specifiers');
  assert.ok(authRollup!.consumed_surface.length > 0, 'expected a non-empty consumed surface');
  assert.ok(authRollup!.consumed_surface.includes('AuthGuard'), 'expected AuthGuard in the consumed surface (both apps import it)');

  // Each consumer's own consumed_symbols should be non-empty and a subset of the union surface.
  for (const consumer of authRollup!.consumers) {
    assert.ok(consumer.consumed_symbols.length > 0, `expected non-empty consumed_symbols for ${consumer.deployable_name}`);
    for (const symbol of consumer.consumed_symbols) {
      assert.ok(authRollup!.consumed_surface.includes(symbol), `${symbol} should be part of the union consumed_surface`);
    }
  }

  // Blast radius: AuthGuard is imported by both apps -> both deployables affected.
  const authGuardBlast = authRollup!.blast_radius.find(entry => entry.symbol === 'AuthGuard');
  assert.ok(authGuardBlast, 'expected a blast-radius entry for AuthGuard');
  assert.equal(authGuardBlast!.consumer_count, 2, 'AuthGuard should affect both deployables');

  // TokenService is only imported by service-a -> blast radius of 1.
  const tokenServiceBlast = authRollup!.blast_radius.find(entry => entry.symbol === 'TokenService');
  assert.ok(tokenServiceBlast, 'expected a blast-radius entry for TokenService');
  assert.equal(tokenServiceBlast!.consumer_count, 1, 'TokenService should affect only service-a');

  // resolveUserRole is only imported by service-b -> blast radius of 1.
  const resolveUserRoleBlast = authRollup!.blast_radius.find(entry => entry.symbol === 'resolveUserRole');
  assert.ok(resolveUserRoleBlast, 'expected a blast-radius entry for resolveUserRole');
  assert.equal(resolveUserRoleBlast!.consumer_count, 1, 'resolveUserRole should affect only service-b');
});
