import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { architectureModelOf, type Container, type Relation } from './analysis-architecture-model';

const INDENT = '  ';
const ASYNC_MODALITY = 'async';

const LINE_BREAKS_AND_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
const MERMAID_ENTITIES: Record<string, string> = {
  '#': '#35;',
  '"': '#quot;',
  '<': '#lt;',
  '>': '#gt;',
  '&': '#amp;',
  '`': '#96;',
};

function singleLine(text: string): string {
  return text.replace(LINE_BREAKS_AND_CONTROLS, ' ').trim();
}

function quoted(text: string): string {
  return `"${singleLine(text).replace(/[#"<>&`]/g, mark => MERMAID_ENTITIES[mark])}"`;
}

function dslQuoted(text: string): string {
  return `"${singleLine(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function containerDetails(container: Container): string {
  const details = [
    ...(container.owner === undefined ? [] : [`owner: ${container.owner}`]),
    ...(container.system === undefined ? [] : [`system: ${container.system}`]),
  ];
  return details.length === 0 ? container.name : `${container.name} (${details.join('; ')})`;
}

function containerProperties(container: Container): string[] {
  const properties = [
    ...(container.owner === undefined ? [] : [`${dslQuoted('owner')} ${dslQuoted(container.owner)}`]),
    ...(container.system === undefined ? [] : [`${dslQuoted('system')} ${dslQuoted(container.system)}`]),
  ];
  if (properties.length === 0) return [];
  return [`${INDENT.repeat(4)}properties {`, ...properties.map(line => `${INDENT.repeat(5)}${line}`), `${INDENT.repeat(4)}}`];
}

function mermaidArrow(relation: Relation): string {
  const label = relation.label === '' ? '' : `|${quoted(relation.label)}|`;
  return relation.modality === ASYNC_MODALITY ? `-.->${label}` : `-->${label}`;
}

export function architectureToMermaid(cas: CASOutput): string {
  const model = architectureModelOf(cas);
  const lines = ['flowchart LR', `${INDENT}subgraph system[${quoted(model.system)}]`];
  for (const container of model.containers) {
    lines.push(`${INDENT}${INDENT}${container.key}[${quoted(containerDetails(container))}]`);
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
    const properties = containerProperties(container);
    const head = `${INDENT.repeat(3)}${container.key} = container ${dslQuoted(container.name)} "" ${dslQuoted(container.root)}`;
    lines.push(...(properties.length === 0 ? [head] : [`${head} {`, ...properties, `${INDENT.repeat(3)}}`]));
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
