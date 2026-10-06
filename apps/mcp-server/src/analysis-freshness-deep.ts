import * as fs from 'fs-extra';
import * as path from 'path';
import { glob } from 'glob';
import { getAnalysisEntry, loadAnalysis } from './storage';
import type { CASLayersReady } from '../../../packages/analyzer-core/src/types/cas.types';
import type { FreshnessStatus } from './freshness';














export interface AnalysisFreshnessReport {
  generated_at: string;
  path: string;
  status: FreshnessStatus;
  analyzed_at?: string;
  analysis_age_seconds?: number;
  source_files: number;
  modified_since_analysis: number;
  sample_modified_files: Array<{
    path: string;
    modified_at: string;
  }>;
  recommendation: string;



  layers_ready?: CASLayersReady;
}

const SOURCE_PATTERNS = [
  '**/*.{js,jsx,ts,tsx,mjs,cjs,py,go,rs,java,kt,cs,php,vue,svelte}',
  '**/package.json',
  '**/pyproject.toml',
  '**/requirements.txt',
  '**/Cargo.toml',
  '**/go.mod',
  '**/*.csproj',
  '**/composer.json',
  '**/prisma/schema.prisma',
  '**/*.{graphql,gql,proto,openapi.yaml,openapi.yml,openapi.json}',
];

const IGNORE_PATTERNS = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/target/**',
  '**/vendor/**',
  '**/vendors/**',
  '**/site-packages/**',
  '**/.sourcemaps/**',
  '**/sourcemaps/**',
  '**/*.js.map',
  '**/*.css.map',
  '**/*.bundle.js',
  '**/*.bundle.css',
  '**/*.min.js',
  '**/*.min.css',
  '**/Generated/**',
  '**/generated/**',
  '**/venv/**',
  '**/.venv/**',
  '**/env/**',
  '**/.git/**',
  '**/coverage/**',
  '**/.nyc_output/**',
  '**/__pycache__/**',
  '**/.next/**',
  '**/.turbo/**',
  '**/.cache/**',
  '**/.vite/**',
  '**/out/**',
  '**/web/assets/**',
  '**/public/assets/**',
  '**/static/assets/**',
];

export async function getAnalysisFreshness(projectPath: string): Promise<AnalysisFreshnessReport> {
  const entry = await getAnalysisEntry(projectPath);
  if (!entry) {
    return {
      generated_at: new Date().toISOString(),
      path: projectPath,
      status: 'no-analysis',
      source_files: 0,
      modified_since_analysis: 0,
      sample_modified_files: [],
      recommendation: 'Run analyze_codebase before relying on CAS-backed MCP context.',
    };
  }

  const analyzedAtMs = Date.parse(entry.analyzed_at);
  const sourceFiles = await glob(SOURCE_PATTERNS, {
    cwd: projectPath,
    ignore: IGNORE_PATTERNS,
    nodir: true,
    absolute: false,
  });
  const modified = [];
  for (const file of sourceFiles) {
    const stat = await fs.stat(path.join(projectPath, file));
    if (stat.mtimeMs > analyzedAtMs) {
      modified.push({ path: file, modified_at: new Date(stat.mtimeMs).toISOString() });
    }
  }

  modified.sort((left, right) => Date.parse(right.modified_at) - Date.parse(left.modified_at));
  const status: FreshnessStatus = modified.length > 0 ? 'stale' : 'fresh';





  let layersReady: CASLayersReady | undefined;
  try {
    const cas = await loadAnalysis(projectPath, { preferCache: true });
    layersReady = cas?.layers_ready;
  } catch {
    layersReady = undefined;
  }

  return {
    generated_at: new Date().toISOString(),
    path: projectPath,
    status,
    analyzed_at: entry.analyzed_at,
    analysis_age_seconds: Math.max(0, Math.round((Date.now() - analyzedAtMs) / 1000)),
    source_files: sourceFiles.length,
    modified_since_analysis: modified.length,
    sample_modified_files: modified.slice(0, 25),
    recommendation: status === 'fresh'
      ? 'CAS is fresh relative to source file mtimes.'
      : 'Run analyze_codebase to refresh CAS before using it as default agent context.',
    ...(layersReady ? { layers_ready: layersReady } : {}),
  };
}
