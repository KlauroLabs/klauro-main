export const RESPONSE_BUDGET_BYTES = 20_000;

const ENVELOPE_RESERVE_BYTES = 3_072;
const MAX_REPORTED_TRUNCATED_PATHS = 20;
const MIN_STRING_KEEP_CHARS = 256;
const STRING_TRUNCATION_SUFFIX = '...[truncated]';
const MAX_SHRINK_PASSES = 20;

export interface TruncatedPath {
  path: string;
  kind: 'array' | 'string';
  total: number;
  returned: number;
}

export interface BoundOptions {
  tool: string;
  budgetBytes?: number;
  parameterNames?: string[];
  viaGateway?: boolean;
}

export interface BoundedEnvelope {
  truncated: true;
  has_more: true;
  full_size_bytes: number;
  budget_bytes: number;
  truncated_path_count: number;
  truncated_paths: TruncatedPath[];
  continuation: string[];
  data: unknown;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

export function serializeToolResponse(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[\n${value.map(item => JSON.stringify(item)).join(',\n')}\n]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined);
    if (entries.length === 0) return '{}';
    return `{\n${entries.map(([key, item]) => `${JSON.stringify(key)}: ${JSON.stringify(item)}`).join(',\n')}\n}`;
  }
  return JSON.stringify(value);
}






















const FACT_ARRAY_PATH_SUFFIXES = [
  'scale.database_entities',
  'system.languages',
  'system.frameworks',
  'system.top_capabilities',
] as const;

function isFactArrayPath(path: string): boolean {
  return FACT_ARRAY_PATH_SUFFIXES.some(suffix => path === suffix || path.endsWith(`.${suffix}`));
}

interface ShrinkCandidate {
  path: string;
  kind: 'array' | 'string';
  size: number;
  container: Record<string, unknown> | unknown[];
  key: string | number;
}

function collectCandidates(value: unknown, path: string, container: Record<string, unknown> | unknown[] | null, key: string | number, out: ShrinkCandidate[]): void {
  if (typeof value === 'string') {
    if (container && value.length > MIN_STRING_KEEP_CHARS) {
      out.push({ path, kind: 'string', size: byteLength(value), container, key });
    }
    return;
  }
  if (Array.isArray(value)) {



    if (container && value.length > 1 && !isFactArrayPath(path)) {
      out.push({ path, kind: 'array', size: byteLength(JSON.stringify(value)), container, key });
    }
    value.forEach((item, index) => collectCandidates(item, `${path}[${index}]`, value, index, out));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      const childPath = path ? `${path}.${childKey}` : childKey;
      collectCandidates(childValue, childPath, value as Record<string, unknown>, childKey, out);
    }
  }
}

interface TrimRecord {
  kind: 'array' | 'string';
  total: number;
  current: () => number;
}

function shrinkToBudget(root: { data: unknown }, targetBytes: number): Map<string, TrimRecord> {
  const trims = new Map<string, TrimRecord>();
  for (let pass = 0; pass < MAX_SHRINK_PASSES; pass++) {
    const serialized = JSON.stringify(root.data);
    let remainingExcess = byteLength(serialized) - targetBytes;
    if (remainingExcess <= 0) break;

    const candidates: ShrinkCandidate[] = [];
    collectCandidates(root.data, '', null, '', candidates);
    if (candidates.length === 0) break;
    candidates.sort((a, b) => b.size - a.size);

    let shrankAny = false;
    for (const candidate of candidates) {
      if (remainingExcess <= 0) break;
      if (candidate.kind === 'array') {
        const array = (candidate.container as Record<string | number, unknown>)[candidate.key];
        if (!Array.isArray(array) || array.length <= 1) continue;
        const averageItemBytes = Math.max(1, Math.ceil(candidate.size / array.length));
        const remove = Math.min(array.length - 1, Math.max(1, Math.ceil(remainingExcess / averageItemBytes)));
        if (!trims.has(candidate.path)) {
          const trimmedArray = array;
          trims.set(candidate.path, { kind: 'array', total: array.length, current: () => trimmedArray.length });
        }
        array.length = array.length - remove;
        remainingExcess -= remove * averageItemBytes;
        shrankAny = true;
      } else {
        const container = candidate.container as Record<string | number, unknown>;
        const original = container[candidate.key];
        if (typeof original !== 'string') continue;
        const priorSuffix = original.endsWith(STRING_TRUNCATION_SUFFIX)
          ? original.slice(0, -STRING_TRUNCATION_SUFFIX.length)
          : original;
        const keep = Math.max(MIN_STRING_KEEP_CHARS, priorSuffix.length - Math.max(remainingExcess, Math.ceil(priorSuffix.length / 8)));
        if (keep >= priorSuffix.length) continue;
        if (!trims.has(candidate.path)) {
          trims.set(candidate.path, {
            kind: 'string',
            total: priorSuffix.length,
            current: () => {
              const value = container[candidate.key];
              if (typeof value !== 'string') return 0;
              return value.endsWith(STRING_TRUNCATION_SUFFIX) ? value.length - STRING_TRUNCATION_SUFFIX.length : value.length;
            },
          });
        }
        container[candidate.key] = priorSuffix.slice(0, keep) + STRING_TRUNCATION_SUFFIX;
        remainingExcess -= priorSuffix.length - keep;
        shrankAny = true;
      }
    }
    if (!shrankAny) break;
  }
  return trims;
}

export function buildContinuation(options: BoundOptions, truncatedPaths: TruncatedPath[]): string[] {
  const budget = options.budgetBytes ?? RESPONSE_BUDGET_BYTES;
  const lines: string[] = [
    `Response exceeded the ${budget}-byte budget; large collections under 'data' were truncated in place.`,
  ];
  const parameterNames = (options.parameterNames ?? []).filter(name => name !== 'path');
  const pagingParameters = parameterNames.filter(name => ['limit', 'offset', 'cursor', 'page'].includes(name));
  if (pagingParameters.length > 0) {
    lines.push(`Page through the full data by re-running '${options.tool}' with ${pagingParameters.join(' and ')} (e.g. smaller limit plus increasing offset).`);
  }
  const filterParameters = parameterNames.filter(name => !pagingParameters.includes(name));
  if (filterParameters.length > 0) {
    lines.push(`Narrow the result by re-running '${options.tool}' with more specific parameters: ${filterParameters.join(', ')}.`);
  }
  if (parameterNames.length === 0) {
    lines.push(`'${options.tool}' takes no narrowing parameters; the truncated_paths entries show exactly what was cut.`);
  }
  if (options.viaGateway) {
    lines.push(`In this profile call it as klauro_query { tool: '${options.tool}', args: { ... } }.`);
  }
  if (truncatedPaths.length > 0) {
    lines.push('Do not save this response to disk for re-parsing; issue narrower queries instead.');
  }
  return lines;
}

export function boundToolPayload(data: unknown, options: BoundOptions): unknown {
  const budget = options.budgetBytes ?? RESPONSE_BUDGET_BYTES;
  const fullSize = byteLength(JSON.stringify(data));
  if (fullSize <= budget) return data;

  const root = { data: structuredClone(data) };
  const trims = shrinkToBudget(root, Math.max(budget - ENVELOPE_RESERVE_BYTES, 1024));
  const allTruncatedPaths: TruncatedPath[] = [...trims.entries()].map(([path, record]) => ({
    path: path || '(root)',
    kind: record.kind,
    total: record.total,
    returned: record.current(),
  }));





  const truncatedPaths = [...allTruncatedPaths]
    .sort((a, b) => {
      const lostFraction = (record: TruncatedPath) =>
        record.total > 0 ? (record.total - record.returned) / record.total : 0;
      return (lostFraction(b) - lostFraction(a)) || ((b.total - b.returned) - (a.total - a.returned));
    })
    .slice(0, MAX_REPORTED_TRUNCATED_PATHS);

  const envelope: BoundedEnvelope = {
    truncated: true,
    has_more: true,
    full_size_bytes: fullSize,
    budget_bytes: budget,
    truncated_path_count: allTruncatedPaths.length,
    truncated_paths: truncatedPaths,
    continuation: buildContinuation(options, truncatedPaths),
    data: root.data,
  };

  if (byteLength(JSON.stringify(envelope)) > budget) {
    envelope.data = {
      note: 'Payload omitted: response could not be structurally truncated under the budget. Re-run with narrower parameters.',
    };
  }
  return envelope;
}

export function boundToolText(text: string, options: BoundOptions): string {
  const budget = options.budgetBytes ?? RESPONSE_BUDGET_BYTES;
  if (byteLength(text) <= budget) return text;
  const notice = [
    '',
    `...[truncated: full response is ${byteLength(text)} bytes, over the ${budget}-byte budget.`,
    `Re-run '${options.tool}' with narrower parameters${options.viaGateway ? ` via klauro_query { tool: '${options.tool}', args: { ... } }` : ''}.]`,
  ].join('\n');
  let keep = budget - byteLength(notice);
  while (keep > 0 && byteLength(text.slice(0, keep)) > budget - byteLength(notice)) {
    keep = Math.floor(keep * 0.9);
  }
  return text.slice(0, Math.max(keep, 0)) + notice;
}
