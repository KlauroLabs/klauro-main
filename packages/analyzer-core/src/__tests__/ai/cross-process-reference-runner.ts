/**
 * Standalone script (NOT a jest test — no `.test.ts` suffix, so jest's
 * `**\/__tests__/**\/*.test.ts` testMatch never picks it up) that runs one
 * full analysis of a fixture directory and prints the canonical
 * (order-independent) `references` edge set plus import-source attributions
 * as JSON on stdout.
 *
 * Invoked by run-stability-cross-process.test.ts as a genuinely FRESH `node`
 * child process per run (not an in-process call, not a jest worker) — this is
 * what makes the byte-identity assertion in that test a real cross-process
 * check rather than an in-process one. See docs/cas/DETERMINISM-BOUNDARY.md
 * for why cross-process (not just cross-call) is the bar: the historical
 * defect there was specifically an async file-processing-order race, which an
 * in-process repeated call can fail to expose if V8/OS caches paper over the
 * timing the second time around.
 *
 * Usage: node -r ts-node/register/transpile-only cross-process-reference-runner.ts <fixtureDir>
 */
import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';
import { TypeScriptJavaScriptAnalyzer } from '../../analyzer/languages/typescript-javascript-analyzer';
import { ExpressAnalyzer } from '../../analyzer/frameworks/web';
import type { CASOutput } from '../../types/cas.types';

process.env.KLAURO_AI_INTERPRETATION = 'false';
process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS = 'false';
process.env.KLAURO_EMBEDDING_ENABLED = 'false';
delete process.env.OPENAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

function createPipelineOrchestrator(): AnalyzerOrchestrator {
  const orchestrator = new AnalyzerOrchestrator();
  orchestrator.registerAnalyzer({
    id: 'typescript-javascript',
    name: 'TypeScript/JavaScript Analyzer',
    type: 'language',
    version: '1.0.0',
    detectPatterns: { files: ['package.json', 'tsconfig.json'], content: [/\.ts$/, /\.js$/] },
    analyzer: new TypeScriptJavaScriptAnalyzer(),
  });
  orchestrator.registerAnalyzer({
    id: 'express',
    name: 'Express.js Analyzer',
    type: 'framework',
    version: '1.0.0',
    detectPatterns: { dependencies: ['express'], files: ['package.json'] },
    requires: ['typescript-javascript'],
    analyzer: new ExpressAnalyzer(),
  });
  return orchestrator;
}

/** Order-independent view of the cross-file `references` edge set: sorted
 *  "source|target" id pairs, so the comparison is sensitive to WHICH edges
 *  exist and how ambiguous names resolved, but not to emission order. */
function referenceEdgeSet(output: CASOutput): string[] {
  return output.edges
    .filter((e) => e.type === 'references')
    .map((e) => `${e.source}|${e.target}`)
    .sort();
}

function nodeFileBase(output: CASOutput, nodeId: string): string | undefined {
  const node = output.nodes.find((n) => n.id === nodeId);
  const file = node?.source?.file;
  return file ? file.split('/').pop() : undefined;
}

/** For every `references` edge, the consumer file + resolved-module file,
 *  keyed the same way as expected-attributions.json (consumer::group) so the
 *  test can assert import-source-aware correctness, not just consistency. */
function attributions(output: CASOutput): Record<string, string> {
  const nodeById = new Map(output.nodes.map((n) => [n.id, n]));
  const out: Record<string, string> = {};
  for (const e of output.edges) {
    if (e.type !== 'references') continue;
    const targetNode = nodeById.get(e.target);
    if (!targetNode) continue;
    const consumer = nodeFileBase(output, e.source);
    const module = nodeFileBase(output, e.target);
    const sourceFile = output.nodes.find((n) => n.id === e.source)?.source?.file;
    const group = sourceFile ? sourceFile.split('/').slice(-2, -1)[0] : undefined;
    if (consumer && module && group) out[`${consumer}::${group}`] = module;
  }
  return out;
}

async function main(): Promise<void> {
  const fixtureDir = process.argv[2];
  if (!fixtureDir) {
    console.error('usage: cross-process-reference-runner.ts <fixtureDir>');
    process.exit(2);
  }
  const out = await createPipelineOrchestrator().orchestrateAnalysis(fixtureDir);
  const refSet = referenceEdgeSet(out);
  const attrs = attributions(out);
  console.error(
    `[cross-process-reference-runner pid=${process.pid}] nodes=${out.nodes.length} edges=${out.edges.length} references=${refSet.length}`,
  );
  process.stdout.write(JSON.stringify({ refSet, attributions: attrs }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
