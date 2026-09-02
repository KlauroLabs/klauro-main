import type { CASEntryPoint, CASExitPoint } from '../../types/cas.types';

export const endpointParts = (value: unknown): string[] => String(value || '').toLowerCase().split(/[/?#]+/)
  .map(part => part.replace(/^:+/, '').replace(/[{}]/g, ''))
  .filter(part => part && !/^(?:param|id|[a-z]+id)$/.test(part));

export function endpointSignature(method: unknown, endpoint: unknown, entities: readonly string[]): string | undefined {
  const parts = endpointParts(endpoint);
  if (!method || parts.length === 0) return undefined;
  return `${String(method).toUpperCase()}|${parts.join('/')}|${[...entities].sort().join(',')}`;
}

export function isTransportScaffoldingExit(exit: CASExitPoint): boolean {
  if (exit.type !== 'sdk') return false;
  const name = String(exit.name || '');
  return /(?:Request\(\)\.Context|Response\(\)\.Header|NewHTTPError)/.test(name);
}

export function semanticActions(value: unknown): string[] {
  const tokens = String(value || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z]+/);
  const actions = new Set<string>();
  if (tokens.some(token => /^(?:add|create|publish|register|submit)$/.test(token))) actions.add('create');
  if (tokens.some(token => /^(?:browse|fetch|filter|find|get|list|read|search|show|view)$/.test(token))) actions.add('read');
  if (tokens.some(token => /^(?:change|edit|manage|maintain|track|update)$/.test(token))) actions.add('update');
  if (tokens.some(token => /^(?:close|delete|remove|unfavorite|unfollow)$/.test(token))) actions.add('delete');
  if (tokens.some(token => /^(?:auth|authenticate|login|signin)$/.test(token))) actions.add('authenticate');
  if (tokens.includes('accept')) actions.add('accept');
  if (tokens.includes('decline')) actions.add('decline');
  if (tokens.includes('test')) actions.add('test');
  if (tokens.some(token => /^(?:execute|run)$/.test(token))) actions.add('run');
  return [...actions];
}

const genericSubjectTokens = new Set([
  'action', 'add', 'application', 'browse', 'change', 'close', 'create', 'delete', 'edit', 'entity', 'event',
  'fetch', 'filter', 'find', 'default', 'detail', 'get', 'handle', 'handler', 'list', 'loading', 'loading2', 'open', 'prevent', 'set', 'manage', 'operation', 'post', 'put', 'read', 'remove',
  'param', 'route', 'search', 'show', 'statu', 'status', 'system', 'track', 'update', 'user', 'view',
]);

export function semanticSubjects(value: unknown): string[] {
  return [...new Set(String(value || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/)
    .map(token => token.replace(/^entity_/, '').replace(/ies$/, 'y').replace(/s$/, ''))
    .filter(token => token.length >= 3 && !genericSubjectTokens.has(token)))];
}

export function declarationOperationSemantics(entry: CASEntryPoint | undefined): { actions: string[]; subjects: string[] } | undefined {
  if (entry?.metadata?.execution_role !== 'declaration') return undefined;
  const metadata = entry.metadata as Record<string, unknown>;
  const service = String(metadata.service || (Array.isArray(metadata.tags) ? metadata.tags[0] : '') || '').trim();
  const rawOperation = String(metadata.rpc || metadata.operationId || entry.handler?.method_name || entry.name || '').trim();
  const operation = rawOperation.replace(new RegExp('^' + service.replace(/[^a-z0-9]/gi, '') + '[_-]?', 'i'), '');
  const words = operation.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const joined = words.join('');
  let action = '';
  let consumed = 0;
  if (/^(?:signin|signout|login|logout|authenticate|refreshtoken)/.test(joined)) {
    action = 'authenticate';
    consumed = /^sign(?:in|out)/.test(joined) ? 2 : 1;
  } else if (/^(?:batchget|batchlist)/.test(joined)) {
    action = 'read';
    consumed = 2;
  } else {
    const first = words[0] || '';
    if (/^(?:add|create|publish|register|submit)$/.test(first)) action = 'create';
    else if (/^(?:browse|fetch|filter|find|get|list|read|search|show|view)$/.test(first)) action = 'read';
    else if (/^(?:change|edit|manage|maintain|set|track|update|upsert)$/.test(first)) action = 'update';
    else if (/^(?:close|delete|remove|unfavorite|unfollow)$/.test(first)) action = 'delete';
    else if (/^(?:accept|decline|test|execute|run)$/.test(first)) action = first === 'execute' ? 'run' : first;
    consumed = action ? 1 : 0;
  }
  const exactSubjects = words.slice(consumed)
    .filter(word => !/^(?:api|rpc|request|response|service)$/.test(word))
    .map(word => word.replace(/ies$/, 'y').replace(/s$/, ''));
  const serviceSubjects = service.replace(/service$/i, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return { actions: action ? [action] : semanticActions(operation), subjects: [...new Set(exactSubjects.length > 0 ? exactSubjects : serviceSubjects)] };
}
