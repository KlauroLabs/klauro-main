import { loadKlauroConfig } from './klauro-config';

/**
 * Opt-out control for dynamic/heavy context sections (runtime telemetry,
 * communication seams, runtime topology) that the context/summary read tools
 * inject. Some users/tasks want a pure static view: runtime data is
 * environment-specific, can be stale, or is simply unwanted noise. This module
 * resolves a single, backward-compatible decision — which sections to omit —
 * from three layers with clear precedence:
 *
 *   explicit param  >  env (KLAURO_CONTEXT_RUNTIME)  >  .klaurorc (context.runtime)  >  default
 *
 * The default is 'auto', which reproduces the pre-existing task-type-gated
 * behavior byte-for-byte (nothing is forced on or off). 'exclude' is a real
 * token reduction: excluded sections are skipped, not blanked — callers must
 * avoid computing them when this reports them excluded.
 */

export type ContextRuntimeMode = 'include' | 'exclude' | 'auto';

/** Canonical section keys that the runtime opt-out governs. */
export type DynamicSection = 'runtime' | 'seams' | 'topology';

/**
 * Free-form section names an agent may pass in `exclude_sections` mapped to the
 * canonical key. Accepts the common synonyms so `"telemetry"`, `"observations"`,
 * or `"communication_seams"` all resolve to the right internal section.
 */
const SECTION_ALIASES: Record<string, DynamicSection> = {
  runtime: 'runtime',
  telemetry: 'runtime',
  observations: 'runtime',
  runtime_observations: 'runtime',
  operational_priorities: 'runtime',
  operational: 'runtime',
  runtime_static_links: 'runtime',
  seams: 'seams',
  seam: 'seams',
  communication_seams: 'seams',
  topology: 'topology',
  runtime_topology: 'topology',
};

export function normalizeContextRuntimeMode(value: unknown): ContextRuntimeMode | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'include' || normalized === 'exclude' || normalized === 'auto') {
    return normalized;
  }
  return undefined;
}

/** Map an arbitrary caller-supplied section name onto a canonical section, or null. */
export function canonicalizeSection(name: string): DynamicSection | null {
  const key = name.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return SECTION_ALIASES[key] || null;
}

export interface ContextRuntimeModeInputs {
  /** Explicit `runtime` param from the tool call. Highest precedence. */
  param?: unknown;
  /** Raw env value, defaults to process.env.KLAURO_CONTEXT_RUNTIME. */
  env?: string;
  /** `.klaurorc` context.runtime value (already loaded). */
  config?: unknown;
}

/**
 * Resolve the runtime mode from param > env > config > 'auto'. Invalid values
 * at any layer are ignored (fall through to the next layer), so a typo never
 * silently changes behavior.
 */
export function resolveContextRuntimeMode(inputs: ContextRuntimeModeInputs): ContextRuntimeMode {
  return (
    normalizeContextRuntimeMode(inputs.param) ??
    normalizeContextRuntimeMode(inputs.env ?? process.env.KLAURO_CONTEXT_RUNTIME) ??
    normalizeContextRuntimeMode(inputs.config) ??
    'auto'
  );
}

export interface ResolvedSectionFilter {
  /** Resolved runtime mode after precedence. */
  runtime_mode: ContextRuntimeMode;
  /** Canonical sections explicitly excluded (runtime mode + exclude_sections). */
  excluded: Set<DynamicSection>;
  /** True when the section is omitted from the response and must not be computed. */
  isExcluded(section: DynamicSection): boolean;
}

export interface SectionFilterInputs extends ContextRuntimeModeInputs {
  /** Free-form section names to drop, e.g. ["runtime","seams","topology"]. */
  exclude_sections?: unknown;
}

/**
 * Combine the runtime mode and any `exclude_sections` list into a single
 * predicate. When runtime_mode is 'exclude', every dynamic section (runtime,
 * seams, topology) is excluded. `exclude_sections` can additionally drop
 * individual sections regardless of the runtime mode. 'include' and 'auto'
 * never add exclusions on their own (auto preserves today's gated behavior;
 * include is a hint that a downstream gate may still choose not to compute a
 * section when there is nothing to show).
 */
export function resolveSectionFilter(inputs: SectionFilterInputs): ResolvedSectionFilter {
  const runtimeMode = resolveContextRuntimeMode(inputs);
  const excluded = new Set<DynamicSection>();

  if (runtimeMode === 'exclude') {
    excluded.add('runtime');
    excluded.add('seams');
    excluded.add('topology');
  }

  if (Array.isArray(inputs.exclude_sections)) {
    for (const raw of inputs.exclude_sections) {
      if (typeof raw !== 'string') continue;
      const canonical = canonicalizeSection(raw);
      if (canonical) excluded.add(canonical);
    }
  }

  return {
    runtime_mode: runtimeMode,
    excluded,
    isExcluded: (section: DynamicSection) => excluded.has(section),
  };
}

/**
 * Server-boundary convenience: load `.klaurorc` for the project and resolve the
 * full section filter from param + env + config in one call. Config-load
 * failures degrade to param+env only (never crash a read tool).
 */
export async function resolveSectionFilterForProject(
  path: string,
  opts: { runtime?: unknown; exclude_sections?: unknown } = {},
): Promise<ResolvedSectionFilter> {
  let configRuntime: unknown;
  try {
    const loaded = await loadKlauroConfig(path);
    configRuntime = loaded.config.context?.runtime;
  } catch {
    configRuntime = undefined;
  }
  return resolveSectionFilter({
    param: opts.runtime,
    config: configRuntime,
    exclude_sections: opts.exclude_sections,
  });
}
