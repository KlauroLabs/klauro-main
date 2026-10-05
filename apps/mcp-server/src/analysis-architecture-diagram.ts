import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { architectureModelOf, type Relation } from './analysis-architecture-model';

const INDENT = '  ';
const ASYNC_MODALITY = 'async';

function quoted(text: string): string {
  return `"${text.replace(/"/g, '#quot;')}"`;
}

function dslQuoted(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function mermaidArrow(relation: Relation): string {
  const label = relation.label === '' ? '' : `|${quoted(relation.label)}|`;
  return relation.modality === ASYNC_MODALITY ? `-.->${label}` : `-->${label}`;
}

export function architectureToMermaid(cas: CASOutput): string {
  const model = architectureModelOf(cas);
  const lines = ['flowchart LR', `${INDENT}subgraph system[${quoted(model.system)}]`];
  for (const container of model.containers) {
    lines.push(`${INDENT}${INDENT}${container.key}[${quoted(container.name)}]`);
  }
  lines.push(`${INDENT}end`);
  for (const external of model.externals) {
    lines.push(`${INDENT}${external.key}[(${quoted(external.name)})]`);
  }
  for (const relation of model.relations) {
    lines.push(`${INDENT}${relation.from} ${mermaidArrow(relation)} ${relation.to}`);
  }
  return `${lines.join('\n')}\n`;
}

export function architectureToModelAsCode(cas: CASOutput): string {
  const model = architectureModelOf(cas);
  const lines = [`workspace ${dslQuoted(model.system)} {`, `${INDENT}model {`];
  lines.push(`${INDENT}${INDENT}system = softwareSystem ${dslQuoted(model.system)} {`);
  for (const container of model.containers) {
    lines.push(`${INDENT.repeat(3)}${container.key} = container ${dslQuoted(container.name)} "" ${dslQuoted(container.root)}`);
  }
  lines.push(`${INDENT}${INDENT}}`);
  for (const external of model.externals) {
    lines.push(`${INDENT}${INDENT}${external.key} = softwareSystem ${dslQuoted(external.name)} "" "External"`);
  }
  for (const relation of model.relations) {
    lines.push(`${INDENT}${INDENT}${relation.from} -> ${relation.to} ${dslQuoted(relation.label)} ${dslQuoted(relation.modality)}`);
  }
  lines.push(`${INDENT}}`, `${INDENT}views {`);
  lines.push(`${INDENT}${INDENT}container system {`, `${INDENT.repeat(3)}include *`, `${INDENT.repeat(3)}autolayout lr`);
  lines.push(`${INDENT}${INDENT}}`, `${INDENT}}`, '}');
  return `${lines.join('\n')}\n`;
}
