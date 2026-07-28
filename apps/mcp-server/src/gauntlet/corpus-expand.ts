/**
 * Corpus-expansion harness — clones diverse, challenging repos, runs Klauro's
 * analyzer on each, and reports where reach grows vs where Klauro is BLIND.
 *
 * The point is two-sided: prove Klauro now handles more repo types (shell,
 * libraries, less-common stacks), and surface the next capability gaps honestly
 * (a repo that analyzes to ~0 nodes = a language/framework Klauro can't see yet).
 * Output feeds the "expand the reach" roadmap: every BLIND row is a missing
 * analyzer; every THIN row is an analyzer that needs depth.
 *
 *   npm run corpus:expand            # curated diverse set (small repos, shallow)
 *   npm run corpus:expand -- --set gaps   # only the suspected-gap stacks
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { analyzeForBench } from './product-analysis';
import { devDataRoot, reportDevDataDirSizeOnExit } from './dev-data';
import { isDirectCliInvocation } from '../cli-invocation';

const execFileAsync = promisify(execFile);

export interface ExpansionTarget {
  name: string;
  url: string;
  /** What this repo stresses — the dimension we're checking coverage on. */
  kind: string;
  /** Expected primary language/stack. */
  stack: string;
}

export interface ExpansionResult {
  name: string;
  kind: string;
  stack: string;
  cloned: boolean;
  nodes: number;
  edges: number;
  functions: number;
  entry_points: number;
  frameworks: string[];
  duration_ms: number;
  /** supported = real structure extracted; thin = some but sparse; blind = ~nothing. */
  verdict: 'supported' | 'thin' | 'blind' | 'error';
  error?: string;
}

/**
 * Curated, intentionally diverse + small (so a shallow clone is fast). Spans the
 * dimensions the corpus is weak on: shell, C, Solidity (crypto-relevant),
 * libraries, and a couple of well-covered stacks as a control.
 */
export const DIVERSE_SET: ExpansionTarget[] = [
  // --- already-supported controls ---
  { name: 'shlib', url: 'https://github.com/client9/shlib', kind: 'shell scripts', stack: 'shell' },
  { name: 'xxhash-go', url: 'https://github.com/cespare/xxhash', kind: 'Go library', stack: 'go' },
  // --- new languages (Wave 1) ---
  { name: 'solmate', url: 'https://github.com/transmissions11/solmate', kind: 'Solidity contracts', stack: 'solidity' },
  { name: 'sds', url: 'https://github.com/antirez/sds', kind: 'C library', stack: 'c' },
  { name: 'json-cpp', url: 'https://github.com/nlohmann/json', kind: 'C++ header lib', stack: 'cpp' },
  { name: 'swift-collections', url: 'https://github.com/apple/swift-collections', kind: 'Swift library', stack: 'swift' },
  { name: 'ktor-samples', url: 'https://github.com/ktorio/ktor-samples', kind: 'Kotlin/Ktor', stack: 'kotlin' },
  { name: 'plug', url: 'https://github.com/elixir-plug/plug', kind: 'Elixir library', stack: 'elixir' },
  // --- TS/JS meta-frameworks (Wave 2) ---
  { name: 'sveltekit-demo', url: 'https://github.com/sveltejs/realworld', kind: 'SvelteKit app', stack: 'sveltekit' },
  { name: 'astro-blog', url: 'https://github.com/withastro/astro', kind: 'Astro', stack: 'astro' },
  { name: 'hono', url: 'https://github.com/honojs/examples', kind: 'Hono backend', stack: 'hono' },
  // --- architectural libraries (Wave 3) ---
  { name: 'prisma-examples', url: 'https://github.com/prisma/prisma-examples', kind: 'Prisma ORM', stack: 'prisma' },
  { name: 'trpc', url: 'https://github.com/trpc/examples-next-prisma-starter', kind: 'tRPC contract', stack: 'trpc' },
  { name: 'langchain-templates', url: 'https://github.com/langchain-ai/langchain-nextjs-template', kind: 'LangChain AI app', stack: 'langchain' },
];

export const GAP_SET: ExpansionTarget[] = DIVERSE_SET.filter(t =>
  ['solidity', 'c', 'cpp', 'swift', 'kotlin', 'elixir'].includes(t.stack));

function classify(nodes: number, functions: number): ExpansionResult['verdict'] {
  if (nodes >= 40 && functions >= 5) return 'supported';
  if (nodes >= 5) return 'thin';
  return 'blind';
}

async function analyzeTarget(target: ExpansionTarget, workRoot: string): Promise<ExpansionResult> {
  const dest = path.join(workRoot, target.name);
  const started = Date.now();
  const base: ExpansionResult = {
    name: target.name, kind: target.kind, stack: target.stack,
    cloned: false, nodes: 0, edges: 0, functions: 0, entry_points: 0,
    frameworks: [], duration_ms: 0, verdict: 'error',
  };
  try {
    await fs.remove(dest).catch(() => undefined);
    await execFileAsync('git', ['clone', '--depth', '1', '--quiet', target.url, dest], { timeout: 120_000 });
    base.cloned = true;
  } catch (err) {
    base.error = `clone failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`;
    base.duration_ms = Date.now() - started;
    return base;
  }
  try {
    const cas = await analyzeForBench(dest);
    base.nodes = cas.nodes?.length || 0;
    base.edges = cas.edges?.length || 0;
    base.functions = (cas.nodes || []).filter((n: any) => n.type === 'function' || n.type === 'method').length;
    base.entry_points = (cas.entry_points || []).length;
    base.frameworks = (cas.system?.technologies?.frameworks || []).map((f: any) => f.name || f).slice(0, 6);
    base.verdict = classify(base.nodes, base.functions);
  } catch (err) {
    base.error = `analyze failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`;
    base.verdict = 'error';
  }
  base.duration_ms = Date.now() - started;
  return base;
}

export async function runCorpusExpansion(targets: ExpansionTarget[]): Promise<ExpansionResult[]> {
  // Corpus clones live in the one explicit dev-data dir (~/.klauro/dev), never
  // scattered under the user's real store; the run prints the dir's size on
  // exit so growth stays visible. Shallow clones — a few hundred MB, and the
  // whole dev dir is regenerable scratch, safe to delete wholesale.
  const workRoot = path.join(devDataRoot(), 'corpus-expand');
  reportDevDataDirSizeOnExit();
  await fs.ensureDir(workRoot);
  const results: ExpansionResult[] = [];
  for (const t of targets) {
    process.stdout.write(`\r[corpus] analyzing ${t.name} (${t.stack})…`.padEnd(60));
    results.push(await analyzeTarget(t, workRoot));
  }
  process.stdout.write('\n');
  const reportFile = path.join(os.homedir(), '.klauro', 'gauntlet', 'corpus-expansion.json');
  await fs.writeJson(reportFile, { generated_at: new Date().toISOString(), results }, { spaces: 2 });
  return results;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const setArg = argv.includes('--set') ? argv[argv.indexOf('--set') + 1] : 'diverse';
  const targets = setArg === 'gaps' ? GAP_SET : DIVERSE_SET;
  console.log(`[corpus] expanding reach over ${targets.length} diverse repos (${setArg} set)\n`);
  const results = await runCorpusExpansion(targets);
  console.log('\n  STACK       KIND                  NODES   FNS  EP   VERDICT   REPO');
  for (const r of results) {
    const flag = r.verdict === 'supported' ? '✓' : r.verdict === 'thin' ? '~' : '✗';
    console.log(
      `  ${r.stack.padEnd(11)} ${r.kind.padEnd(20)} ${String(r.nodes).padStart(6)} ${String(r.functions).padStart(5)} ${String(r.entry_points).padStart(3)}   ${flag} ${r.verdict.padEnd(8)} ${r.name}${r.error ? ' — ' + r.error : ''}`
    );
  }
  const blind = results.filter(r => r.verdict === 'blind');
  const supported = results.filter(r => r.verdict === 'supported');
  console.log(`\n[corpus] ${supported.length} supported, ${results.filter(r => r.verdict === 'thin').length} thin, ${blind.length} BLIND (missing analyzer).`);
  if (blind.length) console.log('[corpus] reach gaps to close next: ' + [...new Set(blind.map(r => r.stack))].join(', '));
}

if (isDirectCliInvocation('corpus-expand')) {
  main().catch(err => { console.error(err); process.exit(1); });
}
