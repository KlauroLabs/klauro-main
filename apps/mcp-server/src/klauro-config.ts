import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { DEFAULT_KLAURO_CLOUD_URL } from './defaults';
import { resolveManifestProjectName } from '../../../packages/analyzer-core/src/analyzer/core/deployable-evidence/util';

export interface KlauroConfig {
  version: number;
  kind?: 'project' | 'workspace';
  project: {
    name?: string;
    id?: string;
    workspaceId?: string;
    organizationId?: string;
    /**
     * The repo's default ("main") branch. When set, this branch is classified
     * as the 'main' analysis track and every other committed branch as
     * 'other-branch' (see track.ts revisionToTrack). Optional and backward
     * compatible: when unset, both 'main' and 'master' are treated as default.
     */
    mainBranch?: string;
  };
  analyzer: {
    // No "mode": Klauro is one product. Analysis goes to the hosted service
    // (serverUrl, production by default). selfHosted only swaps the server URL for
    // a local/self-hosted analyzer-server; it is not a local-vs-remote toggle.
    serverUrl?: string;
    selfHosted?: boolean;
  };
  source: {
    roots: string[];
    include: string[];
    exclude: string[];
    maxFileBytes: number;
    followSymlinks: boolean;
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
  /**
   * Declared custom-architecture conventions, in Klauro's own node/edge
   * vocabulary, so hand-rolled/proprietary patterns the auto-detectors can't
   * infer surface as real entry_points/route_table rows/data_entities/edges/
   * flows instead of staying invisible. Purely ADDITIVE to auto-detection —
   * never replaces it, and a declared convention that matches nothing real in
   * the analyzed nodes emits nothing (evidence-gated, never fabricated). See
   * docs/CUSTOM-CONVENTIONS.md. Optional/backward-compatible: absent or
   * empty on every existing .klaurorc.
   */
  conventions?: KlauroConventions;
  /**
   * Team-level defaults for the agent context/summary read tools. Currently the
   * runtime opt-out: `context.runtime` = "exclude" turns off runtime telemetry,
   * communication-seams, and runtime-topology sections globally for everyone on
   * the repo (a pure static view); "include" opts back in; "auto" (default,
   * backward compatible) keeps the existing task-type-gated behavior. A per-call
   * `runtime` param and the KLAURO_CONTEXT_RUNTIME env var override this. See
   * apps/mcp-server/src/context-filter.ts. Optional/absent on every existing
   * .klaurorc.
   */
  context?: KlauroContextConfig;
  /**
   * Coordination-fabric settings for this project, written by `klauro init`
   * (enabled by default when connecting a repo) and by `klauro fabric on|off`
   * for fine control (see docs/FABRIC-REMOTE.md). When `enabled` is true, the fab CLI
   * (scripts/fab.ts) and the fab_* MCP tools route advisory claims to the
   * cross-machine coordination API at `endpoint` under `workspace` — no env
   * vars needed. The Bearer token is NEVER stored here: it is resolved at call
   * time from the same credential store `klauro init`/`klauro login` use
   * (~/.klauro/auth.json). Optional and additive: absent on every existing
   * .klaurorc = the original local-only fabric, byte-for-byte unchanged.
   */
  fabric?: KlauroFabricConfig;
  /**
   * Local declarative analyzer packs (glob(s), relative to the project root or
   * absolute) that the analyzer-pack engine loads IN ADDITION to the built-in
   * packs shipped with analyzer-core. A pack is a *.pack.yaml with tree-sitter
   * queries that emit real CAS entry_points/entities/edges — the declarative
   * equivalent of a hand-coded *-analyzer.ts. See docs/SPEC-ANALYZER-PACKS.md.
   * Purely ADDITIVE and evidence-gated (each pack's applies_when must match):
   * absent/empty on every existing .klaurorc, and a malformed pack degrades to
   * a scoped load error rather than crashing the analysis. Convention mirrors
   * `conventions` discovery — e.g. `packs: ["./.klauro/packs/*.pack.yaml"]`.
   */
  packs?: string[];
  /**
   * Agent-isolation scope for multi-analysis MCP surfaces (list_analyses,
   * list_workspace_analyses/list_cross_codebase_analyses, resolve_agent_analysis,
   * get_agent_project_map). See apps/mcp-server/src/analysis-scope.ts.
   *
   * When this project (or an ancestor directory) is bound to an account
   * workspace (`project.workspaceId` set, typically on a `kind: "workspace"`
   * .klaurorc written by `klauro init` at the workspace root), the default is
   * `mode: "workspace"`: multi-analysis tools are filtered to analyses whose
   * path falls under that workspace root, so an agent operating in one
   * customer's workspace never sees another customer's — or the operator's
   * personal — analyses. Set `mode: "machine"` to explicitly opt back into
   * the old all-local-store view (the operator's own dogfooding machine).
   * Absent + no bound workspaceId = unchanged legacy behavior (machine-wide).
   */
  scope?: KlauroScopeConfig;
}

export interface KlauroScopeConfig {
  /**
   * "workspace" (default when project.workspaceId is set): filter multi-analysis
   * enumeration to the bound workspace's projects. "machine": explicit opt-out,
   * see every locally stored analysis (pre-isolation behavior).
   */
  mode?: 'workspace' | 'machine';
}

/** One custom route source: a decorator-based router or a registration-call-based router. */
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
  kind: 'http' | 'websocket' | 'cli' | 'event' | 'schedule' | 'page' | 'route' | 'message' | 'file' | 'test' | 'lifecycle' | 'api' | 'task' | 'pipeline' | 'notebook-cell' | 'train';
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
  /**
   * Runtime-section opt-out for the context/summary tools. "auto" (default)
   * preserves the current task-type-gated behavior; "exclude" omits runtime
   * telemetry / communication-seams / runtime-topology; "include" opts in.
   */
  runtime?: 'include' | 'exclude' | 'auto';
}

/** Project-level coordination-fabric settings (written by `klauro init`; `klauro fabric on|off` for fine control). */
export interface KlauroFabricConfig {
  /** Route fab claims to the remote coordination API (true) or stay local-only (false). */
  enabled: boolean;
  /** Coordination service base URL (e.g. https://mcp.klauro.com). Token comes from ~/.klauro/auth.json, never from this file. */
  endpoint?: string;
  /** Shared workspace id — must match on every machine coordinating on this repo. */
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
}

const CONFIG_FILES = ['.klaurorc', '.klaurorc.json'];

export function defaultKlauroConfig(projectPath: string): KlauroConfig {
  return {
    version: 1,
    kind: 'project',
    project: {
      // Prefer the ecosystem manifest's declared name (package.json/pyproject.toml/
      // Cargo.toml/go.mod) over the bare directory basename — a checkout folder or
      // hash-named snapshot dir frequently doesn't match the actual package name,
      // and naming the project after it reads as unpolished. See cold-customer
      // feedback 2026-07-06 (~/.klauro/agent-feedback/2026-07-06-cold-customer.md).
      name: resolveManifestProjectName(path.resolve(projectPath), path.basename(path.resolve(projectPath))),
    },
    analyzer: {
      // One product: analysis goes to the hosted service (heavy work + AI on the VPS),
      // production by default. No local/remote mode exists. See docs/KLAURO-PRODUCT-MODEL.md.
      serverUrl: process.env.KLAURO_ANALYZER_URL || DEFAULT_KLAURO_CLOUD_URL,
      selfHosted: false,
    },
    source: {
      roots: ['.'],
      include: [
        '**/*',
      ],
      exclude: defaultExcludePatterns(),
      maxFileBytes: 1024 * 1024,
      followSymlinks: false,
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
      // Real in-process ONNX sentence-embedding model (all-MiniLM-L6-v2). The
      // local factory (createLocalEmbeddingProvider) transparently falls back to
      // the zero-dependency hash embedding (klauro-local-hash-v1) when the model
      // can't load, so concept queries get real semantic matching where the
      // model is present and never fail where it isn't. Both are 384-dim.
      model: 'onnx-all-MiniLM-L6-v2',
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

  return {
    config: mergeConfig(defaults, userConfig),
    configPath,
    ignorePath,
    ignorePatterns,
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
    // A pre-existing .klauroignore is KEPT, not an error: `klauro init` must be
    // idempotent/re-runnable, and a hand-tuned ignore file is user data.
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

/**
 * Persist a hosted-project binding into an EXISTING .klaurorc additively: the
 * raw file is read as-is and ONLY the project ids (+ name/kind when absent)
 * are updated, so hand-tuned source/exclude/analyzer customizations are never
 * clobbered. This is the self-heal path for a stale config written by an
 * older CLI that left `project.id: null` — `klauro init` re-binds it in place
 * instead of making the user `rm .klaurorc` and start over. Mirrors the
 * additive contract of writeFabricSection (fabric-config.ts).
 */
export async function writeProjectBindingIntoConfig(projectPath: string, binding: {
  projectId: string;
  workspaceId?: string;
  organizationId?: string;
  projectName?: string;
  kind?: 'project' | 'workspace';
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
  project.id = binding.projectId;
  if (binding.workspaceId) project.workspaceId = binding.workspaceId;
  if (binding.organizationId) project.organizationId = binding.organizationId;
  // A user-chosen name in the file wins; only fill the name when it is absent.
  if (binding.projectName && !project.name) project.name = binding.projectName;
  raw.project = project;
  if (binding.kind && !raw.kind) raw.kind = binding.kind;
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
    '**/.tox/**',
    '**/.dart_tool/**',
    '**/.gradle/**',
    '**/Pods/**',
    // 'bin' is NOT ignored — it holds real source in OCaml/Dune, Rust src/bin,
    // shell script dirs; build artifacts there fail the source-extension gate.
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

  // The local ONNX model (all-MiniLM-L6-v2) emits fixed 384-dim vectors; a
  // mismatched dimensions setting would force a fallback to the hash embedding.
  if (
    embedding.provider === 'local' &&
    embedding.model === 'onnx-all-MiniLM-L6-v2' &&
    embedding.dimensions !== 384
  ) {
    warnings.push(
      `embedding.model "onnx-all-MiniLM-L6-v2" requires embedding.dimensions=384 (got ${embedding.dimensions}); the local provider will fall back to the hash embedding`,
    );
  }

  return { errors, warnings };
}

export interface ConventionsValidation {
  errors: string[];
  warnings: string[];
}

/**
 * Validate the `conventions` section with actionable, field-specific
 * messages — a malformed convention must degrade to a clear error, never a
 * crash mid-analysis. Called both by the MCP `declare_convention` surface
 * (reject before writing) and defensively before the applier runs.
 */
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
