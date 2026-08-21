jest.unmock('fs');
jest.unmock('fs-extra');
jest.unmock('glob');

import { execFileSync } from 'node:child_process';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';
import { ChangeDetector } from '../../analyzer/core/change-detector';
import { graphItemAnalyzers } from '../../analyzer/core/incremental-contribution-refresh';
import { TypeScriptJavaScriptAnalyzer } from '../../analyzer/languages/typescript-javascript-analyzer';
import type { CASOutput, IncrementalState } from '../../types/cas.types';

function createOrchestrator(): AnalyzerOrchestrator {
  const orchestrator = new AnalyzerOrchestrator();
  orchestrator.registerAnalyzer({
    id: 'typescript-javascript',
    name: 'TypeScript/JavaScript Analyzer',
    type: 'language',
    version: '1.0.0',
    incremental: true,
    detectPatterns: { files: ['package.json'], content: [/\.ts$/] },
    analyzer: new TypeScriptJavaScriptAnalyzer(),
  });
  return orchestrator;
}

function graph(output: CASOutput): unknown {
  return {
    nodes: output.nodes,
    edges: output.edges,
    entryPoints: output.entry_points,
    exitPoints: output.exit_points,
  };
}

function reportBenchmark(label: string, input: {
  incrementalMs: number;
  coldMs: number;
  incremental: Awaited<ReturnType<AnalyzerOrchestrator['orchestrateIncrementalAnalysis']>>;
  rssBytes: number;
}): void {
  if (!process.env.KLAURO_REPORT_INCREMENTAL_BENCHMARK) return;
  process.stderr.write(`${JSON.stringify({
    label,
    incremental_ms: input.incrementalMs,
    cold_ms: input.coldMs,
    rss_mib: Math.round(input.rssBytes / 1024 / 1024),
    fallback_reason: input.incremental.fullRebuildReason || null,
    locality: input.incremental.changeReport.locality,
  })}\n`);
}

function nonReplaceableAttachedItems(output: CASOutput): unknown[] {
  const ownedNodeIds = new Set(output.nodes
    .filter(node => node.analyzers?.includes('typescript-javascript') || node.primaryAnalyzer === 'typescript-javascript')
    .map(node => node.id));
  return [
    ...output.edges,
    ...(output.entry_points || []),
    ...(output.exit_points || []),
  ].filter(item => {
    const attached = 'source_node' in item
      ? ownedNodeIds.has(item.source_node)
      : ownedNodeIds.has(item.source) || ownedNodeIds.has(item.target);
    const analyzers = graphItemAnalyzers(item);
    const attributes = item.metadata?.attributes as Record<string, unknown> | undefined;
    return attached && !analyzers.every(analyzer => analyzer === 'typescript-javascript') &&
      !(attributes?.source_analyzer === 'orchestrator' && attributes?.contribution_scope === 'derived-rebuild');
  }).map(item => ({ id: item.id, type: item.type, analyzers: graphItemAnalyzers(item), metadata: item.metadata }));
}

describe('incremental analysis graph parity', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-incremental-parity-'));
    await fs.outputJson(path.join(root, 'package.json'), { name: 'incremental-parity' });
    await fs.outputFile(path.join(root, 'src', 'value.ts'), 'export function value(): number { return 1; }\n');
    await fs.outputFile(
      path.join(root, 'src', 'consumer.ts'),
      "import { value } from './value';\nexport const doubled = value() * 2;\n"
    );
    const fanout = Number(process.env.KLAURO_INCREMENTAL_BENCHMARK_FANOUT || 0);
    for (let index = 0; index < fanout; index++) {
      await fs.outputFile(
        path.join(root, 'src', `consumer-${index}.ts`),
        `import { value } from './value';\nexport const projected${index} = () => value() * ${index + 1};\n`
      );
    }
    execFileSync('git', ['init'], { cwd: root, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@klauro.test'], { cwd: root, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Klauro Test'], { cwd: root, stdio: 'pipe' });
    execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: root, stdio: 'pipe' });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('marks hook-to-fetcher links as derived rebuild contributions', () => {
    const hook = {
      id: 'hook', name: 'useRecords', type: 'hook_usage',
      metadata: { attributes: { dependencies: ['fetchRecords'] } },
    } as any;
    const fetcher = { id: 'fetcher', name: 'fetchRecords', type: 'function' } as any;
    const edges: any[] = [];

    (createOrchestrator() as any).linkHookUsageFetchers([hook, fetcher], edges);

    expect(edges).toHaveLength(1);
    expect(edges[0].metadata.attributes).toMatchObject({
      source_analyzer: 'orchestrator', contribution_scope: 'derived-rebuild',
    });
  });

  it('matches a cold graph after a body-only change stops at a stable dependent surface', async () => {
    const initialOrchestrator = createOrchestrator();
    const previousOutput = await initialOrchestrator.orchestrateAnalysis(root);
    const previousState = (initialOrchestrator as unknown as {
      buildIncrementalState(projectPath: string, output: CASOutput, detector: ChangeDetector): IncrementalState;
    }).buildIncrementalState(root, previousOutput, new ChangeDetector(root));
    expect(nonReplaceableAttachedItems(previousOutput)).toEqual([]);

    await fs.outputFile(path.join(root, 'src', 'value.ts'), 'export function value(): number { return 2; }\n');

    const incrementalStartedAt = Date.now();
    const incremental = await createOrchestrator().orchestrateIncrementalAnalysis(root, previousOutput, previousState);
    const incrementalMs = Date.now() - incrementalStartedAt;
    const rssBytes = process.memoryUsage().rss;
    const coldStartedAt = Date.now();
    const cold = await createOrchestrator().orchestrateAnalysis(root);
    reportBenchmark('body-only', {
      incrementalMs,
      coldMs: Date.now() - coldStartedAt,
      incremental,
      rssBytes,
    });

    expect({
      wasFullRebuild: incremental.wasFullRebuild,
      fullRebuildReason: incremental.fullRebuildReason,
    }).toEqual({ wasFullRebuild: false, fullRebuildReason: undefined });
    expect(incremental.changeReport.locality?.analyzedFiles).toBeLessThanOrEqual(2);
    expect(graph(incremental.output)).toEqual(graph(cold));
  });

  it('matches a cold graph after an exported surface change refreshes project contributions', async () => {
    const initialOrchestrator = createOrchestrator();
    const previousOutput = await initialOrchestrator.orchestrateAnalysis(root);
    const previousState = (initialOrchestrator as unknown as {
      buildIncrementalState(projectPath: string, output: CASOutput, detector: ChangeDetector): IncrementalState;
    }).buildIncrementalState(root, previousOutput, new ChangeDetector(root));
    expect(nonReplaceableAttachedItems(previousOutput)).toEqual([]);
    await fs.outputFile(path.join(root, 'src', 'value.ts'), 'export function value(): number { return 2; }\nexport const label = "ready";\n');

    const incrementalStartedAt = Date.now();
    const incremental = await createOrchestrator().orchestrateIncrementalAnalysis(root, previousOutput, previousState);
    const incrementalMs = Date.now() - incrementalStartedAt;
    const rssBytes = process.memoryUsage().rss;
    const coldStartedAt = Date.now();
    const cold = await createOrchestrator().orchestrateAnalysis(root);
    reportBenchmark('exported-surface', {
      incrementalMs,
      coldMs: Date.now() - coldStartedAt,
      incremental,
      rssBytes,
    });

    expect(incremental.wasFullRebuild).toBe(false);
    expect(incremental.fullRebuildReason).toBeUndefined();
    expect(incremental.changeReport.locality?.graphAffectedFiles).toBeGreaterThan(0);
    expect(graph(incremental.output)).toEqual(graph(cold));
  });

  it.each([
    ['addition', async () => fs.outputFile(path.join(root, 'src', 'added.ts'), 'export const added = true;\n')],
    ['rename', async () => fs.move(path.join(root, 'src', 'value.ts'), path.join(root, 'src', 'renamed.ts'))],
  ])('fails safely to a cold-equivalent rebuild for file %s', async (_label, mutate) => {
    const initialOrchestrator = createOrchestrator();
    const previousOutput = await initialOrchestrator.orchestrateAnalysis(root);
    const previousState = (initialOrchestrator as unknown as {
      buildIncrementalState(projectPath: string, output: CASOutput, detector: ChangeDetector): IncrementalState;
    }).buildIncrementalState(root, previousOutput, new ChangeDetector(root));
    await mutate();

    const incremental = await createOrchestrator().orchestrateIncrementalAnalysis(root, previousOutput, previousState);
    const cold = await createOrchestrator().orchestrateAnalysis(root);

    expect(incremental.wasFullRebuild).toBe(true);
    expect(graph(incremental.output)).toEqual(graph(cold));
  });

  it('matches a cold graph after deleting a tracked file', async () => {
    const initialOrchestrator = createOrchestrator();
    const previousOutput = await initialOrchestrator.orchestrateAnalysis(root);
    const previousState = (initialOrchestrator as unknown as {
      buildIncrementalState(projectPath: string, output: CASOutput, detector: ChangeDetector): IncrementalState;
    }).buildIncrementalState(root, previousOutput, new ChangeDetector(root));
    await fs.remove(path.join(root, 'src', 'value.ts'));

    const incremental = await createOrchestrator().orchestrateIncrementalAnalysis(root, previousOutput, previousState);
    const cold = await createOrchestrator().orchestrateAnalysis(root);

    expect(incremental.wasFullRebuild).toBe(false);
    expect(incremental.fullRebuildReason).toBeUndefined();
    expect(graph(incremental.output)).toEqual(graph(cold));
  });
});
