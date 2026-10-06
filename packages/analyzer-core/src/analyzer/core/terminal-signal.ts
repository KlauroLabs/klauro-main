import type { CASEntryPointFlow, SystemCapability } from '../../types/cas.types';















export interface RankedTerminalEntity {
  name: string;
  score: number;
  journey_count: number;
  write_journeys: number;
  read_journeys: number;
  user_facing_journeys: number;
}

export interface RankedTerminalStage {
  name: string;
  score: number;
  journey_count: number;

  min_distance_from_terminal: number;
}

export interface RankedTerminalCapability {
  name: string;
  score: number;
  matched_terminal_entities: string[];
}

export interface TerminalSignal {
  ranked_entities: RankedTerminalEntity[];

  ranked_stages: RankedTerminalStage[];
  ranked_capabilities: RankedTerminalCapability[];





  domain_seed_text: string;
}

const WRITE_ACCESS = new Set(['created', 'updated', 'deleted']);
const WRITE_WEIGHT = 3;
const READ_WEIGHT = 1;
const USER_FACING_MULTIPLIER = 2;
const NODE_TERMINAL_MULTIPLIER = 0.5;
const STAGE_DECAY = 0.7;
const STAGE_SEGMENT_LEVELS = 3;
const STAGE_LAYERS = new Set(['business', 'data']);
const TOP_ENTITY_LIMIT = 8;
const TOP_STAGE_LIMIT = 8;
const TOP_CAPABILITY_LIMIT = 8;





const HTTP_VERB_NAMES = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'request', 'response']);
const LIFECYCLE_NAMES = new Set([
  'main', 'build', 'dispose', 'initstate', 'init', 'setup', 'render', 'constructor', '__construct',
  'componentdidmount', 'componentwillunmount', 'ngoninit', 'ngondestroy', 'mounted', 'unmounted',
]);
const UTILITY_NAME_PATTERN = /^(get|set|is|has|to|from|on|handle|format|parse|find|create(?:Empty)?Default)[A-Z_]/;
const HOOK_USAGE_PATTERN = /^use[A-Z0-9].*|^use[A-Z0-9].*\susage$|\susage$/;
const LOWERCASE_UTILITY_NAMES = new Set([
  'find', 'parse', 'format', 'render', 'setup', 'init', 'handle', 'request', 'response',
  'data', 'item', 'items', 'state', 'status', 'config', 'options', 'props', 'context',
]);









function isHashOrIdShapedName(raw: string): boolean {
  const normalized = (raw || '').toLowerCase();
  if (normalized.length < 8) return false;
  if (/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/.test(normalized)) return true;
  if (normalized.length >= 12 && /^[0-9a-f]+$/.test(normalized)) return true;
  if (normalized.length >= 10 && /^[0-9a-z]+$/.test(normalized) && /[0-9]/.test(normalized) && !/[aeiou]/.test(normalized)) {
    return true;
  }
  return false;
}

function isNoiseTerminalName(raw: string): boolean {
  const name = (raw || '').trim();
  if (!name) return true;
  if (isHashOrIdShapedName(name)) return true;

  if (name.startsWith('_')) return true;



  if (/(exception|error)s?$/i.test(name)) return true;

  if (/^(src|lib|app|apps|dist|build|out|pkg|bin|test|tests|main|index|core|common|shared|utils?)$/i.test(name)) return true;
  const lower = name.toLowerCase();
  if (HTTP_VERB_NAMES.has(lower) || LIFECYCLE_NAMES.has(lower)) return true;
  if (HOOK_USAGE_PATTERN.test(name)) return true;
  if (UTILITY_NAME_PATTERN.test(name)) return true;



  if (LOWERCASE_UTILITY_NAMES.has(lower)) return true;
  return false;
}

export function buildTerminalSignal(input: {
  journeys: CASEntryPointFlow[];
  systemCapabilities: SystemCapability[];
}): TerminalSignal {
  const byEntity = new Map<string, RankedTerminalEntity>();
  const byStage = new Map<string, RankedTerminalStage>();

  for (const journey of input.journeys || []) {
    const kindMultiplier = journey.flow_kind === 'user-facing' ? USER_FACING_MULTIPLIER : 1;

    const seenEntities = new Set<string>();
    for (const terminal of journey.terminal_entities || []) {
      const name = normalizeName(terminal.name);
      if (!name || isNoiseTerminalName(name)) continue;
      const isWrite = WRITE_ACCESS.has(terminal.access);
      const accessWeight = isWrite ? WRITE_WEIGHT : READ_WEIGHT;
      const kindWeight = terminal.terminal_kind === 'entity' ? 1 : NODE_TERMINAL_MULTIPLIER;
      const entry = byEntity.get(name) || {
        name,
        score: 0,
        journey_count: 0,
        write_journeys: 0,
        read_journeys: 0,
        user_facing_journeys: 0,
      };
      entry.score += accessWeight * kindMultiplier * kindWeight;
      if (!seenEntities.has(name)) {
        seenEntities.add(name);
        entry.journey_count += 1;
        if (isWrite) entry.write_journeys += 1;
        else entry.read_journeys += 1;
        if (journey.flow_kind === 'user-facing') entry.user_facing_journeys += 1;
      }
      byEntity.set(name, entry);
    }



    const stageSteps = (journey.steps || []).filter(step => STAGE_LAYERS.has(step.layer));
    if (stageSteps.length === 0) continue;
    const maxDepth = Math.max(...stageSteps.map(step => step.depth));
    const seenStages = new Set<string>();
    for (const step of stageSteps) {
      const distance = maxDepth - step.depth;
      if (distance >= STAGE_SEGMENT_LEVELS) continue;
      const name = normalizeName(step.name);
      if (!name || isNoiseTerminalName(name)) continue;
      const weight = Math.pow(STAGE_DECAY, distance) * kindMultiplier;
      const entry = byStage.get(name) || {
        name,
        score: 0,
        journey_count: 0,
        min_distance_from_terminal: distance,
      };
      entry.score += weight;
      entry.min_distance_from_terminal = Math.min(entry.min_distance_from_terminal, distance);
      if (!seenStages.has(name)) {
        seenStages.add(name);
        entry.journey_count += 1;
      }
      byStage.set(name, entry);
    }
  }

  const rankedEntities = Array.from(byEntity.values())
    .sort((a, b) =>
      b.score - a.score ||
      b.write_journeys - a.write_journeys ||
      b.journey_count - a.journey_count ||
      a.name.localeCompare(b.name)
    )
    .slice(0, TOP_ENTITY_LIMIT);

  const rankedStages = Array.from(byStage.values())
    .sort((a, b) =>
      b.score - a.score ||
      a.min_distance_from_terminal - b.min_distance_from_terminal ||
      a.name.localeCompare(b.name)
    )
    .slice(0, TOP_STAGE_LIMIT);

  const terminalEntityNames = new Set(rankedEntities.map(entity => entity.name.toLowerCase()));
  const rankedCapabilities = (input.systemCapabilities || [])
    .map(capability => {
      const related = (capability.related_entities || [])
        .map(entity => normalizeName(String(entity)))
        .filter(name => name && terminalEntityNames.has(name.toLowerCase()));
      const terminalRankBonus = related.reduce((sum, name) => {
        const match = rankedEntities.find(entity => entity.name.toLowerCase() === name.toLowerCase());
        return sum + (match ? match.score : 0);
      }, 0);
      return {
        name: capability.name,
        score: terminalRankBonus,
        matched_terminal_entities: Array.from(new Set(related)),
      };
    })
    .filter(capability => capability.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, TOP_CAPABILITY_LIMIT);

  return {
    ranked_entities: rankedEntities,
    ranked_stages: rankedStages,
    ranked_capabilities: rankedCapabilities,
    domain_seed_text: buildDomainSeedText(rankedEntities, rankedStages, rankedCapabilities),
  };
}





function buildDomainSeedText(
  entities: RankedTerminalEntity[],
  stages: RankedTerminalStage[],
  capabilities: RankedTerminalCapability[]
): string {
  const parts: string[] = [];
  entities.forEach((entity, index) => {
    const repeats = Math.max(1, entities.length - index);
    for (let i = 0; i < repeats; i++) parts.push(entity.name);
  });
  stages.forEach((stage, index) => {
    const repeats = Math.max(1, Math.ceil((stages.length - index) / 2));
    for (let i = 0; i < repeats; i++) parts.push(stage.name);
  });
  capabilities.forEach(capability => parts.push(capability.name));
  return parts
    .join(' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-./]/g, ' ')
    .toLowerCase();
}

function normalizeName(raw: string): string {
  const trimmed = (raw || '').trim();
  if (!trimmed) return '';
  if (/^(entity|node)[:_]/i.test(trimmed)) {
    const tail = trimmed.split(/[:_]/).pop() || '';
    return tail.trim();
  }
  return trimmed;
}
