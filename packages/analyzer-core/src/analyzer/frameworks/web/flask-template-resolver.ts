import { generateNodeId } from '../../../types/cas.types';

export interface FlaskTemplateIdentity {
  name: string;
  filePath: string;
}

export function flaskTemplateLogicalName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const marker = '/templates/';
  const index = normalized.lastIndexOf(marker);
  if (index >= 0) return normalized.slice(index + marker.length);
  return normalized.startsWith('templates/') ? normalized.slice('templates/'.length) : normalized.split('/').pop() || normalized;
}

export function flaskTemplateNodeId(template: FlaskTemplateIdentity): string {
  return generateNodeId('template', template.filePath, template.name);
}

export function resolveFlaskTemplate(name: string, sourceFile: string, templates: FlaskTemplateIdentity[]): FlaskTemplateIdentity | undefined {
  const candidates = templates.filter(template => template.name === name);
  if (candidates.length === 1) return candidates[0];
  const ranked = candidates.map(candidate => ({ candidate, score: commonPrefix(candidate.filePath, sourceFile) }))
    .sort((left, right) => right.score - left.score || left.candidate.filePath.localeCompare(right.candidate.filePath));
  return ranked[0] && (!ranked[1] || ranked[0].score > ranked[1].score) ? ranked[0].candidate : undefined;
}

export function flaskTemplateReferenceNodeId(sourceFile: string, name: string): string {
  return generateNodeId('template_reference', sourceFile, name);
}

function commonPrefix(left: string, right: string): number {
  const a = left.replace(/\\/g, '/').split('/');
  const b = right.replace(/\\/g, '/').split('/');
  let count = 0;
  while (count < a.length && count < b.length && a[count] === b[count]) count++;
  return count;
}
