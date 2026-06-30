import * as fs from 'fs-extra';
import * as path from 'path';
import { execFileSync, spawn } from 'child_process';
import { isDirectCliInvocation } from './cli-invocation';

const OUTPUT_ROOT = '/tmp/klauro-scale-curve';
const STORAGE_ROOT = path.join(OUTPUT_ROOT, 'storage');
const WORK_ROOT = path.join(OUTPUT_ROOT, 'work');
const GIANT_ROOT = path.join(OUTPUT_ROOT, 'giant-monorepo');
const RESULT_MARKER = 'KLAURO_SCALE_RESULT_JSON:';
const APP_DIR = path.resolve(__dirname, '..');

const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rb', '.erb', '.php', '.java', '.cs', '.go', '.rs', '.dart', '.html', '.scss', '.css',
]);

const EXCLUDED_DIRECTORIES = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.angular', 'coverage',
  'vendor', 'tmp', 'log', 'public/assets', '.klauro',
]);

interface TierDefinition {
  id: string;
  label: string;
  resolvePath: () => Promise<string>;
}

interface FullAnalysisChildResult {
  wallMs: number;
  nodes: number;
  edges: number;
  entryPoints: number;
  exitPoints: number;
  finalRssBytes: number;
  phaseTimings: Record<string, number> | null;
}

interface IncrementalEditSample {
  file: string;
  ms: number;
  wasFullRebuild: boolean;
  fullRebuildReason?: string;
  filesModified: number;
  nodesModified: number;
}

interface IncrementalChildResult {
  initialFullMs: number;
  noChangeMs: number;
  edits: IncrementalEditSample[];
  forcedFullRebuild: {
    ms: number;
    wasFullRebuild: boolean;
    fullRebuildReason?: string;
  } | null;
  finalRssBytes: number;
}

interface TierReport {
  tier: string;
  label: string;
  path: string;
  sourceFiles: number;
  totalFiles: number;
  nodes: number;
  edges: number;
  fullAnalysisMs: number;
  peakRssBytes: number;
  phaseTimings: Record<string, number> | null;
}

interface IncrementalReport {
  tier: string;
  workspace: string;
  initialFullMs: number;
  noChangeMs: number;
  editSamples: IncrementalEditSample[];
  editP50Ms: number;
  editP95Ms: number;
  unexpectedFullRebuilds: number;
  forcedFullRebuildMs: number | null;
  forcedFullRebuildTriggered: boolean;
  peakRssBytes: number;
}

function benchmarkEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    KLAURO_STORAGE_PATH: STORAGE_ROOT,
    KLAURO_AI_INTERPRETATION: 'false',
    KLAURO_AI_ELEMENT_DESCRIPTIONS: 'false',
    KLAURO_EMBEDDING_ENABLED: 'false',
    KLAURO_DEBUG_ANALYSIS_TIMINGS: '1',
    KLAURO_DEBUG_TS_ANALYZER_TIMINGS: '1',
    KLAURO_FRESH_ORCHESTRATOR_PER_ANALYSIS: '0',
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --max-old-space-size=12288`.trim(),
  };
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pascalCase(value: string): string {
  return value.replace(/(?:^|[-_])(\w)/g, (_, ch: string) => ch.toUpperCase());
}

const DOMAIN_WORDS = [
  'order', 'invoice', 'shipment', 'driver', 'vehicle', 'route', 'customer', 'account',
  'payment', 'inspection', 'maintenance', 'fuel', 'trip', 'alert', 'report', 'document',
  'location', 'device', 'sensor', 'schedule', 'contract', 'quote', 'claim', 'audit',
];

function entityName(random: () => number, packageIndex: number, moduleIndex: number): string {
  const word = DOMAIN_WORDS[Math.floor(random() * DOMAIN_WORDS.length)];
  return `${pascalCase(word)}P${packageIndex}M${moduleIndex}`;
}

function backendModuleFiles(entity: string): Record<string, string> {
  const lower = entity.toLowerCase();
  return {
    [`${lower}.entity.ts`]: `import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity()
export class ${entity} {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ default: 'active' })
  status: string;

  @Column({ type: 'timestamp', nullable: true })
  processedAt: Date | null;
}
`,
    [`${lower}.service.ts`]: `import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ${entity} } from './${lower}.entity';

export interface Create${entity}Input {
  name: string;
  status?: string;
}

@Injectable()
export class ${entity}Service {
  constructor(
    @InjectRepository(${entity})
    private readonly repository: Repository<${entity}>,
  ) {}

  findOne(id: string) {
    return this.repository.findOne({ where: { id } });
  }

  findActive() {
    return this.repository.find({ where: { status: 'active' } });
  }

  async create(input: Create${entity}Input) {
    const record = this.repository.create({ name: input.name, status: input.status ?? 'active' });
    return this.repository.save(record);
  }

  async markProcessed(id: string) {
    const record = await this.findOne(id);
    if (!record) return null;
    record.processedAt = new Date();
    return this.repository.save(record);
  }
}
`,
    [`${lower}.controller.ts`]: `import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { Create${entity}Input, ${entity}Service } from './${lower}.service';

@Controller('${lower}')
export class ${entity}Controller {
  constructor(private readonly service: ${entity}Service) {}

  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Get()
  listActive() {
    return this.service.findActive();
  }

  @Post()
  create(@Body() input: Create${entity}Input) {
    return this.service.create(input);
  }

  @Put(':id/process')
  process(@Param('id') id: string) {
    return this.service.markProcessed(id);
  }
}
`,
    [`${lower}.module.ts`]: `import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ${entity} } from './${lower}.entity';
import { ${entity}Service } from './${lower}.service';
import { ${entity}Controller } from './${lower}.controller';

@Module({
  imports: [TypeOrmModule.forFeature([${entity}])],
  providers: [${entity}Service],
  controllers: [${entity}Controller],
  exports: [${entity}Service],
})
export class ${entity}Module {}
`,
    [`${lower}.service.spec.ts`]: `import { ${entity}Service } from './${lower}.service';

describe('${entity}Service', () => {
  it('creates a record with default status', async () => {
    const saved: unknown[] = [];
    const service = new ${entity}Service({
      create: (input: object) => input,
      save: async (record: object) => { saved.push(record); return record; },
      find: async () => [],
      findOne: async () => null,
    } as never);
    await service.create({ name: 'fixture' });
    expect(saved).toHaveLength(1);
  });
});
`,
  };
}

function frontendComponentFiles(entity: string, siblingEntity: string): Record<string, string> {
  const lower = entity.toLowerCase();
  const siblingLower = siblingEntity.toLowerCase();
  return {
    [`use${entity}.ts`]: `import { useQuery } from '@tanstack/react-query';

export interface ${entity}Record {
  id: string;
  name: string;
  status: string;
}

export function use${entity}(id: string) {
  return useQuery<${entity}Record>({
    queryKey: ['${lower}', id],
    queryFn: () => fetch(\`/api/${lower}/\${id}\`).then(response => response.json()),
  });
}
`,
    [`${entity}Panel.tsx`]: `import { use${entity} } from './use${entity}';
import { ${siblingEntity}Summary } from '../${siblingLower}/${siblingEntity}Summary';

export function ${entity}Panel({ id }: { id: string }) {
  const query = use${entity}(id);
  if (query.isLoading) return <p>Loading ${lower}</p>;
  return (
    <section>
      <h2>{query.data?.name}</h2>
      <p>{query.data?.status}</p>
      <${siblingEntity}Summary compact />
    </section>
  );
}
`,
    [`${entity}Summary.tsx`]: `export function ${entity}Summary({ compact = false }: { compact?: boolean }) {
  return (
    <aside data-compact={compact}>
      <strong>${entity}</strong>
    </aside>
  );
}
`,
  };
}

export interface GiantGenerationOptions {
  packages: number;
  backendModulesPerPackage: number;
  frontendComponentsPerPackage: number;
  seed: number;
}

export const DEFAULT_GIANT_OPTIONS: GiantGenerationOptions = {
  packages: 30,
  backendModulesPerPackage: 550,
  frontendComponentsPerPackage: 900,
  seed: 1337,
};

export async function generateGiantMonorepo(root: string, options: GiantGenerationOptions): Promise<number> {
  await fs.remove(root);
  await fs.ensureDir(root);
  let fileCount = 0;
  const write = async (relative: string, content: string) => {
    const absolute = path.join(root, relative);
    await fs.ensureDir(path.dirname(absolute));
    await fs.writeFile(absolute, content, 'utf-8');
    fileCount += 1;
  };

  const workspaceNames: string[] = [];
  for (let p = 0; p < options.packages; p++) {
    workspaceNames.push(`packages/pkg-${String(p).padStart(2, '0')}`);
  }

  await write('package.json', JSON.stringify({
    name: 'klauro-scale-giant',
    private: true,
    version: '1.0.0',
    workspaces: workspaceNames,
    dependencies: {
      '@nestjs/common': '10.0.0',
      '@nestjs/core': '10.0.0',
      '@nestjs/typeorm': '10.0.0',
      '@tanstack/react-query': '5.0.0',
      react: '18.0.0',
      'react-dom': '18.0.0',
      typeorm: '0.3.17',
    },
    devDependencies: { jest: '29.0.0', typescript: '5.0.0' },
  }, null, 2));
  await write('tsconfig.json', JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'commonjs',
      jsx: 'react-jsx',
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      strict: true,
    },
  }, null, 2));

  for (let p = 0; p < options.packages; p++) {
    const packageRoot = workspaceNames[p];
    const random = mulberry32(options.seed + p * 7919);
    await write(`${packageRoot}/package.json`, JSON.stringify({
      name: `@giant/pkg-${String(p).padStart(2, '0')}`,
      version: '1.0.0',
      private: true,
    }, null, 2));

    const backendEntities: string[] = [];
    for (let m = 0; m < options.backendModulesPerPackage; m++) {
      const entity = entityName(random, p, m);
      backendEntities.push(entity);
      const files = backendModuleFiles(entity);
      for (const [name, content] of Object.entries(files)) {
        await write(`${packageRoot}/src/backend/${entity.toLowerCase()}/${name}`, content);
      }
    }

    const moduleImports = backendEntities.slice(0, 50).map(entity =>
      `import { ${entity}Module } from './${entity.toLowerCase()}/${entity.toLowerCase()}.module';`,
    ).join('\n');
    const moduleList = backendEntities.slice(0, 50).map(entity => `${entity}Module`).join(', ');
    await write(`${packageRoot}/src/backend/app.module.ts`, `import { Module } from '@nestjs/common';
${moduleImports}

@Module({
  imports: [${moduleList}],
})
export class AppModule {}
`);

    const frontendEntities: string[] = [];
    for (let c = 0; c < options.frontendComponentsPerPackage; c++) {
      frontendEntities.push(`${entityName(random, p, c)}View${c}`);
    }
    for (let c = 0; c < options.frontendComponentsPerPackage; c++) {
      const entity = frontendEntities[c];
      const sibling = frontendEntities[(c + 1) % frontendEntities.length];
      const files = frontendComponentFiles(entity, sibling);
      for (const [name, content] of Object.entries(files)) {
        await write(`${packageRoot}/src/frontend/${entity.toLowerCase()}/${name}`, content);
      }
    }
  }

  return fileCount;
}

function countFiles(root: string): { totalFiles: number; sourceFiles: number } {
  let totalFiles = 0;
  let sourceFiles = 0;
  const walk = (directory: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(path.join(directory, entry.name));
      } else if (entry.isFile()) {
        totalFiles += 1;
        if (SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
          sourceFiles += 1;
        }
      }
    }
  };
  walk(root);
  return { totalFiles, sourceFiles };
}

interface SpawnResult {
  result: unknown;
  peakRssBytes: number;
  stderrTail: string;
}

async function runChild(args: string[], timeoutMs: number): Promise<SpawnResult> {
  const tsxBin = path.join(APP_DIR, 'node_modules', '.bin', 'tsx');
  const scriptPath = path.join(APP_DIR, 'src', 'analysis-scale-benchmark.ts');
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/time', ['-l', tsxBin, scriptPath, ...args], {
      cwd: APP_DIR,
      env: benchmarkEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Child timed out after ${timeoutMs}ms: ${args.join(' ')}`));
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => {
      stderr += chunk;
      if (stderr.length > 4_000_000) stderr = stderr.slice(-2_000_000);
    });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      const markerLine = stdout.split('\n').find(line => line.startsWith(RESULT_MARKER));
      if (code !== 0 || !markerLine) {
        reject(new Error(`Child failed (code ${code}) for ${args.join(' ')}\nstderr tail:\n${stderr.slice(-4000)}`));
        return;
      }
      const rssMatch = stderr.match(/(\d+)\s+maximum resident set size/);
      resolve({
        result: JSON.parse(markerLine.slice(RESULT_MARKER.length)),
        peakRssBytes: rssMatch ? Number(rssMatch[1]) : 0,
        stderrTail: stderr.slice(-8000),
      });
    });
  });
}

function capturePhaseTimings(): () => Record<string, number> | null {
  let captured: Record<string, number> | null = null;
  let tsCaptured: Record<string, number> | null = null;
  const originalError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && typeof args[1] === 'string') {
      if (args[0].startsWith('[Klauro] Analysis completed in')) {
        try {
          captured = JSON.parse(args[1]);
        } catch {
          captured = null;
        }
      } else if (args[0].startsWith('[Klauro] TypeScript/JavaScript analyzer completed')) {
        try {
          tsCaptured = JSON.parse(args[1]);
        } catch {
          tsCaptured = null;
        }
      }
    }
    originalError(...args);
  };
  return () => {
    if (!captured && !tsCaptured) return null;
    const merged: Record<string, number> = { ...(captured || {}) };
    for (const [key, value] of Object.entries(tsCaptured || {})) {
      if (typeof value === 'number' && !['filesAnalyzed', 'nodes', 'edges'].includes(key)) {
        merged[`ts_${key}`] = value;
      }
    }
    return merged;
  };
}

async function childFullAnalysis(projectPath: string): Promise<void> {
  const { analyzeForBench } = await import('./gauntlet/product-analysis');
  const readTimings = capturePhaseTimings();
  const startedAt = Date.now();
  const output = await analyzeForBench(projectPath);
  const wallMs = Date.now() - startedAt;
  const result: FullAnalysisChildResult = {
    wallMs,
    nodes: output.nodes.length,
    edges: output.edges.length,
    entryPoints: output.entry_points?.length || 0,
    exitPoints: output.exit_points?.length || 0,
    finalRssBytes: process.memoryUsage().rss,
    phaseTimings: readTimings(),
  };
  process.stdout.write(`${RESULT_MARKER}${JSON.stringify(result)}\n`);
}

function probeForExtension(extension: string, index: number): string | null {
  switch (extension) {
    case '.ts':
    case '.tsx':
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
    case '.php':
    case '.java':
    case '.cs':
    case '.go':
    case '.rs':
    case '.dart':
      return `// analysis probe: scale-edit-${index}`;
    case '.py':
    case '.rb':
      return `# analysis probe: scale-edit-${index}`;
    default:
      return null;
  }
}

function isEditableProductFile(relativeFile: string): boolean {
  const normalized = relativeFile.replace(/\\/g, '/');
  if (normalized.includes('node_modules/') || normalized.includes('.git/')) return false;
  if (/\.(spec|test)\./.test(normalized) || /(^|\/)(tests?|__tests__|spec)\//.test(normalized)) return false;
  if (/(^|\/)(dist|build|vendor|coverage|migrations)\//.test(normalized)) return false;
  const extension = path.extname(normalized).toLowerCase();
  return probeForExtension(extension, 0) !== null;
}

async function childIncremental(workspace: string, editCount: number): Promise<void> {
  const { analyzeProjectIncremental } = await import('./analyzer');

  let startedAt = Date.now();
  const initial = await analyzeProjectIncremental(workspace);
  const initialFullMs = Date.now() - startedAt;

  startedAt = Date.now();
  await analyzeProjectIncremental(workspace);
  const noChangeMs = Date.now() - startedAt;

  const candidateFiles: string[] = [];
  const seen = new Set<string>();
  for (const node of initial.output.nodes) {
    const file = node.source?.file;
    if (!file || seen.has(file)) continue;
    seen.add(file);
    if (!isEditableProductFile(file)) continue;
    if (!fs.existsSync(path.join(workspace, file))) continue;
    candidateFiles.push(file);
  }
  candidateFiles.sort();
  const stride = Math.max(1, Math.floor(candidateFiles.length / Math.max(editCount, 1)));
  const editFiles: string[] = [];
  for (let i = 0; i < candidateFiles.length && editFiles.length < editCount; i += stride) {
    editFiles.push(candidateFiles[i]);
  }

  const edits: IncrementalEditSample[] = [];
  for (let i = 0; i < editFiles.length; i++) {
    const relativeFile = editFiles[i];
    const absolute = path.join(workspace, relativeFile);
    const probe = probeForExtension(path.extname(relativeFile).toLowerCase(), i);
    const content = await fs.readFile(absolute, 'utf-8');
    await fs.writeFile(absolute, `${content.replace(/\s+$/u, '')}\n\n${probe}\n`, 'utf-8');

    startedAt = Date.now();
    const result = await analyzeProjectIncremental(workspace);
    edits.push({
      file: relativeFile,
      ms: Date.now() - startedAt,
      wasFullRebuild: result.wasFullRebuild,
      fullRebuildReason: result.fullRebuildReason,
      filesModified: result.changeReport.summary.filesModified + result.changeReport.summary.filesAdded,
      nodesModified: result.changeReport.summary.nodesModified,
    });
  }

  let forcedFullRebuild: IncrementalChildResult['forcedFullRebuild'] = null;
  const rootPackageJson = path.join(workspace, 'package.json');
  const structuralFile = fs.existsSync(rootPackageJson)
    ? rootPackageJson
    : path.join(workspace, fs.existsSync(path.join(workspace, 'composer.json')) ? 'composer.json' : 'package.json');
  if (fs.existsSync(structuralFile)) {
    const manifest = await fs.readJson(structuralFile);
    manifest.description = `${manifest.description || ''} scale-benchmark-structural-probe`.trim();
    await fs.writeJson(structuralFile, manifest, { spaces: 2 });
    startedAt = Date.now();
    const result = await analyzeProjectIncremental(workspace);
    forcedFullRebuild = {
      ms: Date.now() - startedAt,
      wasFullRebuild: result.wasFullRebuild,
      fullRebuildReason: result.fullRebuildReason,
    };
  }

  const result: IncrementalChildResult = {
    initialFullMs,
    noChangeMs,
    edits,
    forcedFullRebuild,
    finalRssBytes: process.memoryUsage().rss,
  };
  process.stdout.write(`${RESULT_MARKER}${JSON.stringify(result)}\n`);
}

async function childGenerateGiant(root: string, options: GiantGenerationOptions): Promise<void> {
  const startedAt = Date.now();
  const fileCount = await generateGiantMonorepo(root, options);
  process.stdout.write(`${RESULT_MARKER}${JSON.stringify({ fileCount, wallMs: Date.now() - startedAt })}\n`);
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function formatBytes(bytes: number): string {
  if (!bytes) return 'n/a';
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

async function copyWorkspace(source: string, destination: string): Promise<void> {
  await fs.remove(destination);
  await fs.ensureDir(path.dirname(destination));
  const excludes = ['node_modules', '.git', 'dist', 'build', '.next', '.angular', 'coverage', 'log', 'tmp', '.klauro'];
  execFileSync('rsync', [
    '-a',
    ...excludes.flatMap(name => ['--exclude', name]),
    `${source}/`,
    `${destination}/`,
  ], { stdio: 'ignore', maxBuffer: 1024 * 1024 * 64 });
}

function initializeGitBaseline(workspace: string): void {
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Klauro Scale Benchmark',
    GIT_AUTHOR_EMAIL: 'benchmark@klauro.local',
    GIT_COMMITTER_NAME: 'Klauro Scale Benchmark',
    GIT_COMMITTER_EMAIL: 'benchmark@klauro.local',
  };
  execFileSync('git', ['init'], { cwd: workspace, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: workspace, stdio: 'ignore', maxBuffer: 1024 * 1024 * 256 });
  execFileSync('git', ['commit', '-m', 'scale benchmark baseline', '--quiet'], {
    cwd: workspace,
    env: gitEnv,
    stdio: 'ignore',
    maxBuffer: 1024 * 1024 * 256,
  });
}

function tierDefinitions(giantOptions: GiantGenerationOptions): TierDefinition[] {
  const home = process.env.HOME || '';
  return [
    {
      id: 'tiny',
      label: 'rails-work-orders fixture',
      resolvePath: async () => path.join(APP_DIR, 'fixtures', 'analysis-truth', 'rails-work-orders'),
    },
    {
      id: 'small',
      label: 'washup (Rails)',
      resolvePath: async () => path.join(home, 'dev/clients/outcode/washup'),
    },
    {
      id: 'medium',
      label: 'truckspyui (Angular)',
      resolvePath: async () => path.join(home, 'dev/clients/outcode/truckspy/truckspyui'),
    },
    {
      id: 'large',
      label: 'truckspyapp (PHP)',
      resolvePath: async () => path.join(home, 'dev/clients/outcode/truckspy/truckspyapp'),
    },
    {
      id: 'giant',
      label: `synthetic monorepo (${giantOptions.packages} pkgs, NestJS + React)`,
      resolvePath: async () => {
        const marker = path.join(GIANT_ROOT, '.generation-complete.json');
        const expected = JSON.stringify(giantOptions);
        if (await fs.pathExists(marker)) {
          const existing = await fs.readFile(marker, 'utf-8');
          if (existing === expected) return GIANT_ROOT;
        }
        console.log(`[scale] generating synthetic giant monorepo at ${GIANT_ROOT} ...`);
        const generation = await runChild(['--child-generate-giant', GIANT_ROOT, '--giant-options', expected], 60 * 60 * 1000);
        const { fileCount, wallMs } = generation.result as { fileCount: number; wallMs: number };
        console.log(`[scale] generated ${fileCount} files in ${formatSeconds(wallMs)}`);
        await fs.writeFile(marker, expected, 'utf-8');
        return GIANT_ROOT;
      },
    },
  ];
}

function buildReportMarkdown(
  tiers: TierReport[],
  incrementals: IncrementalReport[],
  failures: Array<{ tier: string; error: string }>,
): string {
  const lines: string[] = [];
  lines.push('# Klauro Analysis Scale Curve');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('AI interpretation, AI element descriptions, and embeddings disabled for all runs.');
  lines.push('Peak RSS measured per isolated child process via /usr/bin/time -l.');
  lines.push('');
  lines.push('## Full analysis scale table');
  lines.push('');
  lines.push('| Tier | Repo | Source files | Total files | Nodes | Edges | Full analysis | Peak RSS | ms / source file |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const tier of tiers) {
    const perFile = tier.sourceFiles > 0 ? (tier.fullAnalysisMs / tier.sourceFiles).toFixed(2) : 'n/a';
    lines.push(`| ${tier.tier} | ${tier.label} | ${tier.sourceFiles} | ${tier.totalFiles} | ${tier.nodes} | ${tier.edges} | ${formatSeconds(tier.fullAnalysisMs)} | ${formatBytes(tier.peakRssBytes)} | ${perFile} |`);
  }
  lines.push('');

  if (incrementals.length > 0) {
    lines.push('## Watch-mode incremental latency');
    lines.push('');
    lines.push('| Tier | Initial full+state | No-change run | Edits | Edit p50 | Edit p95 | Unexpected full rebuilds | Forced full rebuild | Peak RSS |');
    lines.push('|---|---|---|---|---|---|---|---|---|');
    for (const inc of incrementals) {
      lines.push(`| ${inc.tier} | ${formatSeconds(inc.initialFullMs)} | ${inc.noChangeMs}ms | ${inc.editSamples.length} | ${inc.editP50Ms}ms | ${inc.editP95Ms}ms | ${inc.unexpectedFullRebuilds} | ${inc.forcedFullRebuildMs === null ? 'n/a' : `${formatSeconds(inc.forcedFullRebuildMs)} (triggered: ${inc.forcedFullRebuildTriggered})`} | ${formatBytes(inc.peakRssBytes)} |`);
    }
    lines.push('');
  }

  lines.push('## Phase timing breakdown (top phases per tier)');
  lines.push('');
  for (const tier of tiers) {
    if (!tier.phaseTimings) continue;
    const top = Object.entries(tier.phaseTimings)
      .filter(([phase]) => phase !== 'languageAnalyzers')
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
    lines.push(`### ${tier.tier} (${formatSeconds(tier.fullAnalysisMs)} total)`);
    lines.push('');
    for (const [phase, ms] of top) {
      const share = tier.fullAnalysisMs > 0 ? ((ms / tier.fullAnalysisMs) * 100).toFixed(1) : '0';
      lines.push(`- ${phase}: ${formatSeconds(ms)} (${share}%)`);
    }
    lines.push('');
  }

  if (failures.length > 0) {
    lines.push('## Failures');
    lines.push('');
    for (const failure of failures) {
      lines.push(`- ${failure.tier}: ${failure.error}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function runOrchestrator(argv: string[]): Promise<void> {
  const tiersArg = readFlag(argv, '--tiers');
  const editCount = Number(readFlag(argv, '--edits') || '20');
  const incrementalTier = readFlag(argv, '--incremental-tier') || 'large';
  const giantPackages = Number(readFlag(argv, '--giant-packages') || String(DEFAULT_GIANT_OPTIONS.packages));
  const giantOptions: GiantGenerationOptions = {
    ...DEFAULT_GIANT_OPTIONS,
    packages: giantPackages,
  };
  const requestedTiers = tiersArg ? tiersArg.split(',').map(value => value.trim()) : ['tiny', 'small', 'medium', 'large', 'giant'];

  await fs.ensureDir(OUTPUT_ROOT);
  await fs.ensureDir(STORAGE_ROOT);
  await fs.ensureDir(WORK_ROOT);

  const tierReports: TierReport[] = [];
  const incrementalReports: IncrementalReport[] = [];
  const failures: Array<{ tier: string; error: string }> = [];

  for (const definition of tierDefinitions(giantOptions)) {
    if (!requestedTiers.includes(definition.id)) continue;
    try {
      const repoPath = await definition.resolvePath();
      if (!(await fs.pathExists(repoPath))) {
        throw new Error(`Repo path missing: ${repoPath}`);
      }
      console.log(`[scale] tier ${definition.id}: counting files in ${repoPath}`);
      const counts = countFiles(repoPath);
      console.log(`[scale] tier ${definition.id}: full analysis (${counts.sourceFiles} source files)`);
      const child = await runChild(['--child-full', repoPath], 60 * 60 * 1000);
      const full = child.result as FullAnalysisChildResult;
      const report: TierReport = {
        tier: definition.id,
        label: definition.label,
        path: repoPath,
        sourceFiles: counts.sourceFiles,
        totalFiles: counts.totalFiles,
        nodes: full.nodes,
        edges: full.edges,
        fullAnalysisMs: full.wallMs,
        peakRssBytes: child.peakRssBytes,
        phaseTimings: full.phaseTimings,
      };
      tierReports.push(report);
      console.log(`[scale] tier ${definition.id}: ${formatSeconds(full.wallMs)}, ${full.nodes} nodes, peak RSS ${formatBytes(child.peakRssBytes)}`);

      if (definition.id === incrementalTier) {
        console.log(`[scale] tier ${definition.id}: preparing incremental workspace copy`);
        const workspace = path.join(WORK_ROOT, definition.id);
        await copyWorkspace(repoPath, workspace);
        try {
          initializeGitBaseline(workspace);
        } catch (error) {
          console.warn(`[scale] git baseline failed (${error instanceof Error ? error.message : String(error)}); continuing with hash detection`);
        }
        console.log(`[scale] tier ${definition.id}: incremental edit loop (${editCount} edits)`);
        const incrementalChild = await runChild(['--child-incremental', workspace, '--edits', String(editCount)], 2 * 60 * 60 * 1000);
        const incremental = incrementalChild.result as IncrementalChildResult;
        const nonRebuildLatencies = incremental.edits.filter(edit => !edit.wasFullRebuild).map(edit => edit.ms);
        const latencies = nonRebuildLatencies.length > 0 ? nonRebuildLatencies : incremental.edits.map(edit => edit.ms);
        incrementalReports.push({
          tier: definition.id,
          workspace,
          initialFullMs: incremental.initialFullMs,
          noChangeMs: incremental.noChangeMs,
          editSamples: incremental.edits,
          editP50Ms: percentile(latencies, 0.5),
          editP95Ms: percentile(latencies, 0.95),
          unexpectedFullRebuilds: incremental.edits.filter(edit => edit.wasFullRebuild).length,
          forcedFullRebuildMs: incremental.forcedFullRebuild?.ms ?? null,
          forcedFullRebuildTriggered: incremental.forcedFullRebuild?.wasFullRebuild ?? false,
          peakRssBytes: incrementalChild.peakRssBytes,
        });
        console.log(`[scale] tier ${definition.id}: edit p50 ${percentile(latencies, 0.5)}ms p95 ${percentile(latencies, 0.95)}ms`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[scale] tier ${definition.id} FAILED: ${message}`);
      failures.push({ tier: definition.id, error: message });
    }
  }

  const reportPath = path.join(OUTPUT_ROOT, 'report.md');
  const rawPath = path.join(OUTPUT_ROOT, 'raw-results.json');
  const merged = await mergeWithPreviousResults(rawPath, tierReports, incrementalReports, failures);
  await fs.writeJson(rawPath, merged, { spaces: 2 });
  await fs.writeFile(reportPath, buildReportMarkdown(merged.tiers, merged.incrementals, merged.failures), 'utf-8');
  console.log(`[scale] report written to ${reportPath}`);
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

const TIER_ORDER = ['tiny', 'small', 'medium', 'large', 'giant'];

async function mergeWithPreviousResults(
  rawPath: string,
  tiers: TierReport[],
  incrementals: IncrementalReport[],
  failures: Array<{ tier: string; error: string }>,
): Promise<{ tiers: TierReport[]; incrementals: IncrementalReport[]; failures: Array<{ tier: string; error: string }> }> {
  let previous: { tiers?: TierReport[]; incrementals?: IncrementalReport[]; failures?: Array<{ tier: string; error: string }> } = {};
  if (await fs.pathExists(rawPath)) {
    try {
      previous = await fs.readJson(rawPath);
    } catch {
      previous = {};
    }
  }
  const tierIds = new Set(tiers.map(tier => tier.tier));
  const failureIds = new Set(failures.map(failure => failure.tier));
  const mergedTiers = [
    ...(previous.tiers || []).filter(tier => !tierIds.has(tier.tier) && !failureIds.has(tier.tier)),
    ...tiers,
  ].sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier));
  const incrementalIds = new Set(incrementals.map(report => report.tier));
  const mergedIncrementals = [
    ...(previous.incrementals || []).filter(report => !incrementalIds.has(report.tier)),
    ...incrementals,
  ].sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier));
  const mergedFailures = [
    ...(previous.failures || []).filter(failure => !tierIds.has(failure.tier) && !failureIds.has(failure.tier)),
    ...failures,
  ];
  return { tiers: mergedTiers, incrementals: mergedIncrementals, failures: mergedFailures };
}

function readFlag(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  if (index === -1 || index + 1 >= argv.length) return null;
  return argv[index + 1];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === '--child-full') {
    await childFullAnalysis(argv[1]);
    return;
  }
  if (argv[0] === '--child-incremental') {
    await childIncremental(argv[1], Number(readFlag(argv, '--edits') || '20'));
    return;
  }
  if (argv[0] === '--child-generate-giant') {
    const optionsJson = readFlag(argv, '--giant-options');
    const options = optionsJson ? JSON.parse(optionsJson) as GiantGenerationOptions : DEFAULT_GIANT_OPTIONS;
    await childGenerateGiant(argv[1], options);
    return;
  }
  await runOrchestrator(argv);
}

if (isDirectCliInvocation('analysis-scale-benchmark')) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
