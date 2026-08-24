import type { CrossCodebaseSystemGraph, SystemInterface } from './cross-codebase-analysis';
import type { AccountStore } from './account-store';

export interface WorkspaceContractQueryOptions {
  limit?: number;
  offset?: number;
  journey_limit?: number;
}

function interfaceSummary(item: SystemInterface) {
  return {
    id: item.id,
    application_id: item.application_id,
    kind: item.kind,
    role: item.role,
    mode: item.mode,
    name: item.name,
    key: item.key,
    protocol: item.protocol,
    method: item.method,
    endpoint: item.endpoint,
    package_name: item.package_name,
    topic: item.topic,
    resource: item.resource,
    refs: item.refs,
    evidence: item.evidence,
  };
}

export function selectWorkspaceCrossRepoContracts(
  graph: CrossCodebaseSystemGraph,
  options: WorkspaceContractQueryOptions = {},
) {
  const limit = Math.min(500, Math.max(1, options.limit || 100));
  const offset = Math.max(0, options.offset || 0);
  const journeyLimit = Math.min(100, Math.max(1, options.journey_limit || 25));
  const interfaces = graph.interfaces.slice(offset, offset + limit);
  const links = graph.links.slice(offset, offset + limit);
  const interfaceById = new Map(graph.interfaces.map(item => [item.id, item]));
  const applicationById = new Map(graph.applications.map(item => [item.id, item]));
  const providedRoles = new Set(['provider', 'publisher', 'shared']);
  const consumedRoles = new Set(['consumer', 'listener', 'shared']);

  return {
    generated_at: graph.generated_at,
    source: 'workspace-cas',
    workspace_id: graph.id,
    workspace_name: graph.name,
    repository_count: graph.codebase_count,
    repositories: graph.codebases.map(codebase => {
      const owned = graph.interfaces.filter(item => item.codebase_id === codebase.id);
      return {
        id: codebase.id,
        name: codebase.name,
        path: codebase.path,
        provides: owned.filter(item => providedRoles.has(item.role)).map(interfaceSummary),
        consumes: owned.filter(item => consumedRoles.has(item.role)).map(interfaceSummary),
      };
    }),
    interfaces: interfaces.map(interfaceSummary),
    links,
    contract_table: links.map(link => {
      const source = interfaceById.get(link.source_interface_id);
      const target = interfaceById.get(link.target_interface_id);
      return {
        link_id: link.id,
        kind: link.kind,
        mode: link.mode,
        consumer_repository: graph.codebases.find(item => item.id === link.source_codebase_id)?.name || link.source_codebase_id,
        consumer_application: applicationById.get(link.source_application_id)?.name || link.source_application_id,
        consumer_interface: source ? interfaceSummary(source) : null,
        provider_repository: graph.codebases.find(item => item.id === link.target_codebase_id)?.name || link.target_codebase_id,
        provider_application: applicationById.get(link.target_application_id)?.name || link.target_application_id,
        provider_interface: target ? interfaceSummary(target) : null,
        confidence: link.confidence,
        evidence_quality: link.evidence_quality,
        evidence: link.evidence,
      };
    }),
    journeys: graph.workspace_workflows.slice(0, journeyLimit),
    unmatched_interfaces: graph.unmatched_interfaces.slice(offset, offset + limit),
    validation: graph.validation,
    gaps: {
      known_unknowns: graph.validation.known_unknowns,
      quality_flags: graph.quality_flags,
      unmatched_interface_count: graph.unmatched_interfaces.length,
    },
    pagination: {
      offset,
      limit,
      interfaces_total: graph.interfaces.length,
      links_total: graph.links.length,
      unmatched_interfaces_total: graph.unmatched_interfaces.length,
      journeys_total: graph.workspace_workflows.length,
      journeys_included: Math.min(journeyLimit, graph.workspace_workflows.length),
      next_offset: offset + limit < Math.max(graph.interfaces.length, graph.links.length, graph.unmatched_interfaces.length)
        ? offset + limit
        : null,
    },
  };
}

export async function workspaceContractsHttpResponse(input: {
  route: string;
  userId: string;
  requestUrl: string;
  accounts: Pick<AccountStore, 'listProjects'>;
  analyses?: {
    load(workspaceId: string): Promise<{ graph: CrossCodebaseSystemGraph } | null>;
    isPending(workspaceId: string): boolean;
    failureReason(workspaceId: string): string | undefined;
  };
}) {
  const match = input.route.match(/^\/api\/workspaces\/([^/]+)\/contracts$/);
  if (!match) return null;
  const workspaceId = decodeURIComponent(match[1]);
  await input.accounts.listProjects(input.userId, workspaceId);
  if (!input.analyses) return { statusCode: 200, body: { status: 'none', workspace_id: workspaceId } };
  const record = await input.analyses.load(workspaceId);
  const pending = input.analyses.isPending(workspaceId);
  const failure = input.analyses.failureReason(workspaceId);
  if (!record) return { statusCode: 200, body: { status: pending ? 'pending' : failure ? 'failed' : 'none', workspace_id: workspaceId, ...(failure && !pending ? { error: failure } : {}) } };
  const params = new URL(input.requestUrl, 'http://localhost').searchParams;
  return {
    statusCode: 200,
    body: {
      status: pending ? 'pending' : 'ready',
      workspace_id: workspaceId,
      contracts: selectWorkspaceCrossRepoContracts(record.graph, {
        limit: positiveBoundedInt(params.get('limit'), 100, 500),
        offset: nonNegativeInt(params.get('offset'), 0),
        journey_limit: positiveBoundedInt(params.get('journey_limit'), 25, 100),
      }),
    },
  };
}

function positiveBoundedInt(raw: string | null, fallback: number, maximum: number): number {
  const parsed = raw !== null ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), maximum) : fallback;
}

function nonNegativeInt(raw: string | null, fallback: number): number {
  const parsed = raw !== null ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}
