import type { CASUserJourney, CASUserJourneyStep, CASGuardKind } from '../../../packages/analyzer-core/src/types/cas.types';
import { classifyGuardKind } from '../../../packages/analyzer-core/src/analyzer/core/guard-classification';

// Presentation-only helpers for stored user journeys. Every function reads
// fields already present on the CAS journey; nothing here recomputes
// relationships, chains, or effects.

const STEP_COMPRESSION_THRESHOLD = 7;
const STEP_COMPRESSION_LEADING = 3;
const STEP_COMPRESSION_TRAILING = 2;

export function humanizeIdentifier(value: string): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/[\s/]/.test(raw)) return raw;
  const segments = raw
    .split(/[#.]/)
    .filter(Boolean);
  const last = segments[segments.length - 1] || raw;
  const words = last
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  if (!words) return raw;
  return words
    .split(' ')
    .map(word => (word === word.toUpperCase() && word.length > 1 ? word : word.toLowerCase()))
    .join(' ');
}

export function journeyStepLabel(step: Pick<CASUserJourneyStep, 'name'>): string {
  return humanizeIdentifier(step?.name || '');
}

export function journeyEntryLabel(journey: Pick<CASUserJourney, 'entry'>): string {
  const entry = journey.entry;
  if (!entry) return '';
  if (entry.method && entry.path_or_trigger) return `${entry.method} ${entry.path_or_trigger}`;
  if (entry.path_or_trigger) return entry.path_or_trigger;
  return entry.name || '';
}

export function journeyTitle(journey: Pick<CASUserJourney, 'name' | 'entry'>): string {
  const stored = String(journey.name || '').trim();
  const beforeArrow = stored.split('->')[0].trim();
  const withoutEntrySuffix = beforeArrow.replace(/\s*\((GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s[^)]*\)\s*$/i, '').trim();
  if (withoutEntrySuffix) {
    return withoutEntrySuffix.charAt(0).toUpperCase() + withoutEntrySuffix.slice(1);
  }
  const entry = journeyEntryLabel(journey);
  const fallback = humanizeIdentifier(entry);
  return fallback ? fallback.charAt(0).toUpperCase() + fallback.slice(1) : 'Journey';
}

function joinWithMore(names: string[], cap: number): string {
  if (names.length <= cap) return names.join(', ');
  return `${names.slice(0, cap).join(', ')} +${names.length - cap} more`;
}

const ACCESS_VERBS: Record<string, string> = {
  created: 'creates',
  updated: 'updates',
  deleted: 'deletes',
  read: 'reads',
};

export function journeyOutcomePhrase(
  journey: Pick<CASUserJourney, 'terminal_entities' | 'terminal_effects'>
): string {
  const terminals = journey.terminal_entities || [];
  const byAccess = new Map<string, string[]>();
  for (const terminal of terminals) {
    if (!terminal?.name) continue;
    const names = byAccess.get(terminal.access) || [];
    if (!names.includes(terminal.name)) names.push(terminal.name);
    byAccess.set(terminal.access, names);
  }
  const writes: string[] = [];
  for (const access of ['created', 'updated', 'deleted'] as const) {
    const names = byAccess.get(access);
    if (names?.length) writes.push(`${ACCESS_VERBS[access]} ${joinWithMore(names, 3)}`);
  }
  if (writes.length > 0) return writes.join(', ');
  const written = journey.terminal_effects?.entities_written || [];
  if (written.length > 0) return `writes ${joinWithMore(written, 3)}`;
  const readNames = byAccess.get('read') || journey.terminal_effects?.entities_read || [];
  if (readNames.length > 0) return `reads ${joinWithMore(readNames, 3)}`;
  return '';
}

export interface GuardBoundary {
  name: string;
  kind?: CASGuardKind;
}

export function guardBoundaryKind(boundary: GuardBoundary): CASGuardKind {
  return boundary.kind || classifyGuardKind(boundary.name);
}

const GUARD_KIND_ORDER: CASGuardKind[] = ['authentication', 'authorization', 'rate-limiting', 'validation', 'unknown'];

const GUARD_KIND_LABELS: Record<CASGuardKind, string> = {
  authentication: 'auth',
  authorization: 'authorization',
  'rate-limiting': 'rate-limited',
  validation: 'validation',
  unknown: '',
};

// "guarded" must never conflate rate limiting with authentication: a journey
// whose only guard is a throttler renders "rate-limited (...), no auth guard"
// so protection is never overstated.
export function guardPhraseForBoundaries(boundaries: GuardBoundary[]): string {
  const byKind = new Map<CASGuardKind, string[]>();
  const seen = new Set<string>();
  for (const boundary of boundaries || []) {
    if (!boundary?.name || seen.has(boundary.name)) continue;
    seen.add(boundary.name);
    const kind = guardBoundaryKind(boundary);
    const names = byKind.get(kind) || [];
    names.push(boundary.name);
    byKind.set(kind, names);
  }
  if (seen.size === 0) return 'unguarded';

  const hasAuth = byKind.has('authentication');
  const kindsPresent = GUARD_KIND_ORDER.filter(kind => byKind.has(kind));

  if (!hasAuth && kindsPresent.length === 1 && kindsPresent[0] === 'rate-limiting') {
    return `rate-limited (${joinWithMore(byKind.get('rate-limiting')!, 2)}), no auth guard`;
  }

  const segments = kindsPresent.map(kind => {
    const names = joinWithMore(byKind.get(kind)!, 2);
    const label = GUARD_KIND_LABELS[kind];
    return label ? `${label}: ${names}` : names;
  });
  return `guarded (${segments.join('; ')})${hasAuth ? '' : ', no auth guard'}`;
}

export function journeyGuardPhrase(journey: Pick<CASUserJourney, 'security_boundaries'>): string {
  return guardPhraseForBoundaries(journey.security_boundaries || []);
}

export function journeyTestPhrase(journey: Pick<CASUserJourney, 'tests_covering'>): string {
  const count = (journey.tests_covering || []).length;
  if (count === 0) return 'no tests';
  return count === 1 ? '1 test' : `${count} tests`;
}

export function journeyHeadline(journey: CASUserJourney): string {
  const title = journeyTitle(journey);
  const entry = journeyEntryLabel(journey);
  const outcome = journeyOutcomePhrase(journey);
  const stepCount = (journey.steps || []).length;
  const chain = [entry, outcome].filter(Boolean).join(' -> ');
  const facts = [
    stepCount > 0 ? `${stepCount} step${stepCount === 1 ? '' : 's'}` : '',
    journeyGuardPhrase(journey),
    journeyTestPhrase(journey),
  ].filter(Boolean).join(', ');
  return `${title}: ${chain}${facts ? `; ${facts}` : ''}`;
}

export interface CompressedJourneySteps {
  leading: CASUserJourneyStep[];
  omitted: number;
  trailing: CASUserJourneyStep[];
}

// Steps shown to humans: the raw chain repeats the entry as handler, route,
// and controller steps. Keep the chain intact in stored data; for display,
// drop steps whose label duplicates the entry label or the previous step.
export function displayJourneySteps(
  journey: Pick<CASUserJourney, 'steps' | 'entry'>
): CASUserJourneyStep[] {
  const entryLabel = journeyEntryLabel(journey).toLowerCase();
  const result: CASUserJourneyStep[] = [];
  let previousLabel = '';
  for (const step of journey.steps || []) {
    const label = journeyStepLabel(step).toLowerCase();
    if (!label) continue;
    if (label === entryLabel) continue;
    if (label === previousLabel) continue;
    result.push(step);
    previousLabel = label;
  }
  return result.length > 0 ? result : (journey.steps || []);
}

export function compressJourneySteps(steps: CASUserJourneyStep[]): CompressedJourneySteps {
  const all = steps || [];
  if (all.length <= STEP_COMPRESSION_THRESHOLD) {
    return { leading: all, omitted: 0, trailing: [] };
  }
  return {
    leading: all.slice(0, STEP_COMPRESSION_LEADING),
    omitted: all.length - STEP_COMPRESSION_LEADING - STEP_COMPRESSION_TRAILING,
    trailing: all.slice(all.length - STEP_COMPRESSION_TRAILING),
  };
}

export function journeyStepPhrase(journey: Pick<CASUserJourney, 'steps' | 'entry'>): string {
  const { leading, omitted, trailing } = compressJourneySteps(displayJourneySteps(journey));
  const parts = leading.map(journeyStepLabel).filter(Boolean);
  if (omitted > 0) {
    parts.push(`(${omitted} intermediate step${omitted === 1 ? '' : 's'})`);
    parts.push(...trailing.map(journeyStepLabel).filter(Boolean));
  }
  return parts.join(' -> ');
}

export function journeyEffectPhrases(journey: Pick<CASUserJourney, 'terminal_effects'>): string[] {
  const effects = journey.terminal_effects;
  if (!effects) return [];
  const phrases: string[] = [];
  if (effects.entities_written?.length) phrases.push(`writes ${joinWithMore(effects.entities_written, 4)}`);
  if (effects.entities_read?.length) phrases.push(`reads ${joinWithMore(effects.entities_read, 4)}`);
  if (effects.external_services?.length) phrases.push(`calls ${joinWithMore(effects.external_services, 4)}`);
  if (effects.messages_emitted?.length) phrases.push(`emits ${joinWithMore(effects.messages_emitted, 4)}`);
  return phrases;
}

export function journeyProvenanceLine(journey: CASUserJourney): string {
  const parts = [
    journey.entry_point_id ? `entry_point: ${journey.entry_point_id}` : '',
    journey.entry?.handler_node_id ? `handler: ${journey.entry.handler_node_id}` : '',
    `${(journey.call_chain_ids || []).length} call chain${(journey.call_chain_ids || []).length === 1 ? '' : 's'}`,
    `${(journey.exit_point_ids || []).length} exit point${(journey.exit_point_ids || []).length === 1 ? '' : 's'}`,
  ].filter(Boolean);
  return parts.join(' | ');
}

export function journeyDetailMarkdown(journey: CASUserJourney): string {
  const lines: string[] = [];
  lines.push(`## ${journeyTitle(journey)}`);
  lines.push('');
  lines.push(journeyHeadline(journey));
  lines.push('');
  const entry = journeyEntryLabel(journey);
  lines.push(`- Entry: ${journey.entry?.type || 'unknown'}${entry ? ` ${entry}` : ''}`);
  lines.push(`- Kind: ${journey.journey_kind}, criticality ${journey.criticality}${journey.risk ? `, risk ${journey.risk}` : ''}`);
  const stepPhrase = journeyStepPhrase(journey);
  if (stepPhrase) {
    lines.push(`- Steps (${displayJourneySteps(journey).length}): ${stepPhrase}`);
  }
  const effects = journeyEffectPhrases(journey);
  if (effects.length > 0) {
    lines.push(`- Effects: ${effects.join('; ')}`);
  }
  const boundaries = (journey.security_boundaries || [])
    .map(boundary => {
      if (!boundary.name) return '';
      const qualifiers = [guardBoundaryKind(boundary), boundary.mechanism].filter(Boolean);
      return qualifiers.length > 0 ? `${boundary.name} (${qualifiers.join(', ')})` : boundary.name;
    })
    .filter(Boolean);
  lines.push(`- Boundaries: ${boundaries.length > 0 ? boundaries.join(', ') : 'none recorded'}`);
  lines.push(`- Tests: ${journeyTestPhrase(journey)}`);
  lines.push('');
  lines.push(`_${journeyProvenanceLine(journey)}_`);
  return lines.join('\n');
}

export function journeyListLineMarkdown(journey: CASUserJourney): string {
  return `- ${journeyHeadline(journey)} [${journey.journey_kind}, ${journey.criticality}] (id: ${journey.id})`;
}

export function journeyListMarkdown(
  journeys: CASUserJourney[],
  opts: { total: number; offset: number; byKind?: Record<string, number> } = { total: 0, offset: 0 }
): string {
  const lines: string[] = [];
  lines.push('# User Journeys');
  lines.push('');
  const kinds = opts.byKind
    ? Object.entries(opts.byKind).filter(([, count]) => typeof count === 'number' && count > 0).map(([kind, count]) => `${count} ${kind}`).join(', ')
    : '';
  lines.push(`${opts.total} journey${opts.total === 1 ? '' : 's'}${kinds ? ` (${kinds})` : ''}, showing ${journeys.length}${opts.offset ? ` from offset ${opts.offset}` : ''}.`);
  lines.push('');
  for (const journey of journeys) {
    lines.push(journeyListLineMarkdown(journey));
  }
  if (journeys.length === 0) {
    lines.push('_No journeys matched._');
  }
  return lines.join('\n');
}

// Stored product-map journey summaries and capability links carry only the
// stored journey name. Parse the deterministic name format
// "Title -> Outcome (+N more) (METHOD /path)" for display.
export function storedJourneyNameParts(name: string): { title: string; outcome: string; entry: string } {
  const raw = String(name || '').trim();
  const entryMatch = /\(((?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s[^)]*)\)\s*$/i.exec(raw);
  const entry = entryMatch ? entryMatch[1] : '';
  const withoutEntry = entryMatch ? raw.slice(0, entryMatch.index).trim() : raw;
  const arrowIndex = withoutEntry.indexOf('->');
  if (arrowIndex === -1) return { title: withoutEntry, outcome: '', entry };
  const title = withoutEntry.slice(0, arrowIndex).trim();
  const outcome = withoutEntry.slice(arrowIndex + 2).trim().replace(/\(\+(\d+) more\)/, '+$1 more');
  return { title, outcome, entry };
}

export function storedJourneyNameHeadline(name: string): string {
  const { title, outcome, entry } = storedJourneyNameParts(name);
  const chain = [entry, outcome].filter(Boolean).join(' -> ');
  return chain ? `${title}: ${chain}` : title;
}
