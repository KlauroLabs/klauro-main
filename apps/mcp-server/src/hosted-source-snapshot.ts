import * as fs from 'fs-extra';
import * as path from 'node:path';
import type { RemoteFileChange, SourceManifest } from './remote-source';
import { mergeSourceExclusions, readWorkspaceSourceExclusions, validateSnapshotSourceCoverage, writeWorkspaceSourceExclusions } from './source-coverage';

export async function writeSnapshot(workspace: string, files: Array<{ path: string; content: string }>, manifest?: Pick<SourceManifest, 'excluded_oversize_files'>): Promise<void> {
  const exclusions = validateSnapshotSourceCoverage(manifest || {}, files);
  for (const file of files) {
    const destination = safeDestination(workspace, file.path);
    await fs.ensureDir(path.dirname(destination));
    await fs.writeFile(destination, file.content, 'utf8');
  }
  await writeWorkspaceSourceExclusions(workspace, exclusions);
}

export async function applySnapshotChanges(workspace: string, changes: RemoteFileChange[], manifest?: Pick<SourceManifest, 'excluded_oversize_files'>): Promise<void> {
  const exclusions = validateSnapshotSourceCoverage(manifest || {}, changes);
  const previous = await readWorkspaceSourceExclusions(workspace);
  const retained = mergeSourceExclusions(previous, changes, exclusions);
  for (const file of exclusions) {
    const destination = safeDestination(workspace, file.path);
    const stat = await fs.lstat(destination).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (stat && !stat.isFile()) throw new Error('Source exclusion must identify a file, not a directory or symbolic link');
  }
  await applyChanges(workspace, changes);
  for (const file of exclusions) await fs.remove(safeDestination(workspace, file.path));
  if (previous !== undefined || exclusions.length) {
    await writeWorkspaceSourceExclusions(workspace, retained);
  }
}

async function applyChanges(workspace: string, changes: RemoteFileChange[]): Promise<void> {
  for (const change of changes) {
    const destination = safeDestination(workspace, change.path);
    if (change.status === 'deleted') {
      await fs.remove(destination);
      continue;
    }
    await fs.ensureDir(path.dirname(destination));
    await fs.writeFile(destination, change.content, 'utf8');
  }
}

function safeDestination(workspace: string, relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const destination = path.resolve(workspace, normalized);
  if (!(destination === workspace || destination.startsWith(`${workspace}${path.sep}`))) {
    throw new Error(`Refusing to write path outside workspace: ${relativePath}`);
  }
  return destination;
}
