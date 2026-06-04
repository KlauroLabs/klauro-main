import * as fs from 'fs-extra';
import * as path from 'path';
import { getOrchestrator } from './analyzer';
import { getCrossRepoContracts } from './analysis-mastery';
import { buildCrossRepositoryLinks } from './product';
import type { CASCrossRepositoryLink, CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';

type GateStatus = 'pass' | 'warn' | 'fail';

interface ContractExpectation {
  name: string;
  repositories: Array<{ name: string; path: string }>;
  expected_links?: Array<{
    type: CASCrossRepositoryLink['type'];
    source_repository: string;
    target_repository: string;
    method?: string;
    endpoint?: string;
    minimum_confidence?: number;
  }>;
  minimums?: {
    links?: number;
    confirmed_or_likely?: number;
    conflicts?: number;
  };
}

interface GateResult {
  id: string;
  status: GateStatus;
  score: number;
  detail: string;
}

function parseArgs(argv: string[]) {
  let fixtureRoot = path.join(process.cwd(), 'fixtures', 'cross-repo-contracts');
  let outputPath = path.join(process.cwd(), '.klauro-contract-gauntlet', 'latest-report.json');

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--fixture-root') {
      fixtureRoot = path.resolve(argv[++i]);
    } else if (arg === '--output') {
      outputPath = path.resolve(argv[++i]);
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return { fixtureRoot, outputPath };
}

function printHelp(): void {
  console.log([
    'Usage: npm run contract-gauntlet -- [options]',
    '',
    'Options:',
    '  --fixture-root /path       Root containing cross-repo fixture groups.',
    '  --output /path/report.json Write JSON report.',
  ].join('\n'));
}

async function loadExpectations(fixtureRoot: string) {
  const entries = await fs.readdir(fixtureRoot, { withFileTypes: true });
  const expectations: Array<{ root: string; expectation: ContractExpectation }> = [];

  for (const entry of entries.filter(candidate => candidate.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
    const root = path.join(fixtureRoot, entry.name);
    const expectationPath = path.join(root, 'cross-repo-expectations.json');
    if (await fs.pathExists(expectationPath)) {
      expectations.push({ root, expectation: await fs.readJson(expectationPath) });
    }
  }

  return expectations;
}

async function analyzeRepositories(root: string, expectation: ContractExpectation) {
  const repositories: Array<{ path: string; name: string; cas: CASOutput }> = [];

  for (const repository of expectation.repositories) {
    const repositoryPath = path.resolve(root, repository.path);
    const cas = await getOrchestrator().orchestrateAnalysis(repositoryPath);
    repositories.push({ path: repositoryPath, name: repository.name, cas });
  }

  return repositories;
}

function evaluateExpectation(expectation: ContractExpectation, links: ReturnType<typeof buildCrossRepositoryLinks>): GateResult[] {
  const gates: GateResult[] = [];
  const minimumLinks = expectation.minimums?.links || 1;
  gates.push(minimumGate('links', links.links.length, minimumLinks));

  const minimumCertainty = expectation.minimums?.confirmed_or_likely || 0;
  gates.push(minimumGate('confirmed-or-likely', links.certainty.confirmed + links.certainty.likely, minimumCertainty));

  if (typeof expectation.minimums?.conflicts === 'number') {
    const passed = links.conflicts.length <= expectation.minimums.conflicts;
    gates.push(gate('conflicts', passed ? 'pass' : 'fail', passed ? 100 : 0, `${links.conflicts.length}/${expectation.minimums.conflicts}`));
  }

  for (const expectedLink of expectation.expected_links || []) {
    const found = links.links.find(link =>
      link.type === expectedLink.type &&
      repositoryMatches(link.source_repository?.path, expectedLink.source_repository) &&
      repositoryMatches(link.target_repository?.path, expectedLink.target_repository) &&
      (!expectedLink.method || !link.connection?.method || link.connection.method.toUpperCase() === expectedLink.method.toUpperCase()) &&
      (!expectedLink.endpoint || routesCompatible(link.connection?.endpoint, expectedLink.endpoint)) &&
      ((link.metadata?.confidence || 0) >= (expectedLink.minimum_confidence || 0))
    );
    gates.push(gate(
      `expected-link:${expectedLink.type}:${expectedLink.source_repository}->${expectedLink.target_repository}`,
      found ? 'pass' : 'fail',
      found ? 100 : 0,
      found ? `${found.id} confidence ${found.metadata?.confidence || 0}` : 'missing'
    ));
  }

  return gates;
}

function repositoryMatches(actualPath: string | undefined, expectedName: string): boolean {
  if (!actualPath) return false;
  return path.basename(actualPath) === expectedName || actualPath.includes(`/${expectedName}/`) || actualPath.endsWith(`/${expectedName}`);
}

function routesCompatible(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const left = normalizeRoute(actual);
  const right = normalizeRoute(expected);
  if (left === right) return true;
  const leftParts = left.split('/').filter(Boolean);
  const rightParts = right.split('/').filter(Boolean);
  if (leftParts.length !== rightParts.length) return left.endsWith(right) || right.endsWith(left);
  return leftParts.every((part, index) => part === rightParts[index] || part === ':param' || rightParts[index] === ':param');
}

function normalizeRoute(value: string): string {
  return value
    .toLowerCase()
    .replace(/^https?:\/\/[^/]+/, '')
    .replace(/[?#].*$/, '')
    .replace(/:[a-z0-9_]+/g, ':param')
    .replace(/\{[^}]+\}/g, ':param')
    .replace(/\$\{[^}]+\}/g, ':param')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '') || '/';
}

function minimumGate(id: string, actual: number, minimum: number): GateResult {
  const passed = actual >= minimum;
  return gate(id, passed ? 'pass' : 'fail', passed ? 100 : Math.round((actual / Math.max(1, minimum)) * 100), `${actual}/${minimum}`);
}

function gate(id: string, status: GateStatus, score: number, detail: string): GateResult {
  return { id, status, score: Math.max(0, Math.min(100, score)), detail };
}

function statusFromGates(gates: GateResult[]): GateStatus {
  if (gates.some(result => result.status === 'fail')) return 'fail';
  if (gates.some(result => result.status === 'warn')) return 'warn';
  return 'pass';
}

function average(values: number[]): number {
  if (values.length === 0) return 100;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const expectations = await loadExpectations(args.fixtureRoot);
  if (expectations.length === 0) throw new Error(`No cross-repo expectations found under ${args.fixtureRoot}`);

  const targets = [];
  for (const item of expectations) {
    console.log(`Analyzing ${item.expectation.name}: ${item.root}`);
    const startedAt = Date.now();
    const repositories = await analyzeRepositories(item.root, item.expectation);
    const links = buildCrossRepositoryLinks(repositories);
    const contracts = getCrossRepoContracts(repositories);
    const gates = evaluateExpectation(item.expectation, links);
    const status = statusFromGates(gates);
    const score = Math.round(average(gates.map(result => result.score)));
    targets.push({
      name: item.expectation.name,
      status,
      score,
      durationMs: Date.now() - startedAt,
      repositories: repositories.map(repository => ({ name: repository.name, path: repository.path })),
      links,
      contracts,
      gates,
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    status: statusFromGates(targets.flatMap(target => target.gates)),
    score: Math.round(average(targets.map(target => target.score))),
    targets,
  };

  await fs.ensureDir(path.dirname(args.outputPath));
  await fs.writeJson(args.outputPath, report, { spaces: 2 });
  console.log(`Cross-repo contract gauntlet: ${report.status.toUpperCase()} (${report.score}/100)`);
  for (const target of targets) {
    console.log(`${target.status.toUpperCase().padEnd(4)} ${String(target.score).padStart(3)}/100 | ${target.name} | ${target.links.links.length} links | ${Math.round(target.durationMs / 1000)}s`);
    for (const gateValue of target.gates.filter(result => result.status !== 'pass')) {
      console.log(`  - ${gateValue.id}: ${gateValue.detail}`);
    }
  }
  console.log(`Report: ${args.outputPath}`);

  if (report.status === 'fail') process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
