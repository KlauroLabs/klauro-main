import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { DEFAULT_KLAURO_CLOUD_URL } from './defaults';
import { resolveManifestProjectName } from '../../../packages/analyzer-core/src/analyzer/core/deployable-evidence/util';
import { gitIgnoredPaths } from './git-ignored';

export interface KlauroConfig {
  version: number;
  kind?: 'project' | 'workspace';
  project: {
    name?: string;
    id?: string;
    workspaceId?: string;
    organizationId?: string;






    mainBranch?: string;
  };
  analyzer: {



    serverUrl?: string;
    selfHosted?: boolean;
  };
  source: {
    roots: string[];
    include: string[];
    exclude: string[];
    maxFileBytes: number;
    maxTotalBytes: number;
    followSymlinks: boolean;
    respectGitignore?: boolean;
  };
  upload: {
    mode: 'full' | 'diff-only' | 'manifest-only';
    requireManifestReview: boolean;
    allowDirtyTreeSync: boolean;
    sendGitDiff: boolean;
    sendDeletedPaths: boolean;
  };
  mcp: {
    cachePath?: string;










    preferLocalCache: boolean;
  };
  policy: {
    allowRemoteAnalyzer: boolean;
    allowedAnalyzerHosts: string[];
    requireSelfHosted: boolean;





    requireRemoteAnalyzer?: boolean;
    blockUntrackedFiles: boolean;
  };
  embedding: {
    enabled: boolean;
    provider: 'api' | 'local';
    model: string;
    apiKeyEnv: string;
    dimensions: number;
    maxDocumentChars: number;
    store: 'auto' | 'file' | 'pgvector';
    databaseUrlEnv: string;
    phaseBudgetMs: number;
    maxConcurrency: number;
    rerank: {
      alpha: number;
      beta: number;
    };
  };
  github?: {
    appSlug?: string;
    installationId?: string;
    owner?: string;
    repositories?: string[];
    defaultBranchOnly?: boolean;
  };










  conventions?: KlauroConventions;










  context?: KlauroContextConfig;











  fabric?: KlauroFabricConfig;











  packs?: string[];















  scope?: KlauroScopeConfig;
}

export interface KlauroScopeConfig {





  mode?: 'workspace' | 'machine';
}


export type KlauroRouteConvention =
  | {
      kind?: 'decorator';
      decorator: string;
      path_arg?: number | string;
      method_arg?: number | string;
      default_method?: string;
    }
  | {
      kind: 'call';
      call: string;
      method_arg: number | string;
      path_arg: number | string;
      handler_arg: number | string;
    };

export interface KlauroEntryPointConvention {
  files: string;
  export_matches: string;
  kind: 'http' | 'websocket' | 'cli' | 'event' | 'schedule' | 'page' | 'route' | 'message' | 'file' | 'test' | 'lifecycle' | 'api' | 'task' | 'pipeline' | 'notebook-cell' | 'train' | 'graphql';
}

export interface KlauroEntityConvention {
  name_suffix?: string;
  name_regex?: string;
  decorator?: string;
}

export interface KlauroDiBindingConvention {
  call: string;
  token_arg: number | string;
  impl_arg: number | string;
}

export interface KlauroRoleConvention {
  name_suffix?: string;
  name_regex?: string;
  role: string;
}

export interface KlauroFlowConvention {
  name: string;
  steps: string[];
}

export interface KlauroContextConfig {





  runtime?: 'include' | 'exclude' | 'auto';
}


export interface KlauroFabricConfig {

  enabled: boolean;

  endpoint?: string;

  workspace?: string;
}

export interface KlauroConventions {
  routes?: KlauroRouteConvention[];
  entry_points?: KlauroEntryPointConvention[];
  entities?: KlauroEntityConvention[];
  di_bindings?: KlauroDiBindingConvention[];
  roles?: KlauroRoleConvention[];
  flows?: KlauroFlowConvention[];
}

export interface LoadedKlauroConfig {
  config: KlauroConfig;
  configPath?: string;
  ignorePath?: string;
  ignorePatterns: string[];
  gitIgnored?: Set<string>;
}

const CONFIG_FILES = ['.klaurorc', '.klaurorc.json'];

export function defaultKlauroConfig(projectPath: string): KlauroConfig {
  return {
    version: 1,
    kind: 'project',
    project: {





      name: resolveManifestProjectName(path.resolve(projectPath), path.basename(path.resolve(projectPath))),
    },
    analyzer: {


      serverUrl: process.env.KLAURO_ANALYZER_URL || DEFAULT_KLAURO_CLOUD_URL,
      selfHosted: false,
    },
    source: {
      roots: ['.'],
      include: [
        '**/*',
      ],
      exclude: defaultExcludePatterns(),
      maxFileBytes: 0,
      maxTotalBytes: 512 * 1024 * 1024,
      followSymlinks: false,
      respectGitignore: true,
    },
    upload: {
      mode: 'full',
      requireManifestReview: false,
      allowDirtyTreeSync: true,
      sendGitDiff: true,
      sendDeletedPaths: true,
    },
    mcp: {
      cachePath: process.env.KLAURO_STORAGE_PATH,
      preferLocalCache: true,
    },
    policy: {
      allowRemoteAnalyzer: true,
      allowedAnalyzerHosts: [],
      requireSelfHosted: false,



      blockUntrackedFiles: false,
    },
    embedding: {
      enabled: true,
      provider: 'local',



      model: 'klauro-local-hash-v1',
      apiKeyEnv: 'KLAURO_EMBEDDING_API_KEY',
      dimensions: 384,
      maxDocumentChars: 8000,
      store: 'auto',
      databaseUrlEnv: 'KLAURO_DATABASE_URL',
      phaseBudgetMs: 120000,
      maxConcurrency: 8,
      rerank: {
        alpha: 0.7,
        beta: 0.3,
      },
    },
    github: {
      defaultBranchOnly: true,
    },
    conventions: {},
  };
}

export async function loadKlauroConfig(projectPath: string): Promise<LoadedKlauroConfig> {
  const root = path.resolve(projectPath);
  const defaults = defaultKlauroConfig(root);
  const configPath = await findFirstExisting(root, CONFIG_FILES);
  const userConfig = configPath ? JSON.parse(await fs.readFile(configPath, 'utf8')) : {};
  const ignorePath = await findFirstExisting(root, ['.klauroignore']);
  const ignorePatterns = ignorePath ? parseIgnorePatterns(await fs.readFile(ignorePath, 'utf8')) : [];

  const config = mergeConfig(defaults, userConfig);
  const gitIgnored = config.source.respectGitignore === false ? undefined : await gitIgnoredPaths(root);

  return {
    config,
    configPath,
    ignorePath,
    ignorePatterns,
    gitIgnored,
  };
}

export async function writeDefaultKlauroConfig(projectPath: string, options: {
  force?: boolean;
  serverUrl?: string;
  projectId?: string;
  workspaceId?: string;
  organizationId?: string;
  projectName?: string;
  kind?: 'project' | 'workspace';
} = {}): Promise<{ configPath: string; ignorePath: string; config: KlauroConfig }> {
  const root = path.resolve(projectPath);
  const configPath = path.join(root, '.klaurorc');
  const ignorePath = path.join(root, '.klauroignore');
  const config = defaultKlauroConfig(root);
  config.kind = options.kind || config.kind;
  config.project.name = options.projectName || config.project.name;
  config.analyzer.serverUrl = options.serverUrl || config.analyzer.serverUrl;
  config.project.id = options.projectId || config.project.id;
  config.project.workspaceId = options.workspaceId || config.project.workspaceId;
  config.project.organizationId = options.organizationId || config.project.organizationId;

  let ignoreExists = false;
  if (!options.force) {
    try {
      await fs.access(configPath);
      throw new Error(`${path.basename(configPath)} already exists. Use --force to overwrite.`);
    } catch (error) {
      if (error instanceof Error && !('code' in error)) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }


    try {
      await fs.access(ignorePath);
      ignoreExists = true;
    } catch {
      ignoreExists = false;
    }
  }

  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  if (!ignoreExists) await fs.writeFile(ignorePath, defaultKlauroIgnore(), 'utf8');
  return { configPath, ignorePath, config };
}










export async function writeProjectBindingIntoConfig(projectPath: string, binding: {
  projectId?: string;
  workspaceId?: string;
  organizationId?: string;
  projectName?: string;
  kind?: 'project' | 'workspace';
  serverUrl?: string;
}): Promise<{ configPath: string }> {
  const root = path.resolve(projectPath);
  const configPath = await findFirstExisting(root, CONFIG_FILES);
  if (!configPath) {
    throw new Error(`No .klaurorc found at ${root} — run \`klauro init\` to create one.`);
  }
  const raw = JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>;
  const project = raw.project && typeof raw.project === 'object' && !Array.isArray(raw.project)
    ? (raw.project as Record<string, unknown>)
    : {};
  if (binding.projectId) project.id = binding.projectId;
  if (binding.workspaceId) project.workspaceId = binding.workspaceId;
  if (binding.organizationId) project.organizationId = binding.organizationId;

  if (binding.projectName && !project.name) project.name = binding.projectName;
  raw.project = project;
  if (binding.kind && !raw.kind) raw.kind = binding.kind;
  if (binding.serverUrl) {
    const analyzer = raw.analyzer && typeof raw.analyzer === 'object' && !Array.isArray(raw.analyzer)
      ? (raw.analyzer as Record<string, unknown>)
      : {};
    analyzer.serverUrl = binding.serverUrl;
    raw.analyzer = analyzer;
  }
  await fs.writeFile(configPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  return { configPath };
}

export function defaultExcludePatterns(): string[] {
  return [
    '**/.git/**',
    '**/.klauro/**',
    '**/.klauro*/**',
    '**/.claude/**',
    '**/.codex/**',
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/coverage/**',
    '**/.next/**',
    '**/.nuxt/**',
    '**/.turbo/**',
    '**/.cache/**',
    '**/.vite/**',
    '**/target/**',
    '**/vendor/**',
    '**/vendors/**',
    '**/__pycache__/**',
    '**/.pytest_cache/**',
    '**/.mypy_cache/**',
    '**/.ruff_cache/**',
    '**/.venv/**',
    '**/venv/**',
    '**/env/**',












    '**/site-packages/**',
    '**/dist-packages/**',

    '**/*.egg-info/**',
    '**/*.dist-info/**',
    '**/.tox/**',
    '**/.dart_tool/**',
    '**/.gradle/**',
    '**/Pods/**',


    '**/obj/**',
    '**/.env',
    '**/.env.*',
    '**/*.pem',
    '**/*.key',
    '**/secrets/**',
    '**/*secret*/**',
    '**/*credential*/**',
  ];
}

export function defaultKlauroIgnore(): string {
  return [
    '# Klauro upload exclusions. These patterns apply in addition to safe defaults.',
    '.env*',
    'secrets/**',
    'private-fixtures/**',
    'customer-dumps/**',
    '*.pem',
    '*.key',
    '*.p12',
    '*.pfx',
    '',
  ].join('\n');
}

export function parseIgnorePatterns(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
}

export function allSourceExcludePatterns(loaded: LoadedKlauroConfig, extraExcludePatterns: string[] = []): string[] {
  return [
    ...(loaded.config.source.exclude || []),
    ...(loaded.ignorePatterns || []),
    ...extraExcludePatterns,
  ];
}

export function sourcePatternListMatches(filePath: string, patterns: string[]): boolean {
  return patterns.some(pattern => sourceGlobLikeMatches(filePath, pattern));
}

export function sourceGlobLikeMatches(filePath: string, pattern: string): boolean {
  const normalizedPath = normalizeSourcePatternPath(filePath);
  const normalizedPattern = normalizeSourcePatternPath(pattern);
  if (!normalizedPath || !normalizedPattern) return false;
  if (normalizedPattern === '**/*' || normalizedPattern === '**') return true;
  const directPattern = normalizedPattern.startsWith('**/')
    ? normalizedPattern.slice(3)
    : normalizedPattern;
  const regex = new RegExp(`^${sourceGlobToRegex(normalizedPattern)}$`);
  if (regex.test(normalizedPath)) return true;
  if (!normalizedPattern.includes('/')) {
    return normalizedPath.split('/').some(part => new RegExp(`^${sourceGlobToRegex(normalizedPattern)}$`).test(part));
  }
  if (normalizedPattern.startsWith('**/')) {
    return new RegExp(`(^|/)${sourceGlobToRegex(directPattern)}$`).test(normalizedPath);
  }
  return false;
}

export function normalizeSourcePatternPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\/+/, '');
}

function sourceGlobToRegex(pattern: string): string {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    const next = pattern[i + 1];
    if (char === '*' && next === '*') {
      out += '.*';
      i++;
    } else if (char === '*') {
      out += '[^/]*';
    } else if (char === '?') {
      out += '.';
    } else {
      out += escapeRegex(char);
    }
  }
  return out;
}

function escapeRegex(char: string): string {
  return /[\\^$+?.()|[\]{}]/.test(char) ? `\\${char}` : char;
}

export function resolveAnalyzerUrl(loaded: LoadedKlauroConfig, explicitUrl?: string): string | undefined {
  return explicitUrl || loaded.config.analyzer.serverUrl || process.env.KLAURO_ANALYZER_URL || DEFAULT_KLAURO_CLOUD_URL;
}

export function resolveAnalysisId(loaded: LoadedKlauroConfig, fallback: string, explicitId?: string): string {
  return explicitId || loaded.config.project.id || fallback;
}








export function isBoundToHostedProject(loaded: LoadedKlauroConfig): boolean {
  return Boolean(loaded.config.project?.id);
}











export function isUnboundHostedProjectId(id: unknown): boolean {
  return typeof id !== 'string' || !/^prj_/.test(id);
}












export async function probeHostedProjectBinding(
  serverUrl: string,
  token: string,
  projectId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<'bound' | 'not_found' | 'indeterminate'> {
  try {
    const response = await fetchImpl(`${serverUrl}/api/projects/${encodeURIComponent(projectId)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (response.ok) return 'bound';
    if (response.status === 404) return 'not_found';
    return 'indeterminate';
  } catch {
    return 'indeterminate';
  }
}







export function assertLocalAnalysisAllowed(loaded: LoadedKlauroConfig): void {
  const url = loaded.config.analyzer.serverUrl || DEFAULT_KLAURO_CLOUD_URL;
  throw new Error(
    `Local analysis is not a customer execution mode; Klauro product analysis runs on the hosted analyzer. ` +
    `Use analyze_codebase_remote to upload source to ${url}.`
  );
}

export function assertRemoteAnalyzerAllowed(loaded: LoadedKlauroConfig, serverUrl?: string): void {
  const config = loaded.config;
  if (!config.policy.allowRemoteAnalyzer) {
    throw new Error('Remote analyzer is blocked by .klaurorc policy.allowRemoteAnalyzer=false');
  }
  if (config.policy.requireSelfHosted && !config.analyzer.selfHosted) {
    throw new Error('Remote analyzer is blocked by .klaurorc policy.requireSelfHosted=true');
  }
  const allowedHosts = config.policy.allowedAnalyzerHosts || [];
  if (allowedHosts.length > 0) {
    const url = serverUrl || config.analyzer.serverUrl;
    if (!url || !allowedHosts.some(allowed => sameHostOrPrefix(url, allowed))) {
      throw new Error(`Remote analyzer host is not allowed by .klaurorc policy.allowedAnalyzerHosts: ${url || 'missing'}`);
    }
  }
}

async function findFirstExisting(root: string, fileNames: string[]): Promise<string | undefined> {
  for (const fileName of fileNames) {
    const candidate = path.join(root, fileName);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
    }
  }
  return undefined;
}

function mergeConfig(defaults: KlauroConfig, userConfig: Partial<KlauroConfig>): KlauroConfig {
  return {
    ...defaults,
    ...userConfig,
    project: { ...defaults.project, ...(userConfig.project || {}) },
    analyzer: { ...defaults.analyzer, ...(userConfig.analyzer || {}) },
    source: { ...defaults.source, ...(userConfig.source || {}) },
    upload: { ...defaults.upload, ...(userConfig.upload || {}) },
    mcp: { ...defaults.mcp, ...(userConfig.mcp || {}) },
    policy: { ...defaults.policy, ...(userConfig.policy || {}) },
    embedding: {
      ...defaults.embedding,
      ...(userConfig.embedding || {}),
      rerank: {
        ...defaults.embedding.rerank,
        ...((userConfig.embedding || {}).rerank || {}),
      },
    },
    github: { ...defaults.github, ...(userConfig.github || {}) },
    conventions: mergeConventions(defaults.conventions, userConfig.conventions),
    context: userConfig.context !== undefined
      ? { ...defaults.context, ...userConfig.context }
      : defaults.context,
    packs: userConfig.packs ?? defaults.packs,
    fabric: userConfig.fabric ?? defaults.fabric,
    scope: userConfig.scope ?? defaults.scope,
  };
}

function mergeConventions(
  defaults: KlauroConventions | undefined,
  userConventions: KlauroConventions | undefined,
): KlauroConventions {
  if (!userConventions) return defaults || {};
  return {
    routes: userConventions.routes ?? defaults?.routes,
    entry_points: userConventions.entry_points ?? defaults?.entry_points,
    entities: userConventions.entities ?? defaults?.entities,
    di_bindings: userConventions.di_bindings ?? defaults?.di_bindings,
    roles: userConventions.roles ?? defaults?.roles,
    flows: userConventions.flows ?? defaults?.flows,
  };
}

export interface EmbeddingConfigValidation {
  errors: string[];
  warnings: string[];
}

export function validateEmbeddingConfig(config: KlauroConfig): EmbeddingConfigValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const embedding = config.embedding;

  if (!embedding.enabled) {
    return { errors, warnings };
  }

  if (embedding.dimensions <= 0) {
    errors.push('embedding.dimensions must be a positive integer');
  }
  if (embedding.maxDocumentChars <= 0) {
    errors.push('embedding.maxDocumentChars must be a positive integer');
  }
  if (embedding.maxConcurrency < 1) {
    errors.push('embedding.maxConcurrency must be at least 1');
  }
  if (embedding.phaseBudgetMs <= 0) {
    errors.push('embedding.phaseBudgetMs must be a positive integer');
  }
  if (embedding.rerank.alpha < 0 || embedding.rerank.beta < 0) {
    errors.push('embedding.rerank weights must be non-negative');
  }
  if (embedding.rerank.alpha === 0 && embedding.rerank.beta === 0) {
    errors.push('embedding.rerank weights cannot both be zero');
  }

  if (embedding.store === 'pgvector') {
    if (!embedding.databaseUrlEnv) {
      errors.push('embedding.databaseUrlEnv is required when embedding.store is "pgvector"');
    } else if (!process.env[embedding.databaseUrlEnv]) {
      warnings.push(
        `embedding.databaseUrlEnv "${embedding.databaseUrlEnv}" is not set; pgvector store will fall back to the file store`,
      );
    }
  }

  if (embedding.provider === 'api') {
    if (!embedding.apiKeyEnv) {
      errors.push('embedding.apiKeyEnv is required when embedding.provider is "api"');
    } else if (!process.env[embedding.apiKeyEnv]) {
      warnings.push(
        `embedding.apiKeyEnv "${embedding.apiKeyEnv}" is not set; API embedding will fail until it is`,
      );
    }
  }


  if (
    embedding.provider === 'local' &&
    embedding.model === 'onnx-all-MiniLM-L6-v2' &&
    embedding.dimensions !== 384
  ) {
    errors.push(
      `embedding.model "onnx-all-MiniLM-L6-v2" requires embedding.dimensions=384 (got ${embedding.dimensions})`,
    );
  }

  return { errors, warnings };
}

export interface ConventionsValidation {
  errors: string[];
  warnings: string[];
}







export function validateConventions(conventions: KlauroConventions | undefined): ConventionsValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!conventions) return { errors, warnings };

  (conventions.routes || []).forEach((route, i) => {
    const label = `conventions.routes[${i}]`;
    if ('call' in route && route.kind === 'call') {
      if (!route.call) errors.push(`${label}: "call" is required for a call-based route convention (e.g. "app.register")`);
      if (route.method_arg === undefined) errors.push(`${label}: "method_arg" is required (position or name of the HTTP method argument)`);
      if (route.path_arg === undefined) errors.push(`${label}: "path_arg" is required (position or name of the path argument)`);
      if (route.handler_arg === undefined) errors.push(`${label}: "handler_arg" is required (position or name of the handler argument)`);
    } else if ('decorator' in route) {
      if (!route.decorator) errors.push(`${label}: "decorator" is required (e.g. "@Endpoint")`);
      if (!route.decorator?.startsWith('@')) warnings.push(`${label}: "decorator" value "${route.decorator}" does not start with "@" — decorator names are usually written with the leading @`);
    } else {
      errors.push(`${label}: must have either "decorator" (decorator-based route) or "kind": "call" + "call" (registration-call-based route)`);
    }
  });

  (conventions.entry_points || []).forEach((ep, i) => {
    const label = `conventions.entry_points[${i}]`;
    if (!ep.files) errors.push(`${label}: "files" glob is required (e.g. "src/jobs/**/*.ts")`);
    if (!ep.export_matches) errors.push(`${label}: "export_matches" regex is required to select matching exports`);
    else {
      try { new RegExp(ep.export_matches); } catch { errors.push(`${label}: "export_matches" is not a valid regular expression: "${ep.export_matches}"`); }
    }
    if (!ep.kind) errors.push(`${label}: "kind" is required (e.g. "cli", "event", "schedule")`);
  });

  (conventions.entities || []).forEach((entity, i) => {
    const label = `conventions.entities[${i}]`;
    if (!entity.name_suffix && !entity.name_regex && !entity.decorator) {
      errors.push(`${label}: must set at least one of "name_suffix", "name_regex", "decorator" to match classes`);
    }
    if (entity.name_regex) {
      try { new RegExp(entity.name_regex); } catch { errors.push(`${label}: "name_regex" is not a valid regular expression: "${entity.name_regex}"`); }
    }
  });

  (conventions.di_bindings || []).forEach((binding, i) => {
    const label = `conventions.di_bindings[${i}]`;
    if (!binding.call) errors.push(`${label}: "call" is required (e.g. "provide")`);
    if (binding.token_arg === undefined) errors.push(`${label}: "token_arg" is required (position or name of the binding token argument)`);
    if (binding.impl_arg === undefined) errors.push(`${label}: "impl_arg" is required (position or name of the implementation argument)`);
  });

  (conventions.roles || []).forEach((role, i) => {
    const label = `conventions.roles[${i}]`;
    if (!role.name_suffix && !role.name_regex) errors.push(`${label}: must set "name_suffix" or "name_regex" to match nodes`);
    if (!role.role) errors.push(`${label}: "role" label is required (e.g. "use-case")`);
    if (role.name_regex) {
      try { new RegExp(role.name_regex); } catch { errors.push(`${label}: "name_regex" is not a valid regular expression: "${role.name_regex}"`); }
    }
  });

  (conventions.flows || []).forEach((flow, i) => {
    const label = `conventions.flows[${i}]`;
    if (!flow.name) errors.push(`${label}: "name" is required`);
    if (!flow.steps || flow.steps.length === 0) errors.push(`${label}: "steps" must be a non-empty array of "Class.method" or "function" references, in order`);
  });

  return { errors, warnings };
}

function sameHostOrPrefix(url: string, allowed: string): boolean {
  try {
    const parsed = new URL(url);
    const parsedAllowed = new URL(allowed);
    return parsed.protocol === parsedAllowed.protocol && parsed.host === parsedAllowed.host;
  } catch {
    return url.startsWith(allowed);
  }
}
