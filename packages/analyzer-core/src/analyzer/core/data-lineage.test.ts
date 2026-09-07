import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDataLineage, type DataLineageInput } from './data-lineage';
import type { CASExitPoint } from '../../types/cas.types';

// Regression coverage for the security-facing defect: exposure_highlights.
// external_recipients listing internal/stdlib calls (time.Now, errors.Is,
// fmt.Sprintf, reflect.DeepEqual, s.db.Exec) as if they were external
// destinations for sensitive data. The prior resolveRecipientService()
// accepted ANY exit point whose bare name merely "looked like" a clean
// identifier when no structured target was set — but go-analyzer.ts's
// isExternalLibraryCall (and the equivalent chained-call extraction in
// csharp/java/php/solidity-analyzer.ts) tags every non-local call, INCLUDING
// standard-library helpers and same-process struct methods, as an exit point
// with no `target` at all. The fix requires structured destination evidence
// (target.service_id / target.sdk, set only by analyzers that resolve a real
// outbound destination — outbound-http-client-analyzer.ts, messaging-
// analyzer.ts, etc.) and drops everything else rather than guessing from
// spelling.

function exitPoint(overrides: Partial<CASExitPoint>): CASExitPoint {
  return {
    id: overrides.id || 'exit_1',
    source_node: 'fn_1',
    type: 'sdk',
    name: 'External call: unnamed',
    ...overrides,
  } as CASExitPoint;
}

function lineageInputFor(exitPoints: CASExitPoint[]): DataLineageInput {
  return {
    nodes: [{ id: 'fn_1', type: 'function', name: 'IssueToken', source: { file: 'handler.go' } } as any],
    edges: [],
    dataEntities: [
      {
        id: 'entity_apikey',
        name: 'APIKey',
        fields: [{ name: 'Token', is_sensitive: true }],
        lifecycle: { created_by: ['fn_1'], updated_by: [], deleted_by: [], read_by: [] },
      } as any,
    ],
    exitPoints,
    entryPoints: [],
    userJourneys: [],
  };
}

test('a Go stdlib/local call misclassified as an exit point (no structured target) is DROPPED, never surfaced as a recipient', () => {
  // Exactly the reported production shape: go-analyzer.ts's
  // isExternalLibraryCall tags fmt.Sprintf/errors.Is/reflect.DeepEqual/
  // time.Now/crypto.GenerateRandomStringHex as 'sdk' exit points with no
  // target — and s.db.Exec/s.db.QueryRow the same way for a same-process
  // struct method.
  const noisyExits: CASExitPoint[] = [
    exitPoint({ id: 'e1', name: 'External call: fmt.Sprintf' }),
    exitPoint({ id: 'e2', name: 'External call: errors.Is' }),
    exitPoint({ id: 'e3', name: 'External call: reflect.DeepEqual' }),
    exitPoint({ id: 'e4', name: 'External call: time.Now' }),
    exitPoint({ id: 'e5', name: 'External call: crypto.GenerateRandomStringHex' }),
    exitPoint({ id: 'e6', name: 'External call: s.db.Exec' }),
    exitPoint({ id: 'e7', name: 'External call: s.db.QueryRow' }),
  ];

  const lineages = buildDataLineage(lineageInputFor(noisyExits));
  assert.equal(lineages.length, 1);
  assert.deepEqual(lineages[0].external_recipients, []);
  assert.equal(lineages[0].exposure.external_transfer, false);
});

test('a dependency name alone leaves transfer unresolved without dropping the exit', () => {
  const dependency = exitPoint({ id: 'dependency', target: { sdk: 'formatting-library', endpoint: 'transform' } });
  const input = lineageInputFor([dependency]);
  const before = JSON.stringify(input);
  const [lineage] = buildDataLineage(input);
  assert.deepEqual(lineage.external_recipients, []);
  assert.deepEqual((lineage as any).unresolved_exit_point_ids, ['dependency']);
  assert.equal(lineage.exposure.external_transfer, false);
  assert.equal((lineage.exposure as any).external_transfer_unresolved, true);
  assert.equal(JSON.stringify(input), before);
});

test('an SDK call with an explicit destination retains its transfer evidence', () => {
  const [lineage] = buildDataLineage(lineageInputFor([
    exitPoint({ id: 'delivery', target: { sdk: 'delivery-library', service_id: 'delivery-service' } }),
  ]));
  assert.deepEqual(lineage.external_recipients.map(recipient => recipient.service), ['delivery-service']);
  assert.equal(lineage.exposure.external_transfer, true);
  assert.equal((lineage as any).unresolved_exit_point_ids, undefined);
});

test('a real outbound HTTP client call (structured target.service_id) IS surfaced as a recipient', () => {
  const realExit = exitPoint({
    id: 'e8',
    type: 'api',
    name: 'POST https://api.stripe.com/v1/charges',
    target: { service_id: 'stripe', endpoint: 'https://api.stripe.com/v1/charges', resource: 'https://api.stripe.com/v1/charges' },
  });

  const lineages = buildDataLineage(lineageInputFor([realExit]));
  assert.equal(lineages.length, 1);
  assert.deepEqual(
    lineages[0].external_recipients.map(r => r.service),
    ['stripe']
  );
  assert.equal(lineages[0].exposure.external_transfer, true);
});

test('a mix of noise and a real recipient surfaces ONLY the real one', () => {
  const exits: CASExitPoint[] = [
    exitPoint({ id: 'e1', name: 'External call: fmt.Sprintf' }),
    exitPoint({
      id: 'e2',
      type: 'message',
      name: 'orders publish to fanout',
      target: { service_id: 'kafka', endpoint: 'orders', resource: 'orders' },
    }),
  ];
  const lineages = buildDataLineage(lineageInputFor(exits));
  assert.deepEqual(lineages[0].external_recipients.map(r => r.service), ['kafka']);
});
