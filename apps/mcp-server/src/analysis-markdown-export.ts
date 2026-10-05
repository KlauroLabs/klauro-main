import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { architectureModelOf } from './analysis-architecture-model';

const EMPTY = '_None recorded._';
const CELL_BREAK = /\r?\n/g;

function cell(text: string | number | undefined): string {
  return String(text ?? '').replace(CELL_BREAK, ' ').replace(/\|/g, '\\|');
}

function table(headers: string[], rows: Array<Array<string | number | undefined>>): string[] {
  if (rows.length === 0) return [EMPTY];
  const body = rows.map(row => `| ${row.map(cell).join(' | ')} |`).sort();
  return [`| ${headers.join(' | ')} |`, `|${headers.map(() => ' --- ').join('|')}|`, ...body];
}

function section(title: string, body: string[]): string[] {
  return [`## ${title}`, '', ...body, ''];
}

function subProjects(cas: CASOutput): string[] {
  const parts = cas.children ?? [];
  const model = architectureModelOf(cas);
  const rows = model.containers.map(container => {
    const part = parts.find(held => held.system.name === container.name) ?? cas;
    return [
      container.name,
      container.root,
      container.owner,
      container.system,
      [...(part.system.catalog?.depends_on ?? [])].sort().join(', '),
      part.nodes.length,
      (part.entry_points ?? []).length,
      (part.capabilities ?? []).length,
      (part.flows ?? []).length,
    ];
  });
  return table(['name', 'root', 'owner', 'system', 'depends on', 'nodes', 'entry points', 'capabilities', 'flows'], rows);
}

function capabilities(cas: CASOutput): string[] {
  return table(
    ['name', 'category', 'operations', 'description'],
    (cas.capabilities ?? []).map(held => [held.name, held.category, (held.operations ?? []).length, held.description]),
  );
}

function flows(cas: CASOutput): string[] {
  return table(
    ['name', 'standing', 'steps', 'entities'],
    (cas.flows ?? []).map(held => [held.name, held.standing, held.steps.length, [...held.entities].sort().join(', ')]),
  );
}

function entities(cas: CASOutput): string[] {
  return table(
    ['name', 'fields', 'relations'],
    (cas.entities ?? []).map(held => [
      held.name,
      (held.fields ?? []).map(field => field.name).sort().join(', '),
      (held.relations ?? []).map(relation => relation.target_name).sort().join(', '),
    ]),
  );
}

function seams(cas: CASOutput): string[] {
  const model = architectureModelOf(cas);
  const named = new Map([...model.containers, ...model.externals].map(held => [held.key, held.name]));
  return table(
    ['source', 'target', 'modality', 'contract'],
    model.relations.map(relation => [named.get(relation.from), named.get(relation.to), relation.modality, relation.label]),
  );
}

function linkCoverage(cas: CASOutput): string[] {
  return table(
    ['sub-project', 'detected', 'linked', 'unlinked'],
    (cas.communication_seams?.link_coverage ?? []).map(held => [held.sub_project, held.detected, held.linked, held.unlinked_count]),
  );
}

export function analysisToMarkdown(cas: CASOutput): string {
  const lines = [
    `# ${cell(cas.system.name)}`,
    '',
    ...section('Sub-projects', subProjects(cas)),
    ...section('Capabilities', capabilities(cas)),
    ...section('Flows', flows(cas)),
    ...section('Entities', entities(cas)),
    ...section('Seams', seams(cas)),
    ...section('Link coverage', linkCoverage(cas)),
  ];
  return `${lines.join('\n').trimEnd()}\n`;
}
