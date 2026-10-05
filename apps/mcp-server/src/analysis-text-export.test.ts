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

function hostile(): CASOutput {
  const name = 'api"]\n!include /etc/passwd\nclick c0 href "javascript:alert(1)"';
  return {
    system: { name: 'repo\n!script run', root_path: '/repo' },
    nodes: [],
    children: [part(name, 'services/api'), part('web', 'services/web')],
    capabilities: [],
    flows: [],
    communication_seams: {
      seams: [{ source: 'web', target: name, modality: 'sync', summary: '', metadata: { contract: 'GET /x\n!include secrets <b>"' } }],
    },
  } as unknown as CASOutput;
}

test('repository-controlled names cannot start a new line in either text format', () => {
  for (const format of ['mermaid', 'c4'] as const) {
    const lines = exportAnalysisText(hostile(), format).text.split('\n');
    assert.ok(lines.every(line => !/^\s*(!include|!script|click)\b/.test(line)), `${format} kept a directive line`);
  }
});

test('mermaid labels carry no raw markup characters from repository names', () => {
  const { text } = exportAnalysisText(hostile(), 'mermaid');
  for (const label of text.match(/"[^"\n]*"/g) ?? []) {
    assert.doesNotMatch(label.slice(1, -1), /[<>&`]/);
  }
});

function describedSystem(): CASOutput {
  const whole = system();
  const [orders, billing] = whole.children as CASOutput[];
  orders.system.catalog = { owner: 'group:default/checkout', system: 'shop', depends_on: ['component:default/billing', 'resource:default/ledger'] };
  billing.system.catalog = { owner: 'group:default/payments' };
  return whole;
}

test('a described sub-project shows its owner and system in every export', () => {
  const whole = describedSystem();
  assert.match(exportAnalysisText(whole, 'mermaid').text, /c1\["orders \(owner: group:default\/checkout; system: shop\)"\]/);
  const code = exportAnalysisText(whole, 'c4').text;
  assert.match(code, /c1 = container "orders" "" "services\/orders" \{\n\s+properties \{\n\s+"owner" "group:default\/checkout"\n\s+"system" "shop"/);
  assert.match(code, /c0 = container "billing" "" "services\/billing" \{\n\s+properties \{\n\s+"owner" "group:default\/payments"\n\s+\}\n\s+\}/);
  const markdown = exportAnalysisText(whole, 'markdown').text;
  assert.match(markdown, /\| orders \| services\/orders \| group:default\/checkout \| shop \| component:default\/billing, resource:default\/ledger \| 2 \| 1 \| 0 \| 0 \|/);
});

test('a declared dependency is a relation unless a seam already joins the two', () => {
  const mermaid = exportAnalysisText(describedSystem(), 'mermaid').text;
  assert.match(mermaid, /c1 -->\|"POST \/charge"\| c0/);
  assert.doesNotMatch(mermaid, /"depends on"\| c0/);
  assert.match(mermaid, /e1\[\("resource:default\/ledger"\)\]/);
  assert.match(mermaid, /c1 -->\|"depends on"\| e1/);
  const lone = describedSystem();
  lone.communication_seams = { seams: [] } as unknown as CASOutput['communication_seams'];
  const code = exportAnalysisText(lone, 'c4').text;
  assert.match(code, /c1 -> c0 "depends on" "declared"/);
  assert.match(exportAnalysisText(lone, 'markdown').text, /\| orders \| billing \| declared \| depends on \|/);
});
