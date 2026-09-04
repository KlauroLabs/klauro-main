






























import * as fs from 'fs-extra';
import * as path from 'path';
import { glob } from 'glob';
import type { CASOutput, CASLayersReady, CASLayerStatus } from '../../../packages/analyzer-core/src/types/cas.types';
import { CAS_VERSION } from '../../../packages/analyzer-core/src/types/cas.types';
import { getBuildIdentity } from '../../../packages/analyzer-core/src/analyzer/core/build-identity';




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




const LAYER_DEFINITIONS: Array<{ layer: CASLayerStatus['layer']; name: string; fields: string[] }> = [
  { layer: 'L0', name: 'Index / inventory', fields: ['system.technologies.languages', 'l0_index'] },
  { layer: 'L1', name: 'Nodes, entry points, routes', fields: ['nodes', 'entry_points', 'route_table'] },
  { layer: 'L2', name: 'Call graph / edges', fields: ['edges', 'method_calls', 'call_chains'] },
  { layer: 'L3', name: 'Entities, lineage, database schema', fields: ['entities', 'data_lineage', 'database_schema'] },
  { layer: 'L4', name: 'Canonical comprehension', fields: ['capabilities', 'flows', 'steps', 'entities'] },
  { layer: 'L5', name: 'AI enrichment', fields: ['enhanced_system_purpose', 'system_purpose.description_source'] },
];

export function buildLayersReady(
  statuses: Partial<Record<CASLayerStatus['layer'], { status: 'pending' | 'ready' | 'error'; completedAt?: string; durationMs?: number; error?: string; warning?: string }>>,
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
      ...(entry?.warning ? { warning: entry.warning } : {}),
      fields: def.fields,
    };
  });
  return {
    layers,
    complete: layers.every(l => l.status === 'ready'),









    generated_at: options.generatedAt || new Date().toISOString(),
  };
}







// Source coverage gaps degrade confidence, never existence. A single oversized
// or partially parsed file is reported on the structural layers as a warning;
// the analysis only errors when coverage is unknowable (scope unreported) or
// when nothing was extracted at all, because then there is no product to
// describe rather than a product described from incomplete evidence.
function analyzerCoverage(output: CASOutput): { error?: string; warning?: string } {
  const incomplete: string[] = [];
  const unknown: string[] = [];
  let totalEligible = 0;
  let totalAnalyzed = 0;
  for (const contribution of output.analyzer_contributions || []) {
    const scope = contribution.analysis_scope;
    if (!scope) {
      unknown.push(contribution.analyzer_id);
      continue;
    }
    if (scope.applicability === 'not-applicable') {
      if ((contribution.files_created || 0) > 0) incomplete.push(contribution.analyzer_id);
      continue;
    }
    const eligible = Number(scope.files_eligible);
    const analyzed = Number(scope.files_analyzed);
    const skipped = Number(scope.files_skipped);
    if (!Number.isFinite(eligible) || !Number.isFinite(analyzed) || !Number.isFinite(skipped)) {
      unknown.push(contribution.analyzer_id);
      continue;
    }
    totalEligible += eligible;
    totalAnalyzed += analyzed;
    const partial = Number(scope.files_partial) || 0;
    if (scope.complete === false || analyzed < eligible || skipped > 0 || partial > 0) {
      const detail = [
        `analyzed ${analyzed} of ${eligible}`,
        ...(skipped > 0 ? [`${skipped} skipped`] : []),
        ...(partial > 0 ? [`${partial} partially parsed`] : []),
      ].join(', ');
      incomplete.push(`${contribution.analyzer_id} (${detail})`);
    }
  }
  const errors: string[] = [];
  if (unknown.length > 0) errors.push(`scope unreported for analyzer(s): ${unknown.join(', ')}`);
  if (totalEligible > 0 && totalAnalyzed === 0) errors.push(`no eligible source file was analyzed (${totalEligible} eligible)`);
  if (errors.length > 0) return { error: `Canonical source extraction is unavailable: ${errors.join('; ')}` };
  if (incomplete.length > 0) return { warning: `Canonical source extraction is partial for analyzer(s): ${incomplete.join('; ')}` };
  return {};
}

function canonicalCapabilityCount(output: CASOutput): number {
  const catalog = (output.capabilities || []).length > 0
    ? output.capabilities || []
    : output.product_map?.capabilities || [];
  return new Set(catalog.map(capability => String(
    ('id' in capability ? capability.id : undefined) || capability.name || ''
  ).trim()).filter(Boolean)).size;
}

export function buildCompletedAnalysisLayersReady(output: CASOutput): CASLayersReady {
  const generatedAt = output.analysis_timestamp || new Date().toISOString();
  const ready = { status: 'ready' as const, completedAt: generatedAt };
  const coverage = analyzerCoverage(output);
  const extractionError = coverage.error;
  const structural = extractionError
    ? { status: 'error' as const, completedAt: generatedAt, error: extractionError }
    : coverage.warning
      ? { ...ready, warning: coverage.warning }
      : ready;
  const catalogCoverage = output.enhanced_system_purpose?.capability_catalog_coverage;
  const canonicalCapabilities = canonicalCapabilityCount(output);
  const catalogError = !catalogCoverage
    ? 'Capability comprehension is unavailable: catalog coverage was not reported'
    : catalogCoverage.status !== 'accepted'
      ? `Capability comprehension is ${catalogCoverage.status}: ${catalogCoverage.reason || `${catalogCoverage.published_capabilities || 0} evidence-grounded capabilities were published`}`
      : catalogCoverage.published_capabilities !== canonicalCapabilities
        ? `Capability comprehension is inconsistent: coverage reports ${catalogCoverage.published_capabilities} published capabilities but the canonical catalog contains ${canonicalCapabilities}`
        : undefined;
  const l4 = extractionError
    ? structural
    : catalogError
    ? { status: 'error' as const, completedAt: generatedAt, error: catalogError }
    : ready;
  const l5 = extractionError
    ? structural
    : output.ai_enrichment === 'pending'
    ? { status: 'pending' as const }
    : output.ai_enrichment === 'error'
      ? {
          status: 'error' as const,
          completedAt: generatedAt,
          error: output.ai_enrichment_error
            ? `AI comprehension pass failed (comprehension is AI-only, no deterministic fallback): ${output.ai_enrichment_error}`
            : 'AI comprehension pass failed; comprehension is AI-only (no deterministic fallback)',
        }
      : output.ai_enrichment === 'disabled'
        ? {
            status: 'error' as const,
            completedAt: generatedAt,
            error: 'AI comprehension is disabled; required product narrative and capability comprehension were not generated',
          }
        : catalogError || output.enhanced_system_purpose?.ai_phase_status === 'degraded'
          ? {
              status: 'error' as const,
              completedAt: generatedAt,
              error: catalogError || 'AI comprehension completed with rejected required output',
            }
          : ready;

  return buildLayersReady({
    L0: structural,
    L1: structural,
    L2: structural,
    L3: structural,
    L4: l4,
    L5: l5,
  }, { generatedAt });
}









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
