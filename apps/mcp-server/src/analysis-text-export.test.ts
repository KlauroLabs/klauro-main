import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { exportAnalysisText } from './analysis-text-export';

function part(name: string, root: string): CASOutput {
  return { system: { name, root_path: `/repo/${root}` }, nodes: [{}, {}], entry_points: [{}], capabilities: [], flows: [] } as unknown as CASOutput;
}

function system(): CASOutput {
  return {
    system: { name: 'shop', root_path: '/repo' },
    nodes: [],
    children: [part('orders', 'services/orders'), part('billing', 'services/billing')],
    capabilities: [],
    flows: [{ name: 'create order', standing: 'terminal', steps: [{}, {}], entities: ['Order'] }],
    entities: [{ name: 'Order', fields: [{ name: 'id' }, { name: 'total' }], relations: [{ target_name: 'Invoice' }] }],
    communication_seams: {
      seams: [
        { source: 'orders', target: 'billing', modality: 'sync', summary: 'orders calls billing', metadata: { contract: 'POST /charge' } },
        { source: 'orders', target: 'PostgreSQL', modality: 'sync', summary: 'orders calls PostgreSQL', metadata: { contract: 'PostgreSQL' } },
        { source: 'billing', target: 'orders', modality: 'async', summary: 'billing hands orders', metadata: { contract: 'event paid' } },
      ],
      link_coverage: [{ sub_project: 'orders', detected: 3, linked: 2, unlinked_count: 1 }],
    },
  } as unknown as CASOutput;
}

test('the container diagram draws sub-projects, external services and seams', () => {
  const { text } = exportAnalysisText(system(), 'mermaid');
  assert.match(text, /^flowchart LR\n/);
  assert.match(text, /c0\["billing"\]/);
  assert.match(text, /c1\["orders"\]/);
  assert.match(text, /e0\[\("PostgreSQL"\)\]/);
  assert.match(text, /c1 -->\|"POST \/charge"\| c0/);
  assert.match(text, /c0 -\.->\|"event paid"\| c1/);
});

test('the model-as-code text names containers by root and relations by modality', () => {
  const { text } = exportAnalysisText(system(), 'c4');
  assert.match(text, /c1 = container "orders" "" "services\/orders"/);
  assert.match(text, /e0 = softwareSystem "PostgreSQL" "" "External"/);
  assert.match(text, /c1 -> c0 "POST \/charge" "sync"/);
  assert.match(text, /container system \{/);
});

test('the markdown export lists every section and says so when capabilities are empty', () => {
  const { text } = exportAnalysisText(system(), 'markdown');
  const headings = text.split('\n').filter(line => line.startsWith('## '));
  assert.deepEqual(headings, ['## Sub-projects', '## Capabilities', '## Flows', '## Entities', '## Seams', '## Link coverage']);
  assert.match(text, /## Capabilities\n\n_None recorded\._/);
  assert.match(text, /\| create order \| terminal \| 2 \| Order \|/);
  assert.match(text, /\| orders \| billing \| sync \| POST \/charge \|/);
});

test('the markdown export is identical for identical analyses so it can be diffed', () => {
  assert.equal(exportAnalysisText(system(), 'markdown').text, exportAnalysisText(system(), 'markdown').text);
});

test('a repository with no sub-projects renders as one container', () => {
  const single = { system: { name: 'solo', root_path: '/repo' }, nodes: [] } as unknown as CASOutput;
  assert.match(exportAnalysisText(single, 'mermaid').text, /c0\["solo"\]/);
  assert.match(exportAnalysisText(single, 'markdown').text, /## Seams\n\n_None recorded\._/);
});
