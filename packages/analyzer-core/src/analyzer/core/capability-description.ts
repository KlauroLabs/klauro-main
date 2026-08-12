import { CASDataEntity, CASEntryPoint, SystemCapability } from '../../types/cas.types';

export interface DescribableOperation {
  action: string;
  entry_point_type?: string;
  path_or_command?: string;
}

export function joinHumanList(values: string[]): string {
  const items = values.map(value => value.trim()).filter(Boolean);
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

export function relativizeRepoPath(input: string, projectRoot: string | undefined): string {
  const normalized = String(input || '').replace(/\\/g, '/');
  const root = (projectRoot || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (root && normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
  if (/^(?:[a-zA-Z]:)?\//.test(normalized)) {
    return normalized.split('/').filter(Boolean).slice(-2).join('/');
  }
  return normalized;
}

export function capabilityVerbClause(actions: string[]): string {
  const set = new Set(actions);
  const verbs: string[] = [];
  if (set.has('create')) verbs.push('creates');
  if (set.has('read') || set.has('query')) verbs.push('reads');
  if (set.has('update')) verbs.push('updates');
  if (set.has('delete')) verbs.push('deletes');
  if (verbs.length === 0) {
    if (set.has('analyze')) return 'analyzes';
    if (set.has('validate')) return 'validates';
    if (set.has('generate')) return 'generates';
    if (set.has('send')) return 'sends';
    if (set.has('process')) return 'processes';
    if (set.has('transform')) return 'transforms';
    return '';
  }
  return joinHumanList(verbs);
}

export function entryPointSurfaceLabel(type: string, count: number): string {
  const plural = count > 1;
  switch (type) {
    case 'http': case 'route': return plural ? 'HTTP routes' : 'HTTP route';
    case 'cli': return plural ? 'CLI commands' : 'CLI command';
    case 'event': case 'message': return plural ? 'event handlers' : 'event handler';
    case 'schedule': return plural ? 'scheduled jobs' : 'scheduled job';
    case 'websocket': return plural ? 'WebSocket handlers' : 'WebSocket handler';
    case 'graphql': return plural ? 'GraphQL operations' : 'GraphQL operation';
    case 'page': return plural ? 'pages/screens' : 'page/screen';
    default: return plural ? 'operations' : 'operation';
  }
}

export function capabilityInteractionPhrase(entryTypes: string[]): string {
  const normalized = new Set(entryTypes.map(type => type.toLowerCase()).filter(Boolean));
  const phrases: string[] = [];
  if (normalized.has('http') || normalized.has('route')) phrases.push('from product request flows');
  if (normalized.has('page')) phrases.push('from application screens');
  if (normalized.has('cli')) phrases.push('from command-line tasks');
  if (normalized.has('event') || normalized.has('message') || normalized.has('queue')) phrases.push('from asynchronous messages');
  if (normalized.has('schedule') || normalized.has('scheduled') || normalized.has('cron')) phrases.push('from scheduled jobs');
  if (phrases.length === 0) return '';
  return ` ${joinHumanList(phrases.slice(0, 3))}`;
}

export function lastResortCapabilityDescription(name: string): string {
  const bare = stripDisambiguator(name);
  return `${bare} is a structural capability grouping identified in the codebase; no operations or related data entities have been resolved for it.`;
}

function stripDisambiguator(label: string): string {
  return label.replace(/\s*\([^)]*\)\s*$/, '').trim() || label;
}

function subjectOf(label: string): string {
  return label.replace(/\s+(Management|Capability|Workflow|Reporting|Analysis|Generation|Settlement|Rebalancing|Authentication)$/i, '').trim() || label;
}

function distinctActions(operations: DescribableOperation[]): string[] {
  return Array.from(new Set(
    operations.map(operation => operation.action.toLowerCase())
      .filter(action => action && action !== 'coordinate' && action !== 'action')
  ));
}

function surfaceCounts(operations: DescribableOperation[]): Map<string, number> {
  const byType = new Map<string, number>();
  for (const operation of operations) {
    const type = (String(operation.entry_point_type || '').toLowerCase() || 'operation').replace(/^route$/, 'http');
    byType.set(type, (byType.get(type) || 0) + 1);
  }
  return byType;
}

function surfaceLabels(byType: Map<string, number>): string[] {
  return [...byType.entries()].map(([type, count]) => `${count} ${entryPointSurfaceLabel(type, count)}`);
}

function unresolvedDescription(label: string, subjectLower: string): string {
  return `${label} groups ${subjectLower}-related nodes in the relationship graph; no entry points or data entities were resolved for it, so its runtime behavior is unverified.`;
}

function assemble(label: string, dataClause: string, surfaceClause: string, pathClause: string, subjectLower: string): string {
  if (!dataClause && !surfaceClause) return unresolvedDescription(label, subjectLower);
  return `${label}${dataClause}${surfaceClause}${pathClause}.`.replace(/\s+/g, ' ').trim();
}

function dataClauseFor(entityNames: string[], verbClause: string, subjectLower: string): string {
  if (entityNames.length) return ` ${verbClause || 'manages'} ${entityNames.join(', ')}`;
  return verbClause ? ` ${verbClause} ${subjectLower} records` : '';
}

export function generateCapabilityDescription(
  name: string,
  operations: DescribableOperation[],
  entities: Array<{ name: string }> = [],
  entryPoints: CASEntryPoint[] = [],
  projectRoot?: string,
): string {
  const label = stripDisambiguator(name);
  const subjectLower = subjectOf(label).toLowerCase();
  const verbClause = capabilityVerbClause(distinctActions(operations));
  const entityNames = Array.from(new Set(entities.map(entity => entity.name).filter(Boolean))).slice(0, 4);
  const surfaceParts = surfaceLabels(surfaceCounts(operations));

  const samplePaths: string[] = [];
  for (const entryPoint of entryPoints) {
    const file = entryPoint.handler?.file;
    if (!file) continue;
    const relative = relativizeRepoPath(file, projectRoot);
    if (relative && !samplePaths.includes(relative) && samplePaths.length < 2) samplePaths.push(relative);
  }

  return assemble(
    label,
    dataClauseFor(entityNames, verbClause, subjectLower),
    surfaceParts.length ? ` through ${joinHumanList(surfaceParts)}` : '',
    samplePaths.length ? ` (${samplePaths.join(', ')})` : '',
    subjectLower,
  );
}

export function generateTerminalCapabilityDescription(
  label: string,
  entities: CASDataEntity[],
  operations: NonNullable<SystemCapability['operations']>,
  projectRoot?: string,
): string {
  const bare = stripDisambiguator(label);
  const subjectLower = subjectOf(bare).toLowerCase();
  const verbClause = capabilityVerbClause(distinctActions(operations));
  const entityNames = Array.from(new Set(entities.map(entity => entity.name).filter(Boolean))).slice(0, 4);

  const byType = surfaceCounts(operations);
  const samplePaths: string[] = [];
  for (const operation of operations) {
    const pathOrCommand = relativizeRepoPath(String(operation.path_or_command || '').trim(), projectRoot);
    if (pathOrCommand && !pathOrCommand.startsWith('entry_') && samplePaths.length < 2 && !samplePaths.includes(pathOrCommand)) {
      samplePaths.push(pathOrCommand);
    }
  }

  return assemble(
    bare,
    dataClauseFor(entityNames, verbClause, subjectLower),
    byType.size ? ` through ${joinHumanList(surfaceLabels(byType))}` : '',
    samplePaths.length ? ` (e.g. ${samplePaths.join(', ')})` : '',
    subjectLower,
  );
}
