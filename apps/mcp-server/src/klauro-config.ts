import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface KlauroConfig {
  version: number;
  project: {
    name?: string;
    id?: string;
    organizationId?: string;
  };
  analyzer: {
    mode: 'local' | 'remote';
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
    project: {
      name: path.basename(path.resolve(projectPath)),
    },
    analyzer: {
      mode: 'local',
      serverUrl: process.env.KLAURO_ANALYZER_URL || 'http://127.0.0.1:8787',
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
  mode?: 'local' | 'remote';
  serverUrl?: string;
  projectId?: string;
  organizationId?: string;
} = {}): Promise<{ configPath: string; ignorePath: string; config: KlauroConfig }> {
  const root = path.resolve(projectPath);
  const configPath = path.join(root, '.klaurorc');
  const ignorePath = path.join(root, '.klauroignore');
  const config = defaultKlauroConfig(root);
  config.analyzer.mode = options.mode || config.analyzer.mode;
  config.analyzer.serverUrl = options.serverUrl || config.analyzer.serverUrl;
  config.project.id = options.projectId || config.project.id;
  config.project.organizationId = options.organizationId || config.project.organizationId;

  if (!options.force) {
    for (const file of [configPath, ignorePath]) {
      try {
        await fs.access(file);
        throw new Error(`${path.basename(file)} already exists. Use --force to overwrite.`);
      } catch (error) {
        if (error instanceof Error && !('code' in error)) throw error;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }

  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await fs.writeFile(ignorePath, defaultKlauroIgnore(), 'utf8');
  return { configPath, ignorePath, config };
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
    '**/bin/**',
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
  return explicitUrl || loaded.config.analyzer.serverUrl || process.env.KLAURO_ANALYZER_URL;
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
