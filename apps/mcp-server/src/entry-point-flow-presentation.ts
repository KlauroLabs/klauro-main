import type { CASEntryPointFlow, CASEntryPointFlowStep, CASGuardKind } from '../../../packages/analyzer-core/src/types/cas.types';
import { classifyGuardKind } from '../../../packages/analyzer-core/src/analyzer/core/guard-classification';





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

export function entryPointFlowStepLabel(step: Pick<CASEntryPointFlowStep, 'name'>): string {
  return humanizeIdentifier(step?.name || '');
}

export function entryPointFlowEntryLabel(entryPointFlow: Pick<CASEntryPointFlow, 'entry'>): string {
  const entry = entryPointFlow.entry;
  if (!entry) return '';
  if (entry.method && entry.path_or_trigger) return `${entry.method} ${entry.path_or_trigger}`;
  if (entry.path_or_trigger) return entry.path_or_trigger;
  return entry.name || '';
}

export function entryPointFlowTitle(entryPointFlow: Pick<CASEntryPointFlow, 'name' | 'entry'>): string {
  const stored = String(entryPointFlow.name || '').trim();
  const beforeArrow = stored.split('->')[0].trim();
  const withoutEntrySuffix = beforeArrow.replace(/\s*\((GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s[^)]*\)\s*$/i, '').trim();
  if (withoutEntrySuffix) {
    return withoutEntrySuffix.charAt(0).toUpperCase() + withoutEntrySuffix.slice(1);
  }
  const entry = entryPointFlowEntryLabel(entryPointFlow);
  const fallback = humanizeIdentifier(entry);
  return fallback ? fallback.charAt(0).toUpperCase() + fallback.slice(1) : 'Entry-point flow';
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

export function entryPointFlowOutcomePhrase(
  entryPointFlow: Pick<CASEntryPointFlow, 'terminal_entities' | 'terminal_effects'>
): string {
  const terminals = entryPointFlow.terminal_entities || [];
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
  const written = entryPointFlow.terminal_effects?.entities_written || [];
  if (written.length > 0) return `writes ${joinWithMore(written, 3)}`;
  const readNames = byAccess.get('read') || entryPointFlow.terminal_effects?.entities_read || [];
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

export function entryPointFlowGuardPhrase(entryPointFlow: Pick<CASEntryPointFlow, 'security_boundaries'>): string {
  return guardPhraseForBoundaries(entryPointFlow.security_boundaries || []);
}

export function entryPointFlowTestPhrase(entryPointFlow: Pick<CASEntryPointFlow, 'tests_covering'>): string {
  const count = (entryPointFlow.tests_covering || []).length;
  if (count === 0) return 'no tests';
  return count === 1 ? '1 test' : `${count} tests`;
}

export function entryPointFlowHeadline(entryPointFlow: CASEntryPointFlow): string {
  const title = entryPointFlowTitle(entryPointFlow);
  const entry = entryPointFlowEntryLabel(entryPointFlow);
  const outcome = entryPointFlowOutcomePhrase(entryPointFlow);
  const stepCount = (entryPointFlow.steps || []).length;
  const chain = [entry, outcome].filter(Boolean).join(' -> ');
  const facts = [
    stepCount > 0 ? `${stepCount} step${stepCount === 1 ? '' : 's'}` : '',
    entryPointFlowGuardPhrase(entryPointFlow),
    entryPointFlowTestPhrase(entryPointFlow),
  ].filter(Boolean).join(', ');
  return `${title}: ${chain}${facts ? `; ${facts}` : ''}`;
}

export interface CompressedEntryPointFlowSteps {
  leading: CASEntryPointFlowStep[];
  omitted: number;
  trailing: CASEntryPointFlowStep[];
}




export function displayEntryPointFlowSteps(
  entryPointFlow: Pick<CASEntryPointFlow, 'steps' | 'entry'>
): CASEntryPointFlowStep[] {
  const entryLabel = entryPointFlowEntryLabel(entryPointFlow).toLowerCase();
  const result: CASEntryPointFlowStep[] = [];
  let previousLabel = '';
  for (const step of entryPointFlow.steps || []) {
    const label = entryPointFlowStepLabel(step).toLowerCase();
    if (!label) continue;
    if (label === entryLabel) continue;
    if (label === previousLabel) continue;
    result.push(step);
    previousLabel = label;
  }
  return result.length > 0 ? result : (entryPointFlow.steps || []);
}

export function compressEntryPointFlowSteps(steps: CASEntryPointFlowStep[]): CompressedEntryPointFlowSteps {
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

export function entryPointFlowStepPhrase(entryPointFlow: Pick<CASEntryPointFlow, 'steps' | 'entry'>): string {
  const { leading, omitted, trailing } = compressEntryPointFlowSteps(displayEntryPointFlowSteps(entryPointFlow));
  const parts = leading.map(entryPointFlowStepLabel).filter(Boolean);
  if (omitted > 0) {
    parts.push(`(${omitted} intermediate step${omitted === 1 ? '' : 's'})`);
    parts.push(...trailing.map(entryPointFlowStepLabel).filter(Boolean));
  }
  return parts.join(' -> ');
}

export function entryPointFlowEffectPhrases(entryPointFlow: Pick<CASEntryPointFlow, 'terminal_effects'>): string[] {
  const effects = entryPointFlow.terminal_effects;
  if (!effects) return [];
  const phrases: string[] = [];
  if (effects.entities_written?.length) phrases.push(`writes ${joinWithMore(effects.entities_written, 4)}`);
  if (effects.entities_read?.length) phrases.push(`reads ${joinWithMore(effects.entities_read, 4)}`);
  if (effects.external_services?.length) phrases.push(`calls ${joinWithMore(effects.external_services, 4)}`);
  if (effects.messages_emitted?.length) phrases.push(`emits ${joinWithMore(effects.messages_emitted, 4)}`);
  return phrases;
}

export function entryPointFlowProvenanceLine(entryPointFlow: CASEntryPointFlow): string {
  const parts = [
    entryPointFlow.entry_point_id ? `entry_point: ${entryPointFlow.entry_point_id}` : '',
    entryPointFlow.entry?.handler_node_id ? `handler: ${entryPointFlow.entry.handler_node_id}` : '',
    `${(entryPointFlow.call_chain_ids || []).length} call chain${(entryPointFlow.call_chain_ids || []).length === 1 ? '' : 's'}`,
    `${(entryPointFlow.exit_point_ids || []).length} exit point${(entryPointFlow.exit_point_ids || []).length === 1 ? '' : 's'}`,
  ].filter(Boolean);
  return parts.join(' | ');
}

export function entryPointFlowDetailMarkdown(entryPointFlow: CASEntryPointFlow): string {
  const lines: string[] = [];
  lines.push(`## ${entryPointFlowTitle(entryPointFlow)}`);
  lines.push('');
  lines.push(entryPointFlowHeadline(entryPointFlow));
  lines.push('');
  const entry = entryPointFlowEntryLabel(entryPointFlow);
  lines.push(`- Entry: ${entryPointFlow.entry?.type || 'unknown'}${entry ? ` ${entry}` : ''}`);
  lines.push(`- Kind: ${entryPointFlow.flow_kind}, criticality ${entryPointFlow.criticality}${entryPointFlow.risk ? `, risk ${entryPointFlow.risk}` : ''}`);
  const stepPhrase = entryPointFlowStepPhrase(entryPointFlow);
  if (stepPhrase) {
    lines.push(`- Steps (${displayEntryPointFlowSteps(entryPointFlow).length}): ${stepPhrase}`);
  }
  const effects = entryPointFlowEffectPhrases(entryPointFlow);
  if (effects.length > 0) {
    lines.push(`- Effects: ${effects.join('; ')}`);
  }
  const boundaries = (entryPointFlow.security_boundaries || [])
    .map(boundary => {
      if (!boundary.name) return '';
      const qualifiers = [guardBoundaryKind(boundary), boundary.mechanism].filter(Boolean);
      return qualifiers.length > 0 ? `${boundary.name} (${qualifiers.join(', ')})` : boundary.name;
    })
    .filter(Boolean);
  lines.push(`- Boundaries: ${boundaries.length > 0 ? boundaries.join(', ') : 'none recorded'}`);
  lines.push(`- Tests: ${entryPointFlowTestPhrase(entryPointFlow)}`);
  lines.push('');
  lines.push(`_${entryPointFlowProvenanceLine(entryPointFlow)}_`);
  return lines.join('\n');
}

export function entryPointFlowListLineMarkdown(entryPointFlow: CASEntryPointFlow): string {
  return `- ${entryPointFlowHeadline(entryPointFlow)} [${entryPointFlow.flow_kind}, ${entryPointFlow.criticality}] (id: ${entryPointFlow.id})`;
}

export function entryPointFlowListMarkdown(
  entryPointFlows: CASEntryPointFlow[],
  opts: { total: number; offset: number; byKind?: Record<string, number> } = { total: 0, offset: 0 }
): string {
  const lines: string[] = [];
  lines.push('# Entry-point flows');
  lines.push('');
  const kinds = opts.byKind
    ? Object.entries(opts.byKind).filter(([, count]) => typeof count === 'number' && count > 0).map(([kind, count]) => `${count} ${kind}`).join(', ')
    : '';
  lines.push(`${opts.total} entry-point flow${opts.total === 1 ? '' : 's'}${kinds ? ` (${kinds})` : ''}, showing ${entryPointFlows.length}${opts.offset ? ` from offset ${opts.offset}` : ''}.`);
  lines.push('');
  for (const entryPointFlow of entryPointFlows) {
    lines.push(entryPointFlowListLineMarkdown(entryPointFlow));
  }
  if (entryPointFlows.length === 0) {
    lines.push('_No entry-point flows matched._');
  }
  return lines.join('\n');
}




export function storedEntryPointFlowNameParts(name: string): { title: string; outcome: string; entry: string } {
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

export function storedEntryPointFlowNameHeadline(name: string): string {
  const { title, outcome, entry } = storedEntryPointFlowNameParts(name);
  const chain = [entry, outcome].filter(Boolean).join(' -> ');
  return chain ? `${title}: ${chain}` : title;
}
