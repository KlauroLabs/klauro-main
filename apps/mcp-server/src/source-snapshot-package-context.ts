import * as path from 'node:path';
import * as fs from 'fs-extra';
import {
  deriveLocalPackageImportContext,
  LOCAL_PACKAGE_IMPORT_CONTEXT_PATH,
} from '../../../packages/analyzer-core/src/analyzer/core/local-package-import-context';

interface SnapshotFile {
  path: string;
  content: string;
  hash: string;
}

interface StreamingSnapshotFile {
  path: string;
  hash: string;
  bytes: number;
  readContent: () => Promise<string>;
}

export async function appendDerivedLocalPackageContext(
  root: string,
  files: SnapshotFile[],
  hashContent: (content: string) => string
): Promise<void> {
  const context = await contextContent(root, files);
  if (!context) return;
  upsertSnapshotFile(files, context, hashContent);
}

export async function appendDerivedStreamingLocalPackageContext(
  root: string,
  files: StreamingSnapshotFile[],
  hashContent: (content: string) => string
): Promise<void> {
  const candidates = files.filter(file => isJavaScriptSource(file.path));
  const sources = await Promise.all(candidates.map(async file => ({ path: file.path, content: await file.readContent() })));
  const context = await contextContent(root, sources);
  if (!context) return;
  const hash = hashContent(context);
  const bytes = Buffer.byteLength(context, 'utf8');
  const existing = files.find(file => file.path === LOCAL_PACKAGE_IMPORT_CONTEXT_PATH);
  if (existing) {
    existing.hash = hash;
    existing.bytes = bytes;
    existing.readContent = async () => context;
    return;
  }
  files.push({ path: LOCAL_PACKAGE_IMPORT_CONTEXT_PATH, hash, bytes, readContent: async () => context });
}

export async function appendStoredLocalPackageContext(
  snapshotRoot: string,
  files: SnapshotFile[],
  hashContent: (content: string) => string
): Promise<void> {
  const contextPath = path.join(snapshotRoot, LOCAL_PACKAGE_IMPORT_CONTEXT_PATH);
  if (!await fs.pathExists(contextPath)) return;
  upsertSnapshotFile(files, await fs.readFile(contextPath, 'utf8'), hashContent);
}

async function contextContent(root: string, files: Array<{ path: string; content: string }>): Promise<string | undefined> {
  const context = await deriveLocalPackageImportContext(root, files.filter(file => isJavaScriptSource(file.path)));
  return context.imports.length > 0 ? `${JSON.stringify(context, null, 2)}\n` : undefined;
}

function upsertSnapshotFile(
  files: SnapshotFile[],
  content: string,
  hashContent: (content: string) => string
): void {
  const hash = hashContent(content);
  const existing = files.find(file => file.path === LOCAL_PACKAGE_IMPORT_CONTEXT_PATH);
  if (existing) {
    existing.content = content;
    existing.hash = hash;
    return;
  }
  files.push({ path: LOCAL_PACKAGE_IMPORT_CONTEXT_PATH, content, hash });
}

function isJavaScriptSource(file: string): boolean {
  return /\.(?:[cm]?[jt]sx?)$/i.test(file);
}
