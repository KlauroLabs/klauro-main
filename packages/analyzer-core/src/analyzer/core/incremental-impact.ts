import type {
  CASNode,
  CASEdge,
  CASEntryPoint,
  CASExitPoint,
  ChangeSet,
  IncrementalState,
} from '../../types/cas.types';
import * as path from 'path';

const SOURCE_CANDIDATE_EXTENSIONS = [
  '', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.java', '.kt', '.kts', '.cs', '.vb', '.fs',
  '.go', '.rs', '.php', '.dart', '.rb', '.scala', '.clj',
  '.tf', '.sh', '.ps1',
];

const GRAPH_DEPENDENCY_EDGE_TYPES = new Set([
  'calls', 'uses', 'depends_on', 'imports', 'extends', 'implements',
  'instantiates', 'injects', 'references', 'handles', 'validates',
  'authenticates', 'authorizes',
]);

function normalizeProjectPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

export function buildReverseFileDependencyIndex(
  files: IncrementalState['files']
): Map<string, Set<string>> {
  const dependents = new Map<string, Set<string>>();

  for (const [rawFilePath, record] of Object.entries(files)) {
    const filePath = normalizeProjectPath(rawFilePath);
    for (const rawImportedFile of record.importedFiles || []) {
      const importedFile = normalizeProjectPath(rawImportedFile);
      let importers = dependents.get(importedFile);
      if (!importers) {
        importers = new Set<string>();
        dependents.set(importedFile, importers);
      }
      importers.add(filePath);
    }
  }

  return dependents;
}

export function computeAffectedFileClosure(
  changedFiles: Iterable<string>,
  files: IncrementalState['files']
): string[] {
  const directChanges = new Set([...changedFiles].map(normalizeProjectPath));
  const dependents = buildReverseFileDependencyIndex(files);
  const affected = new Set<string>();
  const visited = new Set(directChanges);
  const queue = [...directChanges];

  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    for (const dependent of dependents.get(current) || []) {
      if (visited.has(dependent)) continue;
      visited.add(dependent);
      affected.add(dependent);
      queue.push(dependent);
    }
  }

  return [...affected].sort();
}

export function computeGraphAffectedFileClosure(input: {
  changedFiles: Iterable<string>;
  nodes: CASNode[];
  edges: CASEdge[];
  projectPath: string;
}): string[] {
  const normalizeSourceFile = (filePath?: string): string => {
    if (!filePath) return '';
    const relative = path.isAbsolute(filePath) ? path.relative(input.projectPath, filePath) : filePath;
    return normalizeProjectPath(relative);
  };
  const fileByNode = new Map(input.nodes.map(node => [node.id, normalizeSourceFile(node.source?.file)]));
  const reverseDependencies = new Map<string, Set<string>>();

  for (const edge of input.edges) {
    if (!GRAPH_DEPENDENCY_EDGE_TYPES.has(edge.type)) continue;
    const dependentFile = fileByNode.get(edge.source) || '';
    const dependencyFile = fileByNode.get(edge.target) || '';
    if (!dependentFile || !dependencyFile || dependentFile === dependencyFile) continue;
    let dependents = reverseDependencies.get(dependencyFile);
    if (!dependents) {
      dependents = new Set<string>();
      reverseDependencies.set(dependencyFile, dependents);
    }
    dependents.add(dependentFile);
  }

  const directChanges = new Set([...input.changedFiles].map(normalizeProjectPath));
  const visited = new Set(directChanges);
  const affected = new Set<string>();
  const queue = [...directChanges];
  for (let index = 0; index < queue.length; index++) {
    for (const dependent of reverseDependencies.get(queue[index]) || []) {
      if (visited.has(dependent)) continue;
      visited.add(dependent);
      affected.add(dependent);
      queue.push(dependent);
    }
  }
  return [...affected].sort();
}

export function resolveImportedFileReferences(
  importerFile: string,
  imports: Iterable<string>,
  knownFiles: ReadonlySet<string>
): string[] {
  return resolveWithReferenceIndex(importerFile, imports, buildFileReferenceIndex(knownFiles));
}

function buildFileReferenceIndex(knownFiles: Iterable<string>): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  const add = (reference: string, filePath: string) => {
    let matches = index.get(reference);
    if (!matches) {
      matches = new Set<string>();
      index.set(reference, matches);
    }
    matches.add(filePath);
  };

  for (const rawKnownFile of knownFiles) {
    const knownFile = normalizeProjectPath(rawKnownFile);
    const withoutExtension = knownFile.replace(/\.[^/.]+$/, '');
    add(knownFile, knownFile);
    add(withoutExtension, knownFile);
    if (/\/index$/i.test(withoutExtension)) add(path.posix.dirname(withoutExtension), knownFile);

    const segments = withoutExtension.split('/');
    for (let index = 1; index < segments.length; index++) {
      add(segments.slice(index).join('/'), knownFile);
    }
  }

  return index;
}

function resolveWithReferenceIndex(
  importerFile: string,
  imports: Iterable<string>,
  referenceIndex: ReadonlyMap<string, ReadonlySet<string>>
): string[] {
  const resolved = new Set<string>();

  for (const rawImport of imports) {
    const importReference = String(rawImport).trim().replace(/[?#].*$/, '');
    if (!importReference) continue;

    const normalizedReference = normalizeProjectPath(importReference);
    const roots = new Set<string>();
    if (importReference.startsWith('.')) {
      roots.add(normalizeProjectPath(path.posix.join(path.posix.dirname(normalizeProjectPath(importerFile)), importReference)));
    } else {
      roots.add(normalizedReference.replace(/^\//, ''));
      if (!importReference.includes('/')) roots.add(importReference.replace(/\./g, '/'));
    }

    for (const root of roots) {
      for (const extension of SOURCE_CANDIDATE_EXTENSIONS) {
        const direct = `${root}${extension}`;
        for (const match of referenceIndex.get(direct) || []) resolved.add(match);
        const indexFile = `${root}/index${extension}`;
        for (const match of referenceIndex.get(indexFile) || []) resolved.add(match);
      }
      for (const match of referenceIndex.get(root) || []) resolved.add(match);
    }
  }

  return [...resolved].sort();
}

export function normalizeIncrementalStateImports(files: IncrementalState['files']): void {
  const knownFiles = new Set(Object.keys(files).map(normalizeProjectPath));
  const referenceIndex = buildFileReferenceIndex(knownFiles);
  for (const record of Object.values(files)) {
    record.importedFiles = resolveWithReferenceIndex(record.filePath, record.importedFiles || [], referenceIndex);
  }
}

export function filesRequiringIncrementalAnalysis(changeSet: ChangeSet): string[] {
  const deleted = new Set(changeSet.deleted.map(normalizeProjectPath));
  return [...new Set([
    ...changeSet.added,
    ...changeSet.modified,
    ...(changeSet.affectedFiles || []),
  ].map(normalizeProjectPath))]
    .filter(filePath => !deleted.has(filePath))
    .sort();
}

export function remapIncrementalNodeReferences(input: {
  projectPath: string;
  previousNodes: CASNode[];
  nodes: CASNode[];
  edges: CASEdge[];
  entryPoints: CASEntryPoint[];
  exitPoints: CASExitPoint[];
}): number {
  const { projectPath, previousNodes, nodes, edges, entryPoints, exitPoints } = input;
  const normalizeSource = (file: string | undefined): string => {
    if (!file) return '';
    const resolved = path.isAbsolute(file) ? path.relative(projectPath, file) : file;
    return normalizeProjectPath(resolved);
  };
  const previousById = new Map(previousNodes.map(node => [node.id, node]));
  const currentById = new Map(nodes.map(node => [node.id, node]));
  const ownerName = (node: CASNode, lookup: ReadonlyMap<string, CASNode>): string =>
    node.parent ? lookup.get(node.parent)?.name || '' : '';
  const strictIdentity = (node: CASNode, lookup: ReadonlyMap<string, CASNode>): string =>
    `${normalizeSource(node.source?.file)}::${node.type}::${ownerName(node, lookup)}::${node.name}`;
  const relaxedIdentity = (node: CASNode): string =>
    `${normalizeSource(node.source?.file)}::${node.type}::${node.name}`;

  const currentByStrictIdentity = new Map<string, CASNode[]>();
  const currentByRelaxedIdentity = new Map<string, CASNode[]>();
  for (const node of nodes) {
    const strictKey = strictIdentity(node, currentById);
    const strictMatches = currentByStrictIdentity.get(strictKey) || [];
    strictMatches.push(node);
    currentByStrictIdentity.set(strictKey, strictMatches);
    const relaxedKey = relaxedIdentity(node);
    const relaxedMatches = currentByRelaxedIdentity.get(relaxedKey) || [];
    relaxedMatches.push(node);
    currentByRelaxedIdentity.set(relaxedKey, relaxedMatches);
  }

  const redirect = new Map<string, string>();
  for (const oldNode of previousNodes) {
    if (currentById.has(oldNode.id)) {
      const parentWasRemoved = Boolean(oldNode.parent) && !currentById.has(oldNode.parent!);
      if (!parentWasRemoved) continue;
      const replacementCandidates = (currentByRelaxedIdentity.get(relaxedIdentity(oldNode)) || [])
        .filter(candidate => candidate.id !== oldNode.id);
      if (replacementCandidates.length === 1) redirect.set(oldNode.id, replacementCandidates[0].id);
      continue;
    }
    const strictMatches = currentByStrictIdentity.get(strictIdentity(oldNode, previousById)) || [];
    const matches = strictMatches.length === 1
      ? strictMatches
      : currentByRelaxedIdentity.get(relaxedIdentity(oldNode)) || [];
    if (matches.length === 1) redirect.set(oldNode.id, matches[0].id);
  }
  if (redirect.size === 0) return 0;

  for (const edge of edges) {
    edge.source = redirect.get(edge.source) || edge.source;
    edge.target = redirect.get(edge.target) || edge.target;
  }
  for (const node of nodes) {
    if (node.parent) node.parent = redirect.get(node.parent) || node.parent;
  }
  for (const entryPoint of entryPoints) {
    entryPoint.source_node = redirect.get(entryPoint.source_node) || entryPoint.source_node;
    if (entryPoint.handler?.node_id) {
      entryPoint.handler.node_id = redirect.get(entryPoint.handler.node_id) || entryPoint.handler.node_id;
    }
  }
  for (const exitPoint of exitPoints) {
    if (exitPoint.source_node) exitPoint.source_node = redirect.get(exitPoint.source_node) || exitPoint.source_node;
    if (exitPoint.data?.transformation_node) {
      exitPoint.data.transformation_node = redirect.get(exitPoint.data.transformation_node) || exitPoint.data.transformation_node;
    }
    if (exitPoint.connected_nodes) {
      exitPoint.connected_nodes = exitPoint.connected_nodes.map(nodeId => redirect.get(nodeId) || nodeId);
    }
  }
  return redirect.size;
}
