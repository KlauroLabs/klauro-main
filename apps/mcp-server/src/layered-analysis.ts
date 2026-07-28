/**
 * Progressive layered analysis availability (task #112): "layer the analysis
 * too, starting with the index and so on... the user should be able to
 * benefit in seconds or less."
 *
 * The layer ladder, fast -> slow:
 *   L0 index/inventory   (files, languages, directory structure)  — target <2s
 *   L1 nodes + entry points / routes
 *   L2 call graph / edges
 *   L3 entities / lineage / database schema
 *   L4 flows / capabilities / ICELOT contracts
 *   L5 AI enrichment (the pre-existing ai_enrichment deferred pattern)
 *
 * Why L0 stands alone: it is a pure filesystem walk (glob + stat), with zero
 * dependency on the analyzer/orchestrator pipeline, so it can be computed and
 * PERSISTED before the deterministic analysis pipeline (L1-L4) even starts.
 * L1-L4 remain a single entangled pass inside AnalyzerOrchestrator.executeAnalysis
 * — splitting those further would require restructuring a 20k+ line orchestrator
 * that other in-flight work is also touching, so this lands the
 * highest-value split first per the task's own fallback clause: L0 fast layer
 * within seconds, L1-L4 as today (one atomic block), L5 already progressive.
 *
 * Evidence-gating is unchanged: L0 only ever reports counts/paths it actually
 * observed on disk. It never fabricates nodes, routes, or any fact that
 * belongs to a later layer — those fields are simply absent (or empty) on the
 * L0-only CAS, and `layers_ready` says so explicitly so callers never mistake
 * "not computed yet" for "doesn't exist". The final CAS (once L1-L4 finish) is
 * byte-for-byte the same object `analyzeProjectDeferred`/`analyzeProject`
 * would have produced — layering changes WHEN facts appear, never WHAT they
 * are.
 */
import * as fs from 'fs-extra';
import * as path from 'path';
import { glob } from 'glob';
import type { CASOutput, CASLayersReady, CASLayerStatus } from '../../../packages/analyzer-core/src/types/cas.types';
import { CAS_VERSION } from '../../../packages/analyzer-core/src/types/cas.types';
import { getBuildIdentity } from '../../../packages/analyzer-core/src/analyzer/core/build-identity';

/** Same source/ignore shape as freshness.ts's mtime scan, reused here for the
 *  L0 inventory walk so "what files exist" stays consistent across the two
 *  fast, non-analyzer-pipeline passes over the tree. */
const L0_SOURCE_PATTERNS = [
  '**/*.{js,jsx,ts,tsx,mjs,cjs,py,go,rs,java,kt,cs,php,rb,swift,dart,scala,ex,exs,c,cc,cpp,h,hpp,sol,vue,svelte,sh,tf,yaml,yml}',
];

const L0_IGNORE_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/target/**',
  '**/vendor/**',
  '**/vendors/**',
  '**/.next/**',
  '**/.turbo/**',
  '**/site-packages/**',
  '**/__pycache__/**',
  '**/coverage/**',
  '**/*.min.js',
];

const EXTENSION_LANGUAGE: Record<string, string> = {
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  ts: 'TypeScript', tsx: 'TypeScript',
  py: 'Python', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', cs: 'C#',
  php: 'PHP', rb: 'Ruby', swift: 'Swift', dart: 'Dart', scala: 'Scala',
  ex: 'Elixir', exs: 'Elixir', c: 'C', cc: 'C++', cpp: 'C++', h: 'C', hpp: 'C++',
  sol: 'Solidity', vue: 'Vue', svelte: 'Svelte', sh: 'Shell',
  tf: 'Terraform', yaml: 'YAML', yml: 'YAML',
};

export interface L0Index {
  total_files: number;
  languages: Array<{ name: string; files: number }>;
  top_level_dirs: string[];
  duration_ms: number;
}

/**
 * Pure filesystem scan: file count, language breakdown by extension, and
 * top-level directory structure. No AST parsing, no analyzer registrations —
 * this is what makes it fast enough to land in well under the 2s target on a
 * real repo. Bounded by the same ignore-list every other fast scan in this
 * codebase (node_modules/dist/build/...) uses, so it doesn't walk generated
 * output or vendored trees.
 */
export async function computeL0Index(projectPath: string): Promise<L0Index> {
  const started = Date.now();
  const files = await glob(L0_SOURCE_PATTERNS, {
    cwd: projectPath,
    ignore: L0_IGNORE_PATTERNS,
    nodir: true,
    absolute: false,
  });

  const languageCounts = new Map<string, number>();
  for (const file of files) {
    const ext = path.extname(file).slice(1).toLowerCase();
    const language = EXTENSION_LANGUAGE[ext];
    if (!language) continue;
    languageCounts.set(language, (languageCounts.get(language) || 0) + 1);
  }

  let topLevelDirs: string[] = [];
  try {
    const entries = await fs.readdir(projectPath, { withFileTypes: true });
    topLevelDirs = entries
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
      .map(entry => entry.name)
      .sort();
  } catch {
    topLevelDirs = [];
  }

  const languages = Array.from(languageCounts.entries())
    .map(([name, count]) => ({ name, files: count }))
    .sort((a, b) => b.files - a.files);

  return {
    total_files: files.length,
    languages,
    top_level_dirs: topLevelDirs,
    duration_ms: Date.now() - started,
  };
}

/** The layer ladder in fixed order, with the top-level CASOutput fields each
 *  layer is responsible for. Used both to build the manifest and to decide
 *  which fields the honest partial-CAS accessors should treat as available. */
const LAYER_DEFINITIONS: Array<{ layer: CASLayerStatus['layer']; name: string; fields: string[] }> = [
  { layer: 'L0', name: 'Index / inventory', fields: ['system.technologies.languages', 'l0_index'] },
  { layer: 'L1', name: 'Nodes, entry points, routes', fields: ['nodes', 'entry_points', 'route_table'] },
  { layer: 'L2', name: 'Call graph / edges', fields: ['edges', 'method_calls', 'call_chains'] },
  { layer: 'L3', name: 'Entities, lineage, database schema', fields: ['data_entities', 'data_lineage', 'database_schema'] },
  { layer: 'L4', name: 'Flows, capabilities, contracts', fields: ['flow_graph', 'system_capabilities', 'workflows'] },
  { layer: 'L5', name: 'AI enrichment', fields: ['enhanced_system_purpose', 'system_purpose.description_source'] },
];

export function buildLayersReady(
  statuses: Partial<Record<CASLayerStatus['layer'], { status: 'pending' | 'ready' | 'error'; completedAt?: string; durationMs?: number; error?: string }>>,
  options: { generatedAt?: string } = {},
): CASLayersReady {
  const layers: CASLayerStatus[] = LAYER_DEFINITIONS.map(def => {
    const entry = statuses[def.layer];
    return {
      layer: def.layer,
      name: def.name,
      status: entry?.status ?? 'pending',
      ...(entry?.completedAt ? { completed_at: entry.completedAt } : {}),
      ...(entry?.durationMs !== undefined ? { duration_ms: entry.durationMs } : {}),
      ...(entry?.error ? { error: entry.error } : {}),
      fields: def.fields,
    };
  });
  return {
    layers,
    complete: layers.every(l => l.status === 'ready'),
    // `generated_at` must track when the CAS CONTENT was produced, not when this
    // manifest object was last minted. A no-op incremental reanalyze reuses the
    // prior output verbatim (same analysis_timestamp) and only re-stamps the
    // ladder — if generated_at defaulted to `new Date()` it would advance while
    // the content stayed frozen, so the read served a fresh-looking timestamp on
    // stale content (a benchmarked repo's 2026-07-07 reanalyze: content 16:12,
    // generated_at 23:21). Callers pass the CAS analysis_timestamp so the
    // freshness marker never lies about content age; wall-clock is only the
    // fallback when no content timestamp is available.
    generated_at: options.generatedAt || new Date().toISOString(),
  };
}

/**
 * Build the canonical completion manifest for a CAS that has finished the
 * deterministic pipeline. This belongs at the persistence boundary as well
 * as the progressive wrapper: incremental, branch, and direct worker callers
 * must never save a structurally complete CAS without an honest layer state.
 */
export function buildCompletedAnalysisLayersReady(output: CASOutput): CASLayersReady {
  const generatedAt = output.analysis_timestamp || new Date().toISOString();
  const ready = { status: 'ready' as const, completedAt: generatedAt };
  const l5 = output.ai_enrichment === 'pending'
    ? { status: 'pending' as const }
    : output.ai_enrichment === 'error'
      ? {
          status: 'error' as const,
          completedAt: generatedAt,
          error: output.ai_enrichment_error
            ? `AI comprehension pass failed (comprehension is AI-only, no deterministic fallback): ${output.ai_enrichment_error}`
            : 'AI comprehension pass failed; comprehension is AI-only (no deterministic fallback)',
        }
      : ready;

  return buildLayersReady({
    L0: ready,
    L1: ready,
    L2: ready,
    L3: ready,
    L4: ready,
    L5: l5,
  }, { generatedAt });
}

/**
 * Build a minimal-but-valid CASOutput carrying ONLY the L0 index, for the
 * seconds-long window before L1-L4 land. Every required CASOutput field is
 * present (so existing query tools don't crash on a partial store); every
 * field this CAS doesn't yet have real facts for is simply absent, and
 * `layers_ready` marks L1-L5 'pending' so callers never mistake absence for
 * "the codebase has no routes/entities/flows".
 */
export function buildL0OnlyCas(projectPath: string, displayName: string | undefined, l0: L0Index): CASOutput {
  const systemName = displayName || path.basename(projectPath);
  const now = new Date().toISOString();
  return {
    cas_version: CAS_VERSION,
    analyzer_build: getBuildIdentity().version,
    analysis_timestamp: now,
    analysis_id: `analysis_${Date.now()}_l0`,
    system: {
      id: `system_${systemName}`,
      name: systemName,
      // Provisional — the real system.type is derived from extracted nodes in
      // L1 and supersedes this once that layer lands.
      type: 'application',
      root_path: projectPath,
      technologies: {
        languages: l0.languages.map(l => ({ name: l.name, files: l.files })),
      },
    },
    nodes: [],
    edges: [],
    analyzer_contributions: [],
    progressive_levels: { total_levels: 0 },
    l0_index: l0,
    layers_ready: buildLayersReady({
      L0: { status: 'ready', completedAt: now, durationMs: l0.duration_ms },
    }),
  } as CASOutput;
}
