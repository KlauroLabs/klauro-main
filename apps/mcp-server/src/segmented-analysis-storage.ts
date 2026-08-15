import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import pLimit from 'p-limit';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import {
  createCasSectionManifest,
  selectExactCasSection,
  type CasSectionManifest,
} from './cas-sections';

interface SegmentedAnalysisPointer {
  manifest_version: 1;
  revision: string;
}

type JsonWriter = (
  filePath: string,
  value: unknown,
  options?: { spaces?: number },
) => Promise<void>;

export function segmentedAnalysisRoot(filePath: string): string {
  return `${filePath}.sections`;
}

export async function writeSegmentedAnalysis(
  filePath: string,
  output: CASOutput,
  extension: string,
  writeCompressedJson: JsonWriter,
  writeJson: JsonWriter,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  if (!isCurrent()) return;
  const root = segmentedAnalysisRoot(filePath);
  const revision = `rev-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const revisionDir = path.join(root, revision);
  const tmpDir = `${revisionDir}.tmp`;
  const manifest = createCasSectionManifest(output);
  try {
    await fs.ensureDir(tmpDir);
    const writeSection = pLimit(2);
    await Promise.all(manifest.sections.map(descriptor => writeSection(async () => {
      const sectionFile = `${descriptor.name}.json${extension}`;
      const sectionPath = path.join(tmpDir, sectionFile);
      await writeCompressedJson(sectionPath, selectExactCasSection(output, descriptor.name), { spaces: 0 });
      const stat = await fs.stat(sectionPath);
      descriptor.file = sectionFile;
      descriptor.bytes = stat.size;
    })));
    await writeJson(path.join(tmpDir, 'manifest.json'), manifest, { spaces: 2 });
    if (!isCurrent()) return;
    await fs.ensureDir(root);
    await fs.move(tmpDir, revisionDir, { overwrite: false });
    if (!isCurrent()) {
      await fs.remove(revisionDir).catch(() => undefined);
      return;
    }
    await writeJson(path.join(root, 'current.json'), {
      manifest_version: 1,
      revision,
    } satisfies SegmentedAnalysisPointer, { spaces: 2 });
    if (!isCurrent()) {
      const currentPath = path.join(root, 'current.json');
      const current = await fs.readJson(currentPath).catch(() => null) as SegmentedAnalysisPointer | null;
      if (current?.revision === revision) await fs.remove(currentPath).catch(() => undefined);
      await fs.remove(revisionDir).catch(() => undefined);
      return;
    }
    const revisions = (await fs.readdir(root).catch(() => []))
      .filter(name => name.startsWith('rev-') && !name.endsWith('.tmp'))
      .sort()
      .reverse();
    for (const stale of revisions.slice(2)) await fs.remove(path.join(root, stale)).catch(() => undefined);
  } finally {
    await fs.remove(tmpDir).catch(() => undefined);
  }
}

export async function resolveSegmentedAnalysis(
  filePath: string,
): Promise<{ directory: string; manifest: CasSectionManifest } | null> {
  const root = segmentedAnalysisRoot(filePath);
  try {
    const pointer = await fs.readJson(path.join(root, 'current.json')) as SegmentedAnalysisPointer;
    if (pointer.manifest_version !== 1 || !pointer.revision) return null;
    const directory = path.join(root, pointer.revision);
    const manifest = await fs.readJson(path.join(directory, 'manifest.json')) as CasSectionManifest;
    if (manifest.manifest_version !== 1) return null;
    return { directory, manifest };
  } catch {
    return null;
  }
}
