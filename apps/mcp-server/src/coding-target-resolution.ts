import type { CASNode, CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';

export function isExplicitCodingSymbolTarget(target: string): boolean {
  return /^[A-Za-z_$][\w$]*(?:(?:\.|::|#)[A-Za-z_$][\w$]*)*(?:\(\))?$/.test(target.trim());
}

export function exactCodingSymbolTargets(cas: CASOutput, target: string): CASNode[] {
  const symbol = target.replace(/\(\)$/, '').trim().toLowerCase();
  const nodes = cas.nodes.filter(node => node.type !== 'file' && node.type !== 'directory');
  const qualified = nodes.filter(node => node.qualified_name?.toLowerCase() === symbol);
  return qualified.length ? qualified : nodes.filter(node => node.name.toLowerCase() === symbol);
}

export function resolveCodingContextTarget(cas: CASOutput, target: string, searchNodeIds: string[]): CASNode | undefined {
  const exact = cas.nodes.find(node => node.id === target);
  if (exact) return exact;

  const normalizedTarget = normalizeCodingTarget(target);
  const wantsTest = /(^|[^a-z])(tests?|specs?|e2e)([^a-z]|$)/i.test(target);
  const symbolTarget = target.replace(/[()]/g, '').trim().toLowerCase();
  const symbols = cas.nodes.filter(node => node.type !== 'file' && node.type !== 'directory');
  const qualified = rankTargets(symbols.filter(node => node.qualified_name?.toLowerCase() === symbolTarget), wantsTest)[0];
  if (qualified) return qualified;
  const named = rankTargets(symbols.filter(node => node.name.toLowerCase() === symbolTarget), wantsTest)[0];
  if (named) return named;
  const fileMatches = cas.nodes.filter(node => {
    const file = node.source?.file;
    if (!file) return false;
    const normalizedFile = file.replace(/\\/g, '/');
    const basename = normalizedFile.split('/').pop() || normalizedFile;
    const stem = basename.replace(/\.[^.]+$/, '');
    return normalizedFile.endsWith(target.replace(/\\/g, '/')) || (!/[./\\:#()]/.test(target) && normalizeCodingTarget(stem) === normalizedTarget);
  });
  const rankedFileMatch = rankTargets(fileMatches, wantsTest)[0];
  if (rankedFileMatch) return rankedFileMatch;
  if (isExplicitCodingSymbolTarget(target)) return undefined;

  const searchMatches = searchNodeIds
    .map(nodeId => cas.nodes.find(node => node.id === nodeId))
    .filter((node): node is CASNode => Boolean(node));
  return rankTargets(searchMatches, wantsTest)[0];
}

function rankTargets(nodes: CASNode[], wantsTest: boolean): CASNode[] {
  return [...nodes].sort((left, right) =>
    targetScore(right, wantsTest) - targetScore(left, wantsTest) ||
    (left.source?.line || Number.MAX_SAFE_INTEGER) - (right.source?.line || Number.MAX_SAFE_INTEGER)
  );
}

function targetScore(node: CASNode, wantsTest: boolean): number {
  const file = node.source?.file || '';
  const isTest = /(^|\/)(tests?|__tests__|spec|e2e)(\/|$)|\.(test|spec)\.[a-z0-9]+$/i.test(file) ||
    node.category === 'test' || node.type === 'test';
  const ownerTypes = ['class', 'service', 'controller', 'handler', 'gateway', 'resolver', 'repository', 'entity', 'model'];
  let score = ownerTypes.includes(node.type) ? 90 :
    node.type === 'module' ? 80 :
    node.type === 'file' ? 70 :
    node.type === 'function' ? 55 :
    node.type === 'method' ? 45 : 10;
  if ((node.metadata as Record<string, unknown> | undefined)?.exported === true) score += 20;
  score += isTest === wantsTest ? 200 : -300;
  if (['import', 'property', 'variable', 'mock'].includes(node.type)) score -= 150;
  return score;
}

function normalizeCodingTarget(value: string): string {
  return String(value || '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()!
    .replace(/\.[a-z0-9]+$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}
