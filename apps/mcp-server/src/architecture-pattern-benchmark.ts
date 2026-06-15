import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { isDirectCliInvocation } from './cli-invocation';
import { createOrchestrator } from './analyzer';

type GateStatus = 'pass' | 'fail';

interface BenchmarkGate {
  id: string;
  status: GateStatus;
  detail: string;
}

interface TargetExpectation {
  fixture: string;
  path?: string;
  requiresPatterns: string[];
  rejectsPatterns?: string[];
  minimumInventory: Record<string, number>;
  expectedPatternBalance?: string;
  maximumPatterns?: number;
}

interface TargetReport {
  fixture: string;
  status: GateStatus;
  score: number;
  patterns: string[];
  inventory: Record<string, number>;
  pattern_balance: string;
  gates: BenchmarkGate[];
}

interface ArchitecturePatternBenchmarkReport {
  generated_at: string;
  status: GateStatus;
  score: number;
  summary: {
    target_count: number;
    targets_passed: number;
    total_gates: number;
    failed_gates: number;
  };
  targets: TargetReport[];
}

const DEFAULT_EXPECTATIONS: TargetExpectation[] = [
  {
    fixture: 'rails-work-orders',
    requiresPatterns: ['MVC', 'Layered Architecture'],
    rejectsPatterns: ['Command Script / Automation'],
    minimumInventory: { models: 2, controllers: 2 },
    maximumPatterns: 4,
  },
  {
    fixture: 'nest-react-prisma',
    requiresPatterns: ['MVC', 'Layered Architecture', 'Service Layer', 'Component/Page UI'],
    rejectsPatterns: ['Command Script / Automation'],
    minimumInventory: { models: 1, controllers: 2, services: 1, views: 1 },
    maximumPatterns: 8,
  },
  {
    fixture: 'flutter-mobile-flow',
    requiresPatterns: ['Component/Page UI'],
    rejectsPatterns: ['MVC', 'Command Script / Automation'],
    minimumInventory: { views: 3 },
    maximumPatterns: 3,
  },
  {
    fixture: 'dotnet-message-worker',
    requiresPatterns: ['Mediator / Handler', 'Command Script / Automation'],
    minimumInventory: { mediators: 1, scripts: 1 },
    maximumPatterns: 5,
  },
  {
    fixture: 'nextjs-app-router',
    requiresPatterns: ['Component/Page UI'],
    rejectsPatterns: ['MVC', 'Command Script / Automation'],
    minimumInventory: { views: 2, controllers: 1 },
    maximumPatterns: 3,
  },
];

export async function runArchitecturePatternBenchmark(options: { outputPath?: string; markdownPath?: string } = {}): Promise<ArchitecturePatternBenchmarkReport> {
  const fixtureRoot = path.join(process.cwd(), 'fixtures', 'analysis-truth');
  const generatedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-architecture-patterns-'));
  const orchestrator = createOrchestrator();
  const targets: TargetReport[] = [];

  try {
    const expectations = [
      ...DEFAULT_EXPECTATIONS,
      await seedMixedArchitectureFixture(generatedRoot),
      await seedFragmentedArchitectureFixture(path.join(generatedRoot, 'fragmented')),
    ];

    for (const expectation of expectations) {
      const fixturePath = expectation.path || path.join(fixtureRoot, expectation.fixture);
      const cas = await orchestrator.orchestrateAnalysis(fixturePath);
      const architecture = (cas.architecture_summary || {}) as any;
      const patterns = (architecture.architectural_patterns || []).map((pattern: any) => String(pattern.name || pattern.pattern || ''));
      const inventory = Object.fromEntries(
        Object.entries(architecture.architectural_inventory || {}).map(([key, value]) => [key, Array.isArray(value) ? value.length : 0])
      ) as Record<string, number>;
      const gates = architectureGates(expectation, patterns, inventory, String(architecture.pattern_balance?.status || 'missing'));
      const passed = gates.filter(item => item.status === 'pass').length;
      targets.push({
        fixture: expectation.fixture,
        status: passed === gates.length ? 'pass' : 'fail',
        score: Math.round((passed / gates.length) * 100),
        patterns,
        inventory,
        pattern_balance: String(architecture.pattern_balance?.status || 'missing'),
        gates,
      });
    }
  } finally {
    await fs.remove(generatedRoot);
  }

  const totalGates = targets.reduce((sum, target) => sum + target.gates.length, 0);
  const failedGates = targets.reduce((sum, target) => sum + target.gates.filter(gate => gate.status !== 'pass').length, 0);
  const passedTargets = targets.filter(target => target.status === 'pass').length;
  const report: ArchitecturePatternBenchmarkReport = {
    generated_at: new Date().toISOString(),
    status: failedGates === 0 ? 'pass' : 'fail',
    score: Math.round(((totalGates - failedGates) / totalGates) * 100),
    summary: {
      target_count: targets.length,
      targets_passed: passedTargets,
      total_gates: totalGates,
      failed_gates: failedGates,
    },
    targets,
  };

  if (options.outputPath) {
    await fs.ensureDir(path.dirname(options.outputPath));
    await fs.writeJson(options.outputPath, report, { spaces: 2 });
  }
  if (options.markdownPath) {
    await fs.ensureDir(path.dirname(options.markdownPath));
    await fs.writeFile(options.markdownPath, renderMarkdown(report));
  }

  return report;
}

async function seedMixedArchitectureFixture(root: string): Promise<TargetExpectation> {
  await fs.outputJson(path.join(root, 'package.json'), {
    name: 'architecture-pattern-proof',
    dependencies: {
      '@types/react': '^18.0.0',
      typescript: '^5.0.0',
    },
  });
  await fs.outputJson(path.join(root, 'tsconfig.json'), {
    compilerOptions: { jsx: 'react-jsx', target: 'ES2022', module: 'ESNext' },
  });
  await fs.outputFile(path.join(root, 'src/orders/Order.ts'), [
    'export interface Order { id: string; totalCents: number; status: "draft" | "submitted"; }',
    'export interface OrderLine { sku: string; quantity: number; }',
  ].join('\n'));
  await fs.outputFile(path.join(root, 'src/orders/OrderRepository.ts'), [
    'import type { Order } from "./Order";',
    'export class OrderRepository {',
    '  async save(order: Order): Promise<Order> { return order; }',
    '  async findById(id: string): Promise<Order | undefined> { return undefined; }',
    '}',
  ].join('\n'));
  await fs.outputFile(path.join(root, 'src/orders/OrderUnitOfWork.ts'), [
    'import { OrderRepository } from "./OrderRepository";',
    'export class OrderUnitOfWork {',
    '  constructor(readonly orders: OrderRepository) {}',
    '  async commit(): Promise<void> {}',
    '}',
  ].join('\n'));
  await fs.outputFile(path.join(root, 'src/orders/SubmitOrderCommandHandler.ts'), [
    'import type { Order } from "./Order";',
    'import { OrderUnitOfWork } from "./OrderUnitOfWork";',
    'export class SubmitOrderCommandHandler {',
    '  constructor(private readonly unitOfWork: OrderUnitOfWork) {}',
    '  async handle(order: Order): Promise<Order> {',
    '    const submitted = { ...order, status: "submitted" as const };',
    '    await this.unitOfWork.orders.save(submitted);',
    '    await this.unitOfWork.commit();',
    '    return submitted;',
    '  }',
    '}',
  ].join('\n'));
  await fs.outputFile(path.join(root, 'src/orders/OrderViewModel.ts'), [
    'import type { Order } from "./Order";',
    'export class OrderViewModel {',
    '  constructor(readonly order: Order) {}',
    '  get canSubmit(): boolean { return this.order.status === "draft"; }',
    '}',
  ].join('\n'));
  await fs.outputFile(path.join(root, 'src/orders/OrderView.tsx'), [
    'import { OrderViewModel } from "./OrderViewModel";',
    'export function OrderView({ viewModel }: { viewModel: OrderViewModel }) {',
    '  return <button disabled={!viewModel.canSubmit}>Submit order</button>;',
    '}',
  ].join('\n'));
  await fs.outputFile(path.join(root, 'src/core/ServiceRegistry.ts'), [
    'import { OrderRepository } from "../orders/OrderRepository";',
    'import { OrderUnitOfWork } from "../orders/OrderUnitOfWork";',
    'export class ServiceRegistry {',
    '  private static instance: ServiceRegistry | undefined;',
    '  readonly orders = new OrderRepository();',
    '  readonly unitOfWork = new OrderUnitOfWork(this.orders);',
    '  static getInstance(): ServiceRegistry {',
    '    this.instance ??= new ServiceRegistry();',
    '    return this.instance;',
    '  }',
    '}',
  ].join('\n'));

  return {
    fixture: 'mixed-architecture-pattern-proof',
    path: root,
    requiresPatterns: ['MVVM', 'Repository', 'Mediator / Handler', 'Unit of Work', 'Singleton / Registry'],
    minimumInventory: {
      models: 1,
      views: 1,
      view_models: 1,
      repositories: 1,
      mediators: 1,
      unit_of_work: 1,
      singletons: 1,
    },
    maximumPatterns: 10,
  };
}

async function seedFragmentedArchitectureFixture(root: string): Promise<TargetExpectation> {
  await fs.outputJson(path.join(root, 'package.json'), {
    name: 'architecture-pattern-drift-proof',
    dependencies: {
      '@types/react': '^18.0.0',
      typescript: '^5.0.0',
    },
  });
  await fs.outputFile(path.join(root, 'src/legacy/models/Invoice.ts'), [
    'export interface Invoice { id: string; totalCents: number; }',
  ].join('\n'));
  await fs.outputFile(path.join(root, 'src/legacy/controllers/InvoiceController.ts'), [
    'import type { Invoice } from "../models/Invoice";',
    'export class InvoiceController {',
    '  show(invoice: Invoice) { return invoice; }',
    '}',
  ].join('\n'));
  await fs.outputFile(path.join(root, 'src/legacy/views/InvoiceView.tsx'), [
    'import type { Invoice } from "../models/Invoice";',
    'export function InvoiceView({ invoice }: { invoice: Invoice }) {',
    '  return <section>{invoice.id}</section>;',
    '}',
  ].join('\n'));
  await fs.outputFile(path.join(root, 'src/desktop/BillingViewModel.ts'), [
    'export class BillingViewModel {',
    '  readonly canExport = true;',
    '}',
  ].join('\n'));
  await fs.outputFile(path.join(root, 'src/desktop/BillingView.tsx'), [
    'import { BillingViewModel } from "./BillingViewModel";',
    'export function BillingView({ viewModel }: { viewModel: BillingViewModel }) {',
    '  return <button disabled={!viewModel.canExport}>Export</button>;',
    '}',
  ].join('\n'));
  await fs.outputFile(path.join(root, 'scripts/reconcile.ts'), [
    'export async function main() {',
    '  return "reconciled";',
    '}',
  ].join('\n'));
  await fs.outputFile(path.join(root, 'src/shared/ServiceRegistry.ts'), [
    'export class ServiceRegistry {',
    '  private static instance: ServiceRegistry | undefined;',
    '  static getInstance(): ServiceRegistry {',
    '    this.instance ??= new ServiceRegistry();',
    '    return this.instance;',
    '  }',
    '}',
  ].join('\n'));

  return {
    fixture: 'fragmented-architecture-drift-proof',
    path: root,
    requiresPatterns: ['MVC', 'MVVM', 'Singleton / Registry'],
    minimumInventory: {
      models: 1,
      views: 2,
      controllers: 1,
      view_models: 1,
      singletons: 1,
    },
    expectedPatternBalance: 'mixed',
    maximumPatterns: 6,
  };
}

function architectureGates(
  expectation: TargetExpectation,
  patterns: string[],
  inventory: Record<string, number>,
  patternBalance: string
): BenchmarkGate[] {
  const gates: BenchmarkGate[] = [];
  for (const pattern of expectation.requiresPatterns) {
    gates.push(gate(
      `${expectation.fixture}:pattern:${pattern}`,
      patterns.includes(pattern),
      patterns.includes(pattern) ? `found ${pattern}` : `missing ${pattern}; found ${patterns.join(', ') || 'none'}`
    ));
  }
  for (const pattern of expectation.rejectsPatterns || []) {
    gates.push(gate(
      `${expectation.fixture}:reject:${pattern}`,
      !patterns.includes(pattern),
      patterns.includes(pattern) ? `unexpected ${pattern}` : `absent ${pattern}`
    ));
  }
  for (const [key, minimum] of Object.entries(expectation.minimumInventory)) {
    const count = Number(inventory[key] || 0);
    gates.push(gate(
      `${expectation.fixture}:inventory:${key}`,
      count >= minimum,
      `${count}/${minimum} ${key}`
    ));
  }
  gates.push(gate(
    `${expectation.fixture}:pattern-balance`,
    expectation.expectedPatternBalance
      ? patternBalance === expectation.expectedPatternBalance
      : patternBalance !== 'over-patterned',
    expectation.expectedPatternBalance
      ? `pattern balance ${patternBalance}; expected ${expectation.expectedPatternBalance}`
      : `pattern balance ${patternBalance}`
  ));
  if (expectation.maximumPatterns) {
    gates.push(gate(
      `${expectation.fixture}:no-pattern-splurge`,
      patterns.length <= expectation.maximumPatterns,
      `${patterns.length}/${expectation.maximumPatterns} patterns: ${patterns.join(', ') || 'none'}`
    ));
  }
  return gates;
}

function gate(id: string, condition: boolean, detail: string): BenchmarkGate {
  return {
    id,
    status: condition ? 'pass' : 'fail',
    detail,
  };
}

function renderMarkdown(report: ArchitecturePatternBenchmarkReport): string {
  const lines = [
    `# Architecture Pattern Benchmark`,
    '',
    `Status: **${report.status.toUpperCase()}** (${report.score}/100)`,
    '',
    `Targets: ${report.summary.targets_passed}/${report.summary.target_count}`,
    `Gates: ${report.summary.total_gates - report.summary.failed_gates}/${report.summary.total_gates}`,
    '',
  ];

  for (const target of report.targets) {
    lines.push(`## ${target.fixture}`, '');
    lines.push(`Status: **${target.status.toUpperCase()}** (${target.score}/100)`);
    lines.push(`Patterns: ${target.patterns.join(', ') || 'none'}`);
    lines.push(`Inventory: ${Object.entries(target.inventory).filter(([, count]) => count > 0).map(([key, count]) => `${key} ${count}`).join(', ') || 'none'}`);
    lines.push('');
    for (const item of target.gates) {
      lines.push(`- ${item.status === 'pass' ? 'PASS' : 'FAIL'} ${item.id}: ${item.detail}`);
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function parseArgs(argv: string[]): { outputPath: string; markdownPath: string } {
  let outputPath = path.join(process.cwd(), '.klauro-architecture-pattern-benchmark', 'latest-report.json');
  let markdownPath = path.join(process.cwd(), '.klauro-architecture-pattern-benchmark', 'latest-report.md');
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--output') {
      outputPath = path.resolve(argv[++i]);
    } else if (arg === '--markdown') {
      markdownPath = path.resolve(argv[++i]);
    } else if (arg === '--help' || arg === '-h') {
      console.log([
        'Usage: npm run architecture-pattern-benchmark -- [options]',
        '',
        'Options:',
        '  --output /path/report.json    Write JSON report.',
        '  --markdown /path/report.md    Write Markdown report.',
      ].join('\n'));
      process.exit(0);
    }
  }
  return { outputPath, markdownPath };
}

if (isDirectCliInvocation('architecture-pattern-benchmark')) {
  const args = parseArgs(process.argv.slice(2));
  runArchitecturePatternBenchmark(args).then(report => {
    console.log(`Architecture pattern benchmark: ${report.status.toUpperCase()} (${report.score}/100)`);
    for (const target of report.targets) {
      console.log(`${target.status.toUpperCase().padEnd(4)} ${String(target.score).padStart(3)}/100 | ${target.fixture} | ${target.patterns.join(', ') || 'none'}`);
      for (const failed of target.gates.filter(item => item.status !== 'pass')) {
        console.log(`  - ${failed.id}: ${failed.detail}`);
      }
    }
    if (report.status !== 'pass') process.exitCode = 1;
  }).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
