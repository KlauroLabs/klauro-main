import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { assertValidCasTree } from '../../../packages/analyzer-core/src/analyzer/core/recursive-cas';
import { materializeDeployableCasTree } from './deployable-analysis';
import {
  CAS_SECTION_NAMES,
  createCasSectionManifest,
  hydrateCasSections,
  selectCasSections,
  selectExactCasSection,
  type CasSectionManifest,
  type CasSectionName,
  type CasTreeProjectionV1,
} from './cas-sections';
import type { ResolvedSegmentedAnalysis } from './segmented-analysis-storage';
import type { AnalysisTrack } from './track';

export function findCasById(root: CASOutput, casId: string): CASOutput | null {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.id === casId) return current;
    for (let index = (current.children?.length || 0) - 1; index >= 0; index -= 1) stack.push(current.children![index]);
  }
  return null;
}

export async function loadLegacyProjectedCas(
  projection: CasTreeProjectionV1,
  directory: string,
  casId: string,
  sections: readonly CasSectionName[],
  readArtifact: (filePath: string) => Promise<CASOutput>,
): Promise<Partial<CASOutput>> {
  for (const descriptor of projection.children) {
    if (path.basename(descriptor.file) !== descriptor.file) throw new Error(`CAS child '${descriptor.id}' has an invalid artifact path`);
    const childPath = path.join(directory, descriptor.file);
    const stat = await fs.stat(childPath);
    if (stat.size !== descriptor.bytes) throw new Error(`CAS child '${descriptor.id}' byte length mismatch`);
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(childPath)) hash.update(chunk as Buffer);
    if (hash.digest('hex') !== descriptor.sha256) throw new Error(`CAS child '${descriptor.id}' checksum mismatch`);
    const selected = findCasById(await readArtifact(childPath), casId);
    if (selected) return selectCasSections(selected, sections);
  }
  throw new Error(`Unknown CAS id '${casId}'`);
}

type SectionLoader = (
  projectPath: string,
  sections: readonly CasSectionName[],
  options: { track?: AnalysisTrack; cas_id?: string; pinned: { filePath: string; segmented: ResolvedSegmentedAnalysis } },
) => Promise<Partial<CASOutput> | null>;

export async function hydrateSegmentedCasTree(
  projectPath: string,
  filePath: string,
  segmented: ResolvedSegmentedAnalysis,
  loadSections: SectionLoader,
  track?: AnalysisTrack,
  casId?: string,
): Promise<CASOutput> {
  const projection = segmented.manifest.tree_projection;
  if (projection?.format === 'recursive-cas-section-references') {
    const rootId = casId || projection.root_id;
    const byId = new Map(projection.nodes.map(node => [node.id, node]));
    if (!byId.has(rootId)) throw new Error(`Unknown CAS id '${rootId}'`);
    const included = new Set<string>();
    const pending = [rootId];
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (included.has(id)) continue;
      included.add(id);
      pending.push(...byId.get(id)!.child_ids);
    }
    const hydrated = new Map<string, CASOutput>();
    for (const node of projection.nodes) {
      if (!included.has(node.id)) continue;
      const output = await loadSections(projectPath, node.sections.map(section => section.name), {
        ...(track ? { track } : {}),
        cas_id: node.id,
        pinned: { filePath, segmented },
      }) as CASOutput | null;
      if (!output) throw new Error(`Recursive CAS node '${node.id}' could not be hydrated`);
      const actualFields = Object.keys(output).sort();
      const expectedFields = node.logical_fields.filter(field => field !== 'children').sort();
      if (actualFields.length !== expectedFields.length || actualFields.some((field, index) => field !== expectedFields[index])) {
        throw new Error(`Recursive CAS node '${node.id}' logical fields do not match its section artifacts`);
      }
      hydrated.set(node.id, output);
    }
    for (const node of projection.nodes) {
      if (!included.has(node.id)) continue;
      if (node.child_ids.length === 0) continue;
      hydrated.get(node.id)!.children = node.child_ids.map(childId => {
        const child = hydrated.get(childId);
        if (!child) throw new Error(`Recursive CAS node '${node.id}' references missing child '${childId}'`);
        return child;
      });
    }
    const root = hydrated.get(rootId)!;
    if (rootId === projection.root_id) assertValidCasTree(root);
    return root;
  }
  if (casId && projection?.format === 'derived-deployable-references') {
    const subtree = await loadSections(projectPath, CAS_SECTION_NAMES, {
      ...(track ? { track } : {}), cas_id: casId, pinned: { filePath, segmented },
    }) as CASOutput | null;
    if (!subtree) throw new Error(`CAS child '${casId}' could not be hydrated`);
    return subtree;
  }
  const root = await loadSections(projectPath, segmented.manifest.sections.map(section => section.name), {
    ...(track ? { track } : {}),
    pinned: { filePath, segmented },
  }) as CASOutput | null;
  if (!root) throw new Error('Segmented CAS root could not be hydrated');
  if (projection?.format === 'derived-deployable-references') {
    root.children = [];
    for (const child of projection.children) {
      const output = await loadSections(projectPath, CAS_SECTION_NAMES, {
        ...(track ? { track } : {}), cas_id: child.id, pinned: { filePath, segmented },
      }) as CASOutput | null;
      if (!output) throw new Error(`CAS child '${child.id}' could not be hydrated`);
      root.children.push(output);
    }
    if (root.children.length === 0) delete root.children;
  }
  const materialized = projection ? root : materializeDeployableCasTree(root);
  assertValidCasTree(materialized);
  return materialized;
}

export interface LoadedAnalysisProjection {
  cas: Partial<CASOutput>;
  manifest: CasSectionManifest;
  inventory: { node_count: number; edge_count: number } | null;
}

interface ProjectionSource {
  filePath: string;
}

export async function loadCasProjection<T extends ProjectionSource>(
  projectPath: string,
  sections: readonly CasSectionName[],
  options: { track?: AnalysisTrack; cas_id?: string; require_sub_cas_index?: boolean } | undefined,
  resolve: () => Promise<T | null>,
  acquire: (source: T) => Promise<{ segmented: ResolvedSegmentedAnalysis; release: () => Promise<void> } | null>,
  loadSections: SectionLoader,
  readArtifact: (filePath: string) => Promise<CASOutput>,
): Promise<LoadedAnalysisProjection | null> {
  const source = await resolve();
  if (!source) return null;
  const leased = await acquire(source);
  if (leased) {
    try {
      const projection = leased.segmented.manifest.tree_projection;
      const hasSubCasIndex = projection?.format === 'recursive-cas-section-references' && projection.sub_cas_nodes;
      const requiredSections = options?.require_sub_cas_index && !hasSubCasIndex
        ? [...new Set<CasSectionName>([...sections, 'graph'])]
        : sections;
      const cas = await loadSections(projectPath, requiredSections, {
        ...options,
        pinned: { filePath: source.filePath, segmented: leased.segmented },
      });
      const graph = options?.cas_id ? undefined : leased.segmented.manifest.compact_graph;
      return cas ? {
        cas,
        manifest: leased.segmented.manifest,
        inventory: graph ? { node_count: graph.node_count, edge_count: graph.edge_count } : null,
      } : null;
    } finally {
      await leased.release();
    }
  }
  const legacy = await readArtifact(source.filePath);
  const selected = options?.cas_id ? findCasById(legacy, options.cas_id) : legacy;
  if (!selected) throw new Error(`Unknown CAS id '${options!.cas_id}'`);
  const requested = [...new Set<CasSectionName>(['identity', ...sections, ...(options?.require_sub_cas_index ? ['graph' as const] : [])])];
  return {
    cas: hydrateCasSections(requested.map(section => selectExactCasSection(selected, section))),
    manifest: createCasSectionManifest(selected),
    inventory: { node_count: selected.nodes.length, edge_count: selected.edges.length },
  };
}
