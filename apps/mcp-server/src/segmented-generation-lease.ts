import * as crypto from 'crypto';
import * as fs from 'fs-extra';
import * as path from 'path';
import type { CasSectionManifest } from './cas-sections';
import { generationGraceMs, segmentedAnalysisRoot, type ResolvedSegmentedAnalysis } from './segmented-analysis-storage';
import { validateCasTreeProjection } from './cas-sections';

export class SegmentedGenerationMissingError extends Error {
  constructor(readonly generation: string) {
    super(`Segmented analysis generation ${generation} is not present on disk; it was pruned or never published here`);
  }
}

async function registerGenerationReadLease(root: string, generation: string): Promise<(() => Promise<void>) | null> {
  const leaseDirectory = path.join(root, '.read-leases', generation);
  const leasePath = path.join(leaseDirectory, `${process.pid}-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`);
  await fs.ensureDir(leaseDirectory);
  try {
    await fs.writeFile(leasePath, '');
  } catch (error) {
    await fs.remove(leasePath).catch(() => undefined);
    await fs.rmdir(leaseDirectory).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const heartbeat = setInterval(() => {
    const now = new Date();
    void fs.utimes(leasePath, now, now).catch(() => undefined);
  }, Math.max(1_000, Math.min(30_000, Math.floor(generationGraceMs() / 3))));
  heartbeat.unref();
  return async () => {
    clearInterval(heartbeat);
    await fs.remove(leasePath).catch(() => undefined);
    await fs.rmdir(leaseDirectory).catch(() => undefined);
  };
}

async function resolvePinnedGeneration(root: string, generation: string): Promise<ResolvedSegmentedAnalysis> {
  if (!/^gen-[a-f0-9]{64}$/.test(generation)) throw new Error('content-addressed generation name is invalid');
  const directory = path.join(root, generation);
  let manifestBytes: Buffer;
  try {
    manifestBytes = await fs.readFile(path.join(directory, 'manifest.json'));
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) throw new SegmentedGenerationMissingError(generation);
    throw error;
  }
  if (crypto.createHash('sha256').update(manifestBytes).digest('hex') !== generation.slice(4)) throw new Error('generation manifest checksum mismatch');
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as CasSectionManifest;
  if (manifest.manifest_version !== 1) throw new Error('generation manifest version is unsupported');
  if (manifest.tree_projection?.format === 'recursive-cas-section-references') {
    if (manifest.tree_projection.version !== 2) throw new Error('recursive CAS tree projection version is unsupported');
    validateCasTreeProjection(manifest.tree_projection);
  }
  return { directory, manifest };
}

export async function acquireSegmentedGenerationLease(
  filePath: string,
  generation: string,
): Promise<{ segmented: ResolvedSegmentedAnalysis; release: () => Promise<void> }> {
  const root = segmentedAnalysisRoot(filePath);
  for (let attempt = 0; attempt < 3; attempt++) {
    await resolvePinnedGeneration(root, generation);
    const release = await registerGenerationReadLease(root, generation);
    if (!release) continue;
    try {
      const segmented = await resolvePinnedGeneration(root, generation);
      return { segmented, release };
    } catch (error) {
      await release();
      throw error;
    }
  }
  throw new SegmentedGenerationMissingError(generation);
}
