import assert from 'node:assert/strict';
import test from 'node:test';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { projectJourneys } from '../../../packages/analyzer-core/src/analyzer/core/flow-chains';
import { getFlowChainJourneys } from './flow-chain-journeys';

interface Spec {
  id: string;
  name: string;
  entry: string;
  steps: string[];
  effect?: string;
}

interface Link {
  from: string;
  to: string;
  via: string;
  channel: string;
  source: string;
  target: string;
}

function casOf(specs: Spec[], links: Link[]): CASOutput {
  return {
    nodes: specs.flatMap(spec => spec.steps.map(step => ({ id: `${spec.id}/${step}`, name: step, type: 'function', source: { file: `${spec.id}.ts`, line: 1 } }))),
    entry_points: specs.map(spec => ({ id: `entry:${spec.id}`, source_node: spec.id, type: spec.entry, name: spec.name })),
    flows: specs.map(spec => ({
      flow_id: spec.id,
      name: spec.name,
      intent: spec.name,
      entry_point: `entry:${spec.id}`,
      entities: [],
      contract: { input: [], logic: spec.name, side_effects: { state_changes: [], external_integrations: [] }, output: [], constraints: [] },
      steps: spec.steps.map((step, at) => ({ step_id: `${spec.id}:${at}`, order: at + 1, name: step, description: step, functions: [{ function_id: `${spec.id}/${step}` }], entities: [] })),
      ...(spec.effect === undefined ? {} : { terminus: { exit_point_id: 'exit', kind: spec.effect.split(':')[0], produces: spec.effect.split(':')[1], node_id: spec.id } }),
    })),
    communication_seams: {
      seams: links.map((link, at) => ({
        id: `seam_${at}`,
        modality: 'sync',
        confidence: 0.8,
        kind: 'exit_point',
        source: link.source,
        target: link.target,
        evidence: '',
        summary: '',
        metadata: { via: link.via, channel: link.channel, from_flow: link.from, to_flow: link.to },
      })),
    },
  } as unknown as CASOutput;
}

const ui: Spec = { id: 'ui', name: 'Send a prompt', entry: 'ui', steps: ['type', 'submit'] };
const command: Spec = { id: 'command', name: 'Accept the prompt', entry: 'ipc', steps: ['validate', 'enqueue'] };
const hub: Spec = { id: 'hub', name: 'Run the prompt', entry: 'message', steps: ['dequeue', 'spawn'], effect: 'process:agent' };

test('a user-facing flow chains over an ipc crossing into the flow in the other program', () => {
  const cas = casOf([ui, command], [{ from: 'ui', to: 'command', via: 'ipc', channel: 'chat:send', source: 'app', target: 'engine' }]);
  const { journeys } = projectJourneys(cas);
  assert.equal(journeys.length, 1);
  assert.deepEqual(journeys[0].flows.map(flow => flow.flow_id), ['ui', 'command']);
  assert.equal(journeys[0].flows[1].via, 'ipc');
  assert.equal(journeys[0].programs, 2);
  assert.deepEqual(journeys[0].steps.map(step => step.name), ['type', 'submit', 'validate', 'enqueue']);
  assert.equal(journeys[0].steps[2].via, 'ipc');
  assert.equal(journeys[0].steps[0].via, undefined);
});

test('the chain continues across a queue hand-off and ends in the effect of the last flow', () => {
  const cas = casOf(
    [ui, command, hub],
    [
      { from: 'ui', to: 'command', via: 'ipc', channel: 'chat:send', source: 'app', target: 'engine' },
      { from: 'command', to: 'hub', via: 'queue', channel: 'Job', source: 'engine', target: 'hub' },
    ],
  );
  const { journeys, total } = projectJourneys(cas);
  assert.equal(total, 1);
  assert.deepEqual(journeys[0].flows.map(flow => [flow.flow_id, flow.via]), [['ui', undefined], ['command', 'ipc'], ['hub', 'queue']]);
  assert.equal(journeys[0].effect, 'process:agent');
  assert.equal(journeys[0].programs, 3);
  assert.equal(journeys[0].label, 'Send a prompt → Run the prompt');
});

test('a flow without a crossing is a journey only when it is user-facing and effectful', () => {
  const lone = { ...hub, id: 'lone', name: 'Open the file', entry: 'ui', effect: 'file:notes' };
  const quiet = { ...ui, id: 'quiet', name: 'Look around' };
  const internal = { ...hub, id: 'internal', name: 'Sweep', entry: 'schedule' };
  const { journeys } = projectJourneys(casOf([lone, quiet, internal], []));
  assert.deepEqual(journeys.map(journey => journey.label), ['Open the file']);
});

test('labels, steps and capability linkage are the flows own facts read through', () => {
  const cas = casOf([ui, command], [{ from: 'ui', to: 'command', via: 'ipc', channel: 'chat:send', source: 'app', target: 'engine' }]);
  (cas.flows ?? [])[0].capability_relationships = [{ capability_id: 'cap:chat', role: 'primary', rationale: '' }];
  const [journey] = projectJourneys(cas).journeys;
  assert.equal(journey.label, 'Send a prompt → Accept the prompt');
  assert.deepEqual(journey.flows[0].capabilities, ['cap:chat']);
  assert.equal(journey.steps[0].file, 'ui.ts');
});

test('journeys with more programs crossed rank first and a cycle is not followed twice', () => {
  const lone = { ...hub, id: 'lone', name: 'Open the file', entry: 'ui', effect: 'file:notes' };
  const cas = casOf(
    [ui, command, hub, lone],
    [
      { from: 'ui', to: 'command', via: 'ipc', channel: 'chat:send', source: 'app', target: 'engine' },
      { from: 'command', to: 'hub', via: 'queue', channel: 'Job', source: 'engine', target: 'hub' },
      { from: 'hub', to: 'command', via: 'event', channel: 'done', source: 'hub', target: 'engine' },
    ],
  );
  const { journeys } = projectJourneys(cas);
  assert.deepEqual(journeys.map(journey => journey.rank), [1, 2]);
  assert.equal(journeys[0].flows.length, 3);
  assert.equal(journeys[1].label, 'Open the file');
});

test('responses page the journeys, state the bounds and the true total, and find one by id', () => {
  const cas = casOf([ui, command, hub], [{ from: 'ui', to: 'command', via: 'ipc', channel: 'chat:send', source: 'app', target: 'engine' }]);
  const listed = getFlowChainJourneys(cas, { limit: 1 }) as { total: number; shown: number; bounds: { max_flows_per_journey: number }; journeys: Array<{ id: string }> };
  assert.equal(listed.total, 1);
  assert.equal(listed.shown, 1);
  assert.ok(listed.bounds.max_flows_per_journey > 0);
  const found = getFlowChainJourneys(cas, { journeyId: listed.journeys[0].id }) as { journey: { id: string } };
  assert.equal(found.journey.id, listed.journeys[0].id);
  const slim = getFlowChainJourneys(cas, { includeSteps: false }) as { journeys: Array<{ steps?: unknown; step_count: number }> };
  assert.equal(slim.journeys[0].steps, undefined);
  assert.equal(slim.journeys[0].step_count, 4);
  const markdown = (getFlowChainJourneys(cas, { format: 'markdown' }) as { markdown: string }).markdown;
  assert.match(markdown, /Send a prompt → Accept the prompt/);
});

test('an analysis without linked flows has no journeys', () => {
  assert.equal(projectJourneys({} as CASOutput).total, 0);
});
