import { loadKlauroConfig } from './klauro-config';

















export type ContextRuntimeMode = 'include' | 'exclude' | 'auto';


export type DynamicSection = 'runtime' | 'seams' | 'topology';






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


export function canonicalizeSection(name: string): DynamicSection | null {
  const key = name.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return SECTION_ALIASES[key] || null;
}

export interface ContextRuntimeModeInputs {

  param?: unknown;

  env?: string;

  config?: unknown;
}






export function resolveContextRuntimeMode(inputs: ContextRuntimeModeInputs): ContextRuntimeMode {
  return (
    normalizeContextRuntimeMode(inputs.param) ??
    normalizeContextRuntimeMode(inputs.env ?? process.env.KLAURO_CONTEXT_RUNTIME) ??
    normalizeContextRuntimeMode(inputs.config) ??
    'auto'
  );
}

export interface ResolvedSectionFilter {

  runtime_mode: ContextRuntimeMode;

  excluded: Set<DynamicSection>;

  isExcluded(section: DynamicSection): boolean;
}

export interface SectionFilterInputs extends ContextRuntimeModeInputs {

  exclude_sections?: unknown;
}










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
