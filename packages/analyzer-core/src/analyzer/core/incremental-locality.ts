import type {
  CASOutput,
  CASNode,
  ChangeExecutionLocality,
  ChangeSet,
  FileAnalysisResult,
  IncrementalState
} from '../../types/cas.types';

interface BuildChangeExecutionLocalityInput {
  strategy: ChangeExecutionLocality['strategy'];
  state: IncrementalState | null;
  changeSet: ChangeSet;
  fileResults: Map<string, FileAnalysisResult>;
  cas?: Pick<CASOutput, 'deployable_evidence'>;
  refreshedProjectAnalyzers?: string[];
  fullRebuildReason?: string;
}

export function buildChangeExecutionLocality(
  input: BuildChangeExecutionLocalityInput
): ChangeExecutionLocality {
  const directChangedFiles = new Set([
    ...input.changeSet.added,
    ...input.changeSet.modified,
    ...input.changeSet.deleted
  ]);
  const affectedFiles = new Set(input.changeSet.affectedFiles || []);
  const previousTrackedFiles = new Set(Object.keys(input.state?.files || {}));
  const trackedFiles = input.strategy === 'full-rebuild'
    ? previousTrackedFiles.size
    : Math.max(
      0,
      previousTrackedFiles.size - input.changeSet.deleted.length + input.changeSet.added.length
    );
  const invalidatedPreviousFiles = new Set([
    ...input.changeSet.modified,
    ...input.changeSet.deleted,
    ...input.fileResults.keys(),
  ]);
  const reusedFiles = input.strategy === 'full-rebuild'
    ? 0
    : [...previousTrackedFiles].filter(filePath => !invalidatedPreviousFiles.has(filePath)).length;
  const reuseRatio = trackedFiles > 0 ? reusedFiles / trackedFiles : 0;
  const affectedPaths = new Set([...directChangedFiles, ...affectedFiles]);
  const affectedPackageRoots = affectedEvidenceRoots(input.cas, affectedPaths, evidence => evidence.kind === 'package');
  const affectedDeployableRoots = affectedEvidenceRoots(input.cas, affectedPaths, evidence => evidence.tier < 3 && evidence.kind !== 'package');

  return {
    strategy: input.strategy,
    directChangedFiles: directChangedFiles.size,
    graphAffectedFiles: affectedFiles.size,
    analyzedFiles: input.fileResults.size,
    trackedFiles,
    reusedFiles,
    reuseRatio: Math.round(reuseRatio * 10_000) / 10_000,
    affectedPackageRoots: affectedPackageRoots.length ? affectedPackageRoots : undefined,
    affectedDeployableRoots: affectedDeployableRoots.length ? affectedDeployableRoots : undefined,
    refreshedProjectAnalyzers: input.refreshedProjectAnalyzers?.length
      ? [...new Set(input.refreshedProjectAnalyzers)].sort()
      : undefined,
    fullRebuildReason: input.fullRebuildReason
  };
}

function affectedEvidenceRoots(
  cas: Pick<CASOutput, 'deployable_evidence'> | undefined,
  affectedPaths: Set<string>,
  predicate: (evidence: NonNullable<CASOutput['deployable_evidence']>[number]) => boolean
): string[] {
  const normalizedAffectedPaths = [...affectedPaths].map(normalizePath);
  return [...new Set((cas?.deployable_evidence || [])
    .filter(predicate)
    .filter(evidence => {
      const root = normalizePath(evidence.root_path || '.');
      return normalizedAffectedPaths.some(filePath => root === '.' || filePath === root || filePath.startsWith(`${root}/`));
    })
    .map(evidence => normalizePath(evidence.root_path || '.')))].sort();
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '') || '.';
}

export function localizedNodeFingerprint(node: CASNode): unknown {
  const rangeAffectsIdentity = node.type !== 'file';
  const sourceAttributes = { ...(node.metadata?.attributes || {}) };
  for (const key of ['incoming_calls', 'outgoing_calls', 'is_leaf', 'is_entry', 'declared_role']) {
    delete sourceAttributes[key];
  }
  const sourceMetadata = { ...(node.metadata || {}) };
  delete sourceMetadata.metrics;
  delete sourceMetadata.complexity;
  sourceMetadata.attributes = Object.keys(sourceAttributes).length ? sourceAttributes : undefined;
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    category: node.category,
    subcategories: node.subcategories,
    level: node.level,
    level_name: node.level_name,
    analyzers: node.analyzers,
    primaryAnalyzer: node.primaryAnalyzer,
    source: node.source ? {
      file: node.source.file,
      line: node.source.line,
      column: node.source.column,
      end_line: rangeAffectsIdentity ? node.source.end_line : undefined,
      end_column: rangeAffectsIdentity ? node.source.end_column : undefined,
      raw: node.source.raw
    } : undefined,
    metadata: sourceMetadata,
    signature: node.signature,
    implementation: node.implementation,
    description: node.description
  };
}

export function mergeLocalizedIncrementalNode(previous: CASNode, current: CASNode): CASNode {
  if (current.type !== 'file') return previous;
  const source = current.source ? { ...previous.source, ...current.source } : previous.source;
  const lineCount = typeof source?.line === 'number' && typeof source.end_line === 'number' && source.end_line >= source.line
    ? source.end_line - source.line + 1
    : undefined;
  return {
    ...previous,
    source,
    metadata: {
      ...(previous.metadata || {}),
      ...((current.metadata?.metrics || lineCount !== undefined) ? {
        metrics: {
          ...(previous.metadata?.metrics || {}),
          ...(current.metadata?.metrics || {}),
          ...(lineCount !== undefined ? { lines_of_code: lineCount } : {}),
        },
      } : {}),
    },
  };
}

export function selectLocalizedIncrementalEnrichmentNodes(
  previousNodes: CASNode[],
  currentNodes: CASNode[],
  modifiedFiles: ReadonlySet<string>,
): CASNode[] {
  const previousNodeIds = new Set(previousNodes.map(node => node.id));
  return currentNodes.filter(node =>
    !previousNodeIds.has(node.id) || (
      node.type === 'file' &&
      typeof node.source?.file === 'string' &&
      modifiedFiles.has(node.source.file)
    )
  );
}

export function isolateLocalizedStructuralImportanceNodes(
  nodes: CASNode[],
  enrichmentNodes: CASNode[],
): CASNode[] {
  const enrichmentNodeIds = new Set(enrichmentNodes.map(node => node.id));
  return nodes.map(node => enrichmentNodeIds.has(node.id) ? node : { ...node });
}
