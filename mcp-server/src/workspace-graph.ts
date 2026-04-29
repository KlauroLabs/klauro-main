import type { CASCrossRepositoryLink, CASNode, CASOutput } from '../../backend/src/types/cas.types';
import { buildCrossRepositoryLinks } from './product';

export type WorkspaceLinkDecisionStatus = 'unreviewed' | 'verified' | 'rejected';

export interface WorkspaceLinkDecision {
  link_id: string;
  status: WorkspaceLinkDecisionStatus;
  reason?: string;
  actor?: string;
  decided_at: string;
}

export interface WorkspaceGraphRepository {
  id: string;
  name: string;
  path: string;
  system_type: string;
  languages: string[];
  frameworks: string[];
  scale: {
    nodes: number;
    edges: number;
    entry_points: number;
    exit_points: number;
    call_chains: number;
    data_entities: number;
  };
  contracts: {
    provides_http: number;
    consumes_http: number;
    provides_messages: number;
    consumes_messages: number;
    databases: string[];
    packages: string[];
  };
}

export interface WorkspaceGraphLink {
  id: string;
  type: CASCrossRepositoryLink['type'];
  source_repository?: string;
  target_repository?: string;
  source_nodes: WorkspaceGraphNodeRef[];
  target_nodes: WorkspaceGraphNodeRef[];
  connection: CASCrossRepositoryLink['connection'];
  confidence: number;
  evidence_count: number;
  detected_verified: boolean;
  decision: WorkspaceLinkDecision;
}

export interface WorkspaceGraphNodeRef {
  id: string;
  name?: string;
  type?: string;
  file?: string;
  line?: number;
}

export interface WorkspaceGraph {
  id: string;
  name: string;
  generated_at: string;
  repository_count: number;
  repositories: WorkspaceGraphRepository[];
  links: WorkspaceGraphLink[];
  summary: Record<string, number>;
  certainty: {
    confirmed: number;
    likely: number;
    possible: number;
    conflicts: number;
  };
  conflicts: Array<{
    id: string;
    link_ids: string[];
    reason: string;
  }>;
  decisions: WorkspaceLinkDecision[];
}

export function workspaceGraphId(name: string): string {
  return slugify(name || 'workspace') || 'workspace';
}

export function buildWorkspaceGraph(
  name: string,
  repositories: Array<{ path: string; name: string; cas: CASOutput }>,
  existing?: WorkspaceGraph | null
): WorkspaceGraph {
  const crossRepo = buildCrossRepositoryLinks(repositories);
  const existingDecisions = new Map((existing?.decisions || []).map(decision => [decision.link_id, decision]));
  const generatedAt = new Date().toISOString();
  const links = crossRepo.links.map(link => {
    const decision = existingDecisions.get(link.id) || {
      link_id: link.id,
      status: 'unreviewed' as const,
      decided_at: generatedAt,
    };
    return summarizeLink(link, repositories, decision);
  });

  return {
    id: existing?.id || workspaceGraphId(name),
    name,
    generated_at: generatedAt,
    repository_count: repositories.length,
    repositories: repositories.map(repository => summarizeRepository(repository)),
    links,
    summary: crossRepo.summary,
    certainty: crossRepo.certainty,
    conflicts: crossRepo.conflicts,
    decisions: links.map(link => link.decision),
  };
}

export function applyWorkspaceGraphDecision(
  graph: WorkspaceGraph,
  linkId: string,
  status: WorkspaceLinkDecisionStatus,
  options: { reason?: string; actor?: string } = {}
): WorkspaceGraph {
  const link = graph.links.find(candidate => candidate.id === linkId);
  if (!link) throw new Error(`Workspace graph link not found: ${linkId}`);

  const decision: WorkspaceLinkDecision = {
    link_id: linkId,
    status,
    reason: options.reason,
    actor: options.actor,
    decided_at: new Date().toISOString(),
  };
  const decisions = new Map(graph.decisions.map(existing => [existing.link_id, existing]));
  decisions.set(linkId, decision);

  return {
    ...graph,
    generated_at: new Date().toISOString(),
    links: graph.links.map(candidate => candidate.id === linkId ? { ...candidate, decision } : candidate),
    decisions: Array.from(decisions.values()).sort((left, right) => left.link_id.localeCompare(right.link_id)),
  };
}

export function summarizeWorkspaceGraph(graph: WorkspaceGraph) {
  const decisions = graph.decisions.reduce<Record<string, number>>((counts, decision) => {
    counts[decision.status] = (counts[decision.status] || 0) + 1;
    return counts;
  }, {});
  const repositoriesWithLinks = new Set<string>();
  for (const link of graph.links) {
    if (link.source_repository) repositoriesWithLinks.add(link.source_repository);
    if (link.target_repository) repositoriesWithLinks.add(link.target_repository);
  }

  return {
    id: graph.id,
    name: graph.name,
    generated_at: graph.generated_at,
    repository_count: graph.repository_count,
    link_count: graph.links.length,
    linked_repositories: repositoriesWithLinks.size,
    summary: graph.summary,
    certainty: graph.certainty,
    decisions,
    conflicts: graph.conflicts.length,
  };
}

function summarizeRepository(repository: { path: string; name: string; cas: CASOutput }): WorkspaceGraphRepository {
  const cas = repository.cas;
  return {
    id: repositoryId(repository.path),
    name: repository.name,
    path: repository.path,
    system_type: cas.system?.type || 'application',
    languages: (cas.system?.technologies?.languages || []).map(language => language.name).filter(Boolean),
    frameworks: (cas.system?.technologies?.frameworks || []).map(framework => framework.name).filter(Boolean),
    scale: {
      nodes: cas.nodes?.length || 0,
      edges: cas.edges?.length || 0,
      entry_points: cas.entry_points?.length || 0,
      exit_points: cas.exit_points?.length || 0,
      call_chains: cas.call_chains?.length || 0,
      data_entities: cas.data_entities?.length || cas.database_schema?.entities?.length || 0,
    },
    contracts: {
      provides_http: (cas.entry_points || []).filter(entry => entry.type === 'http' || entry.type === 'route').length,
      consumes_http: (cas.exit_points || []).filter(exitPoint => exitPoint.type === 'api' || exitPoint.type === 'webhook').length,
      provides_messages: (cas.entry_points || []).filter(entry => entry.type === 'message' || entry.type === 'event').length,
      consumes_messages: (cas.exit_points || []).filter(exitPoint => exitPoint.type === 'message' || exitPoint.type === 'event').length,
      databases: databaseNames(cas),
      packages: (cas.dependencies?.packages || []).filter(pkg => pkg.direct).map(pkg => pkg.name).slice(0, 50),
    },
  };
}

function summarizeLink(
  link: CASCrossRepositoryLink,
  repositories: Array<{ path: string; name: string; cas: CASOutput }>,
  decision: WorkspaceLinkDecision
): WorkspaceGraphLink {
  const sourceRepository = repositories.find(repository => repository.path === link.source_repository?.path);
  const targetRepository = repositories.find(repository => repository.path === link.target_repository?.path);
  return {
    id: link.id,
    type: link.type,
    source_repository: link.source_repository?.path,
    target_repository: link.target_repository?.path,
    source_nodes: resolveNodes(sourceRepository?.cas, link.source_repository?.node_ids || []),
    target_nodes: resolveNodes(targetRepository?.cas, link.target_repository?.node_ids || []),
    connection: link.connection,
    confidence: link.metadata?.confidence || 0,
    evidence_count: link.metadata?.evidence?.length || 0,
    detected_verified: Boolean(link.metadata?.verified),
    decision,
  };
}

function resolveNodes(cas: CASOutput | undefined, ids: string[]): WorkspaceGraphNodeRef[] {
  if (!cas) return ids.map(id => ({ id }));
  return ids.map(id => {
    const node = cas.nodes.find(candidate => candidate.id === id);
    return node ? nodeRef(node) : { id };
  });
}

function nodeRef(node: CASNode): WorkspaceGraphNodeRef {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    file: node.source?.file,
    line: node.source?.line,
  };
}

function databaseNames(cas: CASOutput): string[] {
  return [
    ...(cas.system?.technologies?.databases || []),
    ...(cas.database_schema?.entities || []).map(entity => entity.name),
    ...(cas.data_entities || []).map(entity => entity.name),
    ...(cas.exit_points || []).filter(exitPoint => exitPoint.type === 'database').map(exitPoint => exitPoint.target?.resource || exitPoint.name),
  ].filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index).slice(0, 50);
}

function repositoryId(repositoryPath: string): string {
  return slugify(repositoryPath.split('/').filter(Boolean).slice(-2).join('-')) || slugify(repositoryPath) || 'repository';
}

function slugify(input: string): string {
  return input
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .substring(0, 80);
}
