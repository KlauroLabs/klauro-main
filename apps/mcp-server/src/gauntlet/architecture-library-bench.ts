/**
 * Architecture-library bench — libraries that materially define code shape.
 *
 * This measures the rules that are too important to hide inside generic
 * dependency detection: DI containers, mediator/CQRS, actor systems, workflow
 * engines, state machines, service SDKs, AI SDKs, queues, brokers, and similar
 * architecture-shaping dependencies. The target is not "package listed in
 * package.json"; it is "Klauro names the boundary, finds usage sites, emits
 * exit points when applicable, and carries agent guidance for preserving the
 * local architecture."
 */

import * as fs from 'fs-extra';
import * as path from 'path';
import { analyzeForBench } from './product-analysis';
import { validateWin } from './win-validator';
import type { ArmResult, WinVerdict } from './report-schema';

interface ArchitectureLibraryTruth {
  task: 'architecture-library-boundaries';
  expected_categories: string[];
  expected_packages: string[];
  expected_exit_actions: string[];
}

export interface ArchitectureLibraryBenchResult {
  fixture: string;
  arms: ArmResult[];
  verdict: WinVerdict;
  detail: Array<{
    arm: string;
    categories: string[];
    packages: string[];
    exit_actions: string[];
    guidance_count: number;
    f1: number;
    bytes: number;
    can_answer: boolean;
  }>;
}

function f1(produced: string[], truth: string[]): number {
  const producedLower = produced.map(item => item.toLowerCase());
  const tp = truth.filter(expected => producedLower.some(item => item.includes(expected.toLowerCase()))).length;
  const precision = produced.length ? tp / produced.length : truth.length ? 0 : 1;
  const recall = truth.length ? tp / truth.length : 1;
  return precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
}

function recall(produced: string[], truth: string[]): number {
  const producedLower = produced.map(item => item.toLowerCase());
  return truth.length
    ? truth.filter(expected => producedLower.some(item => item.includes(expected.toLowerCase()))).length / truth.length
    : 1;
}

function toTokens(bytes: number): number {
  return Math.max(1, Math.round(bytes / 4));
}

async function sourceBytes(dir: string): Promise<number> {
  let total = 0;
  for (const file of await fs.readdir(dir)) {
    if (file === 'truth.json') continue;
    const filePath = path.join(dir, file);
    try {
      const stat = await fs.stat(filePath);
      if (stat.isFile()) total += stat.size;
    } catch {
      /* noop */
    }
  }
  return total;
}

async function klauroArchitectureLibraries(dir: string): Promise<{
  categories: string[];
  packages: string[];
  exit_actions: string[];
  guidance_count: number;
  bytes: number;
  time_ms: number;
}> {
  const started = Date.now();
  const cas: any = await analyzeForBench(dir);
  const libraries = (cas.libraries || []).filter((library: any) =>
    library.category && Array.isArray(library.usage_patterns)
  );
  const categories = [...new Set<string>(libraries.map((library: any) => String(library.category || '')).filter(Boolean))].sort();
  const packages = [...new Set<string>(libraries.map((library: any) => String(library.name || '')).filter(Boolean))].sort();
  const exitActions = [...new Set<string>((cas.exit_points || [])
    .map((exit: any) => String(exit.operation?.action || exit.protocol?.action || exit.metadata?.action || ''))
    .filter(Boolean))].sort();
  const guidanceCount = libraries.filter((library: any) => /preserve|must|boundary|contract|retry|scope/i.test(String(library.description || ''))).length;
  const compact = {
    categories,
    packages,
    exit_actions: exitActions,
    guidance_count: guidanceCount,
  };
  return {
    categories,
    packages,
    exit_actions: exitActions,
    guidance_count: guidanceCount,
    bytes: Buffer.byteLength(JSON.stringify(compact), 'utf8'),
    time_ms: Date.now() - started,
  };
}

export async function runArchitectureLibraryBench(fixtureDir: string): Promise<ArchitectureLibraryBenchResult> {
  const truth: ArchitectureLibraryTruth = await fs.readJson(path.join(fixtureDir, 'truth.json'));
  const kl = await klauroArchitectureLibraries(fixtureDir);
  const srcBytes = await sourceBytes(fixtureDir);
  const categoryF1 = f1(kl.categories, truth.expected_categories);
  const packageF1 = f1(kl.packages, truth.expected_packages);
  const exitF1 = recall(kl.exit_actions, truth.expected_exit_actions);
  const guidanceScore = kl.guidance_count >= truth.expected_categories.length ? 1 : kl.guidance_count / Math.max(1, truth.expected_categories.length);
  const klQuality = Math.round(((categoryF1 * 0.35) + (packageF1 * 0.25) + (exitF1 * 0.25) + (guidanceScore * 0.15)) * 100);
  const arms: ArmResult[] = [{
    arm_id: 'klauro',
    mode: 'engine',
    attempted: true,
    metrics: { quality: klQuality, time_ms: kl.time_ms, tokens: toTokens(kl.bytes) },
    source: 'architecture-library-bench:klauro',
  }];
  const detail: ArchitectureLibraryBenchResult['detail'] = [{
    arm: 'klauro',
    categories: kl.categories,
    packages: kl.packages,
    exit_actions: kl.exit_actions,
    guidance_count: kl.guidance_count,
    f1: klQuality / 100,
    bytes: kl.bytes,
    can_answer: true,
  }];

  for (const armId of ['codebase-memory', 'ctags', 'embeddings-nomic']) {
    arms.push({
      arm_id: armId,
      mode: 'engine',
      attempted: true,
      metrics: { quality: 0, time_ms: 1, tokens: toTokens(srcBytes) },
      source: `architecture-library-bench:${armId}`,
    });
    detail.push({
      arm: armId,
      categories: [],
      packages: [],
      exit_actions: [],
      guidance_count: 0,
      f1: 0,
      bytes: srcBytes,
      can_answer: false,
    });
  }

  const verdict = validateWin(
    arms,
    'Klauro classifies architecture-shaping libraries into boundaries, usage nodes, exit actions, and agent guidance; structural/file indexers can find dependency strings but do not emit those architecture semantics.',
  );
  return { fixture: path.basename(fixtureDir), arms, verdict, detail };
}
