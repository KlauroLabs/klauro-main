import { maskCStyleComments } from './source-comment-mask';
import type { CASEdge, CASNode, CASNodeBuilder } from '../../types/cas.types';

export interface InMemoryRecordField {
  name: string;
  type: string;
}

export interface InMemoryRecordCollection {
  variable: string;
  name: string;
  line: number;
  fields: InMemoryRecordField[];
}

export function extractInMemoryRecordCollections(content: string): InMemoryRecordCollection[] {
  const source = maskCStyleComments(content);
  const collections: InMemoryRecordCollection[] = [];
  const declaration = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:exports\.\1\s*=\s*)?\[\s*\]/g;
  let match: RegExpExecArray | null;
  while ((match = declaration.exec(source)) !== null) {
    const variable = match[1];
    if (!isExportedCollection(source, variable)) continue;
    const fields = recordFieldsFromPushes(source, variable);
    if (fields.length === 0) continue;
    collections.push({
      variable,
      name: recordName(variable),
      line: source.slice(0, match.index).split('\n').length,
      fields,
    });
  }
  return collections;
}

export function appendInMemoryRecordCollectionNodes(
  content: string,
  filePath: string,
  fileId: string,
  nodes: CASNode[],
  edges: CASEdge[],
  createNodeBuilder: (id: string, name: string, type: string) => CASNodeBuilder,
  createEdge: (id: string, source: string, target: string, type: string) => CASEdge
): void {
  for (const record of extractInMemoryRecordCollections(content)) {
    const nodeId = `model_${filePath.replace(/[^a-zA-Z0-9]/g, '_')}_${record.variable.replace(/[^a-zA-Z0-9]/g, '_')}`;
    if (nodes.some(node => node.id === nodeId)) continue;
    nodes.push(createNodeBuilder(nodeId, record.name, 'model')
      .withLevel(3, 'Data shape')
      .withCategory('structures', ['domain-shape', 'in-memory-store'])
      .withSource({ file: filePath, line: record.line, end_line: record.line })
      .withMetadata({
        attributes: {
          fields: record.fields,
          storage_scope: 'process',
          record_sequence: record.variable,
        },
      })
      .build());
    edges.push(createEdge(`${fileId}_contains_${nodeId}`, fileId, nodeId, 'contains'));
  }
}

function isExportedCollection(source: string, variable: string): boolean {
  const escaped = escapeRegExp(variable);
  return new RegExp(`\\bexports\\.${escaped}\\s*=|\\bmodule\\.exports\\.${escaped}\\s*=`).test(source);
}

function recordFieldsFromPushes(source: string, variable: string): InMemoryRecordField[] {
  const fields = new Map<string, string>();
  const call = new RegExp(`\\b${escapeRegExp(variable)}\\s*\\.\\s*push\\s*\\(\\s*\\{`, 'g');
  let match: RegExpExecArray | null;
  while ((match = call.exec(source)) !== null) {
    const openingBrace = source.indexOf('{', match.index);
    const object = balancedObject(source, openingBrace);
    if (!object) continue;
    for (const field of objectFields(object)) {
      const existing = fields.get(field.name);
      if (!existing || existing === 'unknown') fields.set(field.name, field.type);
    }
    call.lastIndex = openingBrace + object.length;
  }
  return [...fields].sort(([left], [right]) => left.localeCompare(right)).map(([name, type]) => ({ name, type }));
}

function balancedObject(source: string, start: number): string | undefined {
  if (start < 0 || source[start] !== '{') return undefined;
  let depth = 0;
  let quote: string | undefined;
  for (let index = start; index < source.length; index++) {
    const character = source[index];
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    if (character !== '}') continue;
    depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  return undefined;
}

function objectFields(object: string): InMemoryRecordField[] {
  return splitTopLevel(object.slice(1, -1)).flatMap(segment => {
    const property = segment.match(/^\s*(?:([A-Za-z_$][\w$]*)|['"]([^'"]+)['"])\s*:\s*([\s\S]*)$/);
    if (!property) return [];
    const name = property[1] || property[2];
    return [{ name, type: valueType(property[3].trim()) }];
  });
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | undefined;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{' || character === '[' || character === '(') depth += 1;
    else if (character === '}' || character === ']' || character === ')') depth -= 1;
    else if (character === ',' && depth === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

function valueType(value: string): string {
  if (/^['"`]/.test(value)) return 'string';
  if (/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?\b/.test(value)) return 'number';
  if (/^(?:true|false)\b/.test(value)) return 'boolean';
  if (/^\[/.test(value)) return 'array';
  if (/^\{/.test(value)) return 'object';
  return 'unknown';
}

function recordName(variable: string): string {
  const singular = variable
    .replace(/ies$/i, 'y')
    .replace(/(?:ses|xes|zes|ches|shes)$/i, ending => ending.slice(0, -2))
    .replace(/(?<!s)s$/i, '');
  return singular
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(word => `${word[0].toUpperCase()}${word.slice(1)}`)
    .join('');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
