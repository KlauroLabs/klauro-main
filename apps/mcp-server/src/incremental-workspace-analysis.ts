import { createHash } from 'node:crypto';
import {
  buildCrossCodebaseSystemGraph,
  type CrossCodebaseInput,
  type CrossCodebaseSystemGraph
} from './cross-codebase-analysis';

export interface WorkspaceAnalysisLocality {
  strategy: 'unchanged-workspace' | 'changed-member-recomposition' | 'initial-composition';
  memberCount: number;
  changedMembers: string[];
  reusedMembers: string[];
  reuseRatio: number;
}

export type IncrementalCrossCodebaseSystemGraph = CrossCodebaseSystemGraph & {
  incremental_locality: WorkspaceAnalysisLocality;
};

interface IncrementalWorkspaceAnalysisInput {
  name: string;
  repositories: CrossCodebaseInput[];
  previous?: CrossCodebaseSystemGraph | null;
  id?: string;
  generatedAt?: string;
}

export function buildIncrementalCrossCodebaseSystemGraph(
  input: IncrementalWorkspaceAnalysisInput
): IncrementalCrossCodebaseSystemGraph {
  const locality = workspaceAnalysisLocality(input.previous, input.repositories);
  if (input.previous && locality.strategy === 'unchanged-workspace') {
    return { ...input.previous, incremental_locality: locality };
  }
  const identities = repositoryIdentities(input.repositories);
  const graph = buildCrossCodebaseSystemGraph(input.name, input.repositories, {
    id: input.id,
    generatedAt: input.generatedAt
  });
  stampRepositoryIdentities(graph, identities);
  return { ...graph, incremental_locality: locality };
}

export function workspaceAnalysisLocality(
  previous: CrossCodebaseSystemGraph | null | undefined,
  repositories: CrossCodebaseInput[]
): WorkspaceAnalysisLocality {
  const current = new Map(repositories.map(repository => [
    normalizedRepositoryPath(repository.path),
    repositoryIdentity(repository)
  ]));
  if (!previous) {
    return {
      strategy: 'initial-composition',
      memberCount: current.size,
      changedMembers: [...current.keys()].sort(),
      reusedMembers: [],
      reuseRatio: 0
    };
  }

  const prior = new Map(previous.inputs.map(item => [
    normalizedRepositoryPath(item.repo_path),
    item.cas_analysis_id || ''
  ]));
  const memberPaths = [...new Set([...prior.keys(), ...current.keys()])].sort();
  const reusedMembers = memberPaths.filter(member =>
    prior.has(member) && current.has(member) && prior.get(member) === current.get(member)
  );
  const reusedMemberSet = new Set(reusedMembers);
  const changedMembers = memberPaths.filter(member => !reusedMemberSet.has(member));

  return {
    strategy: changedMembers.length === 0 ? 'unchanged-workspace' : 'changed-member-recomposition',
    memberCount: current.size,
    changedMembers,
    reusedMembers,
    reuseRatio: current.size > 0
      ? Math.round((reusedMembers.length / current.size) * 10_000) / 10_000
      : 0
  };
}

function repositoryIdentity(repository: CrossCodebaseInput): string {
  const analysisId = String(repository.cas.analysis_id || '').trim();
  if (analysisId) return analysisId;
  const hash = createHash('sha256').update(repository.cas.analysis_timestamp || '');
  for (const collection of [
    repository.cas.nodes,
    repository.cas.edges,
    repository.cas.entry_points || [],
    repository.cas.exit_points || []
  ]) {
    for (const item of collection) hash.update(JSON.stringify(item));
  }
  return hash.digest('hex');
}

function normalizedRepositoryPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/$/, '');
}

function stampRepositoryIdentities(
  graph: CrossCodebaseSystemGraph,
  identities: Map<string, string>
): void {
  for (const input of graph.inputs) {
    input.cas_analysis_id = identities.get(normalizedRepositoryPath(input.repo_path));
  }
}

function repositoryIdentities(repositories: CrossCodebaseInput[]): Map<string, string> {
  return new Map(repositories.map(repository => [
    normalizedRepositoryPath(repository.path),
    repositoryIdentity(repository)
  ]));
}
