import type { CASCausalJourney } from '../../types/causal-journey.types';
import {
  CASBehaviorDiff,
  CASBehaviorDiffEntryPointFlow,
  CASBehaviorDiffJourney,
  CASBehaviorDiffEntryPointFlowChange,
  CASBehaviorDiffJourneyChange,
  CASBehaviorDiffUnguardedEntry,
  CASBehaviorDiffCapabilityOverlap,
  CASBehaviorDiffParadigmDeviation,
  CASEntityLineage,
  CASOutput,
  CASEntryPointFlow,
  SystemCapability,
} from '../../types/cas.types';
import { projectEntryPointFlowsFromCas } from './entry-point-flow-projection';

const CAPABILITY_NAME_STOPWORDS = new Set([
  'management', 'manage', 'service', 'services', 'api', 'data', 'system',
  'support', 'core', 'handling', 'processing', 'the', 'and', 'of', 'for',
]);

function entryDescriptor(entryPointFlow: CASEntryPointFlow): string {
  const method = entryPointFlow.entry.method ? `${entryPointFlow.entry.method.toUpperCase()} ` : '';
  const target = entryPointFlow.entry.path_or_trigger || entryPointFlow.entry.name;
  return `${entryPointFlow.entry.type}:${method}${target}`;
}

function entryKey(entryPointFlow: CASEntryPointFlow): string {
  return [
    entryPointFlow.entry.type,
    (entryPointFlow.entry.method || '').toUpperCase(),
    entryPointFlow.entry.path_or_trigger || entryPointFlow.entry.name,
  ].join('|').toLowerCase();
}

function terminalEntityNames(entryPointFlow: CASEntryPointFlow): string[] {
  const names = new Set<string>();
  for (const terminal of entryPointFlow.terminal_entities || []) {
    names.add(terminal.name);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

function entryPointFlowIdentityKey(entryPointFlow: CASEntryPointFlow): string {
  return `${entryKey(entryPointFlow)}=>${terminalEntityNames(entryPointFlow).map(name => name.toLowerCase()).join(',')}`;
}

function entitiesWritten(entryPointFlow: CASEntryPointFlow): string[] {
  const written = new Set<string>();
  for (const terminal of entryPointFlow.terminal_entities || []) {
    if (terminal.access !== 'read' && terminal.terminal_kind === 'entity') {
      written.add(terminal.name);
    }
  }
  for (const name of entryPointFlow.terminal_effects?.entities_written || []) {
    written.add(name);
  }
  return [...written].sort((a, b) => a.localeCompare(b));
}

function boundaryLabels(entryPointFlow: CASEntryPointFlow): string[] {
  return (entryPointFlow.security_boundaries || [])
    .map(boundary => `${boundary.name} (${boundary.mechanism})`)
    .sort((a, b) => a.localeCompare(b));
}

function isGuarded(entryPointFlow: CASEntryPointFlow): boolean {
  return (entryPointFlow.security_boundaries || []).length > 0;
}

function toDiffEntryPointFlow(entryPointFlow: CASEntryPointFlow): CASBehaviorDiffEntryPointFlow {
  return {
    id: entryPointFlow.id,
    name: entryPointFlow.name,
    entry: entryDescriptor(entryPointFlow),
    entities_written: entitiesWritten(entryPointFlow),
    guarded: isGuarded(entryPointFlow),
  };
}

interface EntryPointFlowMatch {
  before: CASEntryPointFlow;
  after: CASEntryPointFlow;
}

function matchEntryPointFlows(beforeEntryPointFlows: CASEntryPointFlow[], afterEntryPointFlows: CASEntryPointFlow[]): {
  matches: EntryPointFlowMatch[];
  added: CASEntryPointFlow[];
  removed: CASEntryPointFlow[];
} {
  const matches: EntryPointFlowMatch[] = [];
  const unmatchedBefore = new Map<string, CASEntryPointFlow[]>();
  for (const entryPointFlow of beforeEntryPointFlows) {
    const key = entryPointFlowIdentityKey(entryPointFlow);
    const bucket = unmatchedBefore.get(key) || [];
    bucket.push(entryPointFlow);
    unmatchedBefore.set(key, bucket);
  }

  const afterLeftover: CASEntryPointFlow[] = [];
  for (const entryPointFlow of afterEntryPointFlows) {
    const key = entryPointFlowIdentityKey(entryPointFlow);
    const bucket = unmatchedBefore.get(key);
    if (bucket && bucket.length > 0) {
      matches.push({ before: bucket.shift() as CASEntryPointFlow, after: entryPointFlow });
      if (bucket.length === 0) unmatchedBefore.delete(key);
    } else {
      afterLeftover.push(entryPointFlow);
    }
  }

  const beforeLeftoverByEntry = new Map<string, CASEntryPointFlow[]>();
  for (const bucket of unmatchedBefore.values()) {
    for (const entryPointFlow of bucket) {
      const key = entryKey(entryPointFlow);
      const entryBucket = beforeLeftoverByEntry.get(key) || [];
      entryBucket.push(entryPointFlow);
      beforeLeftoverByEntry.set(key, entryBucket);
    }
  }

  const added: CASEntryPointFlow[] = [];
  for (const entryPointFlow of afterLeftover) {
    const key = entryKey(entryPointFlow);
    const bucket = beforeLeftoverByEntry.get(key);
    if (bucket && bucket.length > 0) {
      matches.push({ before: bucket.shift() as CASEntryPointFlow, after: entryPointFlow });
      if (bucket.length === 0) beforeLeftoverByEntry.delete(key);
    } else {
      added.push(entryPointFlow);
    }
  }

  const removed: CASEntryPointFlow[] = [];
  for (const bucket of beforeLeftoverByEntry.values()) {
    removed.push(...bucket);
  }

  return { matches, added, removed };
}

function describeEntryPointFlowChange(match: EntryPointFlowMatch): CASBehaviorDiffEntryPointFlowChange | null {
  const what: string[] = [];

  const beforeBoundaries = boundaryLabels(match.before);
  const afterBoundaries = boundaryLabels(match.after);
  const afterBoundarySet = new Set(afterBoundaries);
  const beforeBoundarySet = new Set(beforeBoundaries);

  if (beforeBoundaries.length > 0 && afterBoundaries.length === 0) {
    what.push('lost auth boundary');
  } else {
    for (const boundary of beforeBoundaries) {
      if (!afterBoundarySet.has(boundary)) what.push(`removed security boundary '${boundary}'`);
    }
  }
  for (const boundary of afterBoundaries) {
    if (!beforeBoundarySet.has(boundary)) what.push(`gained security boundary '${boundary}'`);
  }

  const beforeTerminals = new Set(terminalEntityNames(match.before));
  const afterTerminals = new Set(terminalEntityNames(match.after));
  for (const name of afterTerminals) {
    if (!beforeTerminals.has(name)) what.push(`new terminal entity '${name}'`);
  }
  for (const name of beforeTerminals) {
    if (!afterTerminals.has(name)) what.push(`removed terminal entity '${name}'`);
  }

  const beforeTests = (match.before.tests_covering || []).length;
  const afterTests = (match.after.tests_covering || []).length;
  if (afterTests < beforeTests) {
    what.push(afterTests === 0 ? 'tests dropped' : `tests dropped from ${beforeTests} to ${afterTests}`);
  }

  if (what.length === 0) return null;
  return { id: match.after.id, name: match.after.name, what };
}

function guardingIsTheNorm(entryPointFlows: CASEntryPointFlow[], candidate: CASEntryPointFlow): boolean {
  const others = entryPointFlows.filter(entryPointFlow => entryPointFlow.id !== candidate.id);
  if (others.length === 0) return false;
  const guarded = others.filter(isGuarded).length;
  return guarded >= 1 && guarded * 2 >= others.length;
}

function allBoundaryLabels(entryPointFlows: CASEntryPointFlow[]): Set<string> {
  const labels = new Set<string>();
  for (const entryPointFlow of entryPointFlows) {
    for (const label of boundaryLabels(entryPointFlow)) {
      labels.add(label);
    }
  }
  return labels;
}

function capabilityNameTokens(name: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of name.split(/[^a-zA-Z0-9]+/)) {
    const token = raw.toLowerCase();
    if (token.length > 2 && !CAPABILITY_NAME_STOPWORDS.has(token)) {
      tokens.add(token);
    }
  }
  return tokens;
}

function diffCapabilities(beforeCaps: SystemCapability[], afterCaps: SystemCapability[]): CASBehaviorDiff['capabilities'] {
  const beforeByName = new Map(beforeCaps.map(cap => [cap.name.trim().toLowerCase(), cap]));
  const afterByName = new Map(afterCaps.map(cap => [cap.name.trim().toLowerCase(), cap]));

  const added = afterCaps
    .filter(cap => !beforeByName.has(cap.name.trim().toLowerCase()))
    .map(cap => ({ id: cap.id, name: cap.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const removed = beforeCaps
    .filter(cap => !afterByName.has(cap.name.trim().toLowerCase()))
    .map(cap => ({ id: cap.id, name: cap.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const preexisting = afterCaps.filter(cap => beforeByName.has(cap.name.trim().toLowerCase()));
  const possiblyDuplicated: CASBehaviorDiffCapabilityOverlap[] = [];

  for (const addedCap of afterCaps.filter(cap => !beforeByName.has(cap.name.trim().toLowerCase()))) {
    const addedEntities = new Set((addedCap.related_entities || []).map(name => name.toLowerCase()));
    const addedTokens = capabilityNameTokens(addedCap.name);

    for (const existing of preexisting) {
      const sharedEntities = (existing.related_entities || [])
        .filter(name => addedEntities.has(name.toLowerCase()))
        .sort((a, b) => a.localeCompare(b));
      const sharedTokens = [...capabilityNameTokens(existing.name)]
        .filter(token => addedTokens.has(token))
        .sort((a, b) => a.localeCompare(b));

      if (sharedEntities.length > 0 || sharedTokens.length > 0) {
        possiblyDuplicated.push({
          new_capability: addedCap.name,
          overlaps_with: existing.name,
          shared_entities: sharedEntities,
          shared_name_tokens: sharedTokens,
        });
      }
    }
  }

  possiblyDuplicated.sort((a, b) =>
    a.new_capability.localeCompare(b.new_capability) || a.overlaps_with.localeCompare(b.overlaps_with)
  );

  return { added, removed, possibly_duplicated: possiblyDuplicated };
}

function writerKey(writer: CASEntityLineage['writers'][number]): string {
  return `${writer.via}|${writer.file || ''}`.toLowerCase();
}

function diffLineage(beforeLineage: CASEntityLineage[], afterLineage: CASEntityLineage[]): CASBehaviorDiff['lineage'] {
  const beforeByName = new Map(beforeLineage.map(entry => [entry.entity_name.toLowerCase(), entry]));

  const entitiesWithNewWriters: Array<{ entity_name: string; new_writers: string[] }> = [];
  const sensitiveExposureChanges: Array<{ entity_name: string; change: string }> = [];

  const sortedAfter = [...afterLineage].sort((a, b) => a.entity_name.localeCompare(b.entity_name));

  for (const after of sortedAfter) {
    const before = beforeByName.get(after.entity_name.toLowerCase());

    if (before) {
      const knownWriters = new Set(before.writers.map(writerKey));
      const newWriters = after.writers
        .filter(writer => !knownWriters.has(writerKey(writer)))
        .map(writer => writer.file ? `${writer.via} (${writer.file})` : writer.via)
        .sort((a, b) => a.localeCompare(b));
      if (newWriters.length > 0) {
        entitiesWithNewWriters.push({ entity_name: after.entity_name, new_writers: newWriters });
      }
    }

    const sensitive = after.exposure?.sensitive || before?.exposure?.sensitive;
    if (!sensitive) continue;

    const knownRecipients = new Set((before?.external_recipients || []).map(recipient => recipient.service.toLowerCase()));
    const newRecipients = [...new Set(
      (after.external_recipients || [])
        .filter(recipient => !knownRecipients.has(recipient.service.toLowerCase()))
        .map(recipient => recipient.service)
    )].sort((a, b) => a.localeCompare(b));
    for (const service of newRecipients) {
      sensitiveExposureChanges.push({
        entity_name: after.entity_name,
        change: `gained external recipient '${service}'`,
      });
    }

    const beforeUnguarded = before?.exposure?.unguarded_paths ?? 0;
    const afterUnguarded = after.exposure?.unguarded_paths ?? 0;
    if (afterUnguarded > beforeUnguarded) {
      sensitiveExposureChanges.push({
        entity_name: after.entity_name,
        change: `unguarded paths increased from ${beforeUnguarded} to ${afterUnguarded}`,
      });
    }
  }

  return {
    entities_with_new_writers: entitiesWithNewWriters,
    sensitive_exposure_changes: sensitiveExposureChanges,
  };
}

function deviationKey(paradigm: string, deviation: { file: string; kind: string }): string {
  return `${paradigm}|${deviation.file}|${deviation.kind}`;
}

function diffParadigms(
  beforeConformance: CASOutput['paradigm_conformance'],
  afterConformance: CASOutput['paradigm_conformance']
): CASBehaviorDiff['paradigms'] {
  const beforeKeys = new Set<string>();
  for (const paradigm of beforeConformance || []) {
    for (const deviation of paradigm.deviations) {
      beforeKeys.add(deviationKey(paradigm.paradigm, deviation));
    }
  }

  const afterKeys = new Set<string>();
  const newDeviations: CASBehaviorDiffParadigmDeviation[] = [];
  for (const paradigm of afterConformance || []) {
    for (const deviation of paradigm.deviations) {
      const key = deviationKey(paradigm.paradigm, deviation);
      afterKeys.add(key);
      if (!beforeKeys.has(key)) {
        newDeviations.push({
          paradigm: paradigm.paradigm,
          file: deviation.file,
          kind: deviation.kind,
          detail: deviation.detail,
          severity: deviation.severity,
        });
      }
    }
  }

  const resolvedDeviations: Array<{ paradigm: string; file: string; kind: string }> = [];
  for (const paradigm of beforeConformance || []) {
    for (const deviation of paradigm.deviations) {
      if (!afterKeys.has(deviationKey(paradigm.paradigm, deviation))) {
        resolvedDeviations.push({ paradigm: paradigm.paradigm, file: deviation.file, kind: deviation.kind });
      }
    }
  }

  const sortDeviation = (a: { paradigm: string; file: string; kind: string }, b: { paradigm: string; file: string; kind: string }) =>
    a.paradigm.localeCompare(b.paradigm) || a.file.localeCompare(b.file) || a.kind.localeCompare(b.kind);
  newDeviations.sort(sortDeviation);
  resolvedDeviations.sort(sortDeviation);

  return { new_deviations: newDeviations, resolved_deviations: resolvedDeviations };
}

function formatEntityList(entities: string[]): string {
  if (entities.length === 1) return entities[0];
  if (entities.length === 2) return `${entities[0]} and ${entities[1]}`;
  return `${entities.slice(0, -1).join(', ')}, and ${entities[entities.length - 1]}`;
}

function diffJourneys(before: CASOutput, after: CASOutput): CASBehaviorDiff['journeys'] {
  const held = (cas: CASOutput) => new Map((cas.causal_journeys ?? []).map(journey => [journey.id, journey]));
  const was = held(before);
  const now = held(after);
  const brief = (journey: CASCausalJourney): CASBehaviorDiffJourney => ({
    id: journey.id,
    label: journey.label,
    does: journey.does,
    steps: journey.steps.length,
  });
  const byLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label);
  const changed: CASBehaviorDiffJourneyChange[] = [];
  for (const [id, journey] of now) {
    const previous = was.get(id);
    if (!previous) continue;
    const what: string[] = [];
    if (previous.steps.length !== journey.steps.length) what.push(`steps ${previous.steps.length} -> ${journey.steps.length}`);
    const crossed = (value: CASCausalJourney) => value.steps.filter(step => step.via).length;
    if (crossed(previous) !== crossed(journey)) what.push(`boundary crossings ${crossed(previous)} -> ${crossed(journey)}`);
    if (what.length > 0) changed.push({ id, label: journey.label, what });
  }
  return {
    added: [...now].filter(([id]) => !was.has(id)).map(([, journey]) => brief(journey)).sort(byLabel),
    removed: [...was].filter(([id]) => !now.has(id)).map(([, journey]) => brief(journey)).sort(byLabel),
    changed: changed.sort(byLabel),
  };
}

function buildRiskFlags(diff: Omit<CASBehaviorDiff, 'summary'>): string[] {
  const flags: string[] = [];

  for (const entry of diff.security.newly_unguarded_entries) {
    if (entry.reason === 'new-unguarded') {
      if (entry.entities_written.length > 0) {
        flags.push(
          `This change added a entryPointFlow '${entry.name}' that writes ${formatEntityList(entry.entities_written)} without crossing the auth boundary.`
        );
      } else {
        flags.push(
          `This change added an unguarded entryPointFlow '${entry.name}' (${entry.entry}) while comparable entryPointFlows cross an auth boundary.`
        );
      }
    }
  }

  for (const entry of diff.security.newly_unguarded_entries) {
    if (entry.reason === 'lost-guard') {
      const writes = entry.entities_written.length > 0
        ? ` while still writing ${formatEntityList(entry.entities_written)}`
        : '';
      flags.push(`Entry-point flow '${entry.name}' lost its auth boundary${writes}.`);
    }
  }

  for (const change of diff.lineage.sensitive_exposure_changes) {
    flags.push(`Sensitive entity '${change.entity_name}' ${change.change}.`);
  }

  for (const overlap of diff.capabilities.possibly_duplicated) {
    const evidence = overlap.shared_entities.length > 0
      ? `shared entities: ${overlap.shared_entities.join(', ')}`
      : `shared name tokens: ${overlap.shared_name_tokens.join(', ')}`;
    flags.push(`New capability '${overlap.new_capability}' possibly duplicates '${overlap.overlaps_with}' (${evidence}).`);
  }

  for (const entity of diff.lineage.entities_with_new_writers) {
    flags.push(`Entity '${entity.entity_name}' gained new writers: ${entity.new_writers.join(', ')}.`);
  }

  for (const change of diff.entry_point_flows.changed) {
    if (change.what.some(item => item.startsWith('tests dropped'))) {
      flags.push(`Entry-point flow '${change.name}' lost test coverage.`);
    }
  }

  if (diff.paradigms.new_deviations.length > 0) {
    const paradigms = [...new Set(diff.paradigms.new_deviations.map(deviation => deviation.paradigm))]
      .sort((a, b) => a.localeCompare(b));
    flags.push(
      `${diff.paradigms.new_deviations.length} new paradigm deviation${diff.paradigms.new_deviations.length === 1 ? '' : 's'} introduced (${paradigms.join(', ')}).`
    );
  }

  return flags;
}

export function diffBehavior(before: CASOutput, after: CASOutput): CASBehaviorDiff {
  const beforeEntryPointFlows = projectEntryPointFlowsFromCas(before).entryPointFlows;
  const afterEntryPointFlows = projectEntryPointFlowsFromCas(after).entryPointFlows;

  const { matches, added, removed } = matchEntryPointFlows(beforeEntryPointFlows, afterEntryPointFlows);

  const changed: CASBehaviorDiffEntryPointFlowChange[] = [];
  for (const match of matches) {
    const change = describeEntryPointFlowChange(match);
    if (change) changed.push(change);
  }
  changed.sort((a, b) => a.name.localeCompare(b.name));

  const sortEntryPointFlow = (a: CASBehaviorDiffEntryPointFlow, b: CASBehaviorDiffEntryPointFlow) =>
    a.name.localeCompare(b.name) || a.entry.localeCompare(b.entry);
  const addedEntryPointFlows = added.map(toDiffEntryPointFlow).sort(sortEntryPointFlow);
  const removedEntryPointFlows = removed.map(toDiffEntryPointFlow).sort(sortEntryPointFlow);

  const beforeBoundaries = allBoundaryLabels(beforeEntryPointFlows);
  const afterBoundaries = allBoundaryLabels(afterEntryPointFlows);
  const boundariesAdded = [...afterBoundaries].filter(label => !beforeBoundaries.has(label)).sort((a, b) => a.localeCompare(b));
  const boundariesRemoved = [...beforeBoundaries].filter(label => !afterBoundaries.has(label)).sort((a, b) => a.localeCompare(b));

  const newlyUnguarded: CASBehaviorDiffUnguardedEntry[] = [];
  for (const match of matches) {
    if (isGuarded(match.before) && !isGuarded(match.after)) {
      newlyUnguarded.push({
        entry_point_flow_id: match.after.id,
        name: match.after.name,
        entry: entryDescriptor(match.after),
        entities_written: entitiesWritten(match.after),
        reason: 'lost-guard',
      });
    }
  }
  for (const entryPointFlow of added) {
    if (!isGuarded(entryPointFlow) && guardingIsTheNorm(afterEntryPointFlows, entryPointFlow)) {
      newlyUnguarded.push({
        entry_point_flow_id: entryPointFlow.id,
        name: entryPointFlow.name,
        entry: entryDescriptor(entryPointFlow),
        entities_written: entitiesWritten(entryPointFlow),
        reason: 'new-unguarded',
      });
    }
  }
  newlyUnguarded.sort((a, b) => a.name.localeCompare(b.name) || a.entry.localeCompare(b.entry));

  const withoutSummary: Omit<CASBehaviorDiff, 'summary'> = {
    entry_point_flows: { added: addedEntryPointFlows, removed: removedEntryPointFlows, changed },
    journeys: diffJourneys(before, after),
    security: {
      boundaries_added: boundariesAdded,
      boundaries_removed: boundariesRemoved,
      newly_unguarded_entries: newlyUnguarded,
    },
    capabilities: diffCapabilities(before.capabilities || [], after.capabilities || []),
    lineage: diffLineage(before.data_lineage || [], after.data_lineage || []),
    paradigms: diffParadigms(before.paradigm_conformance, after.paradigm_conformance),
  };

  return { ...withoutSummary, summary: { risk_flags: buildRiskFlags(withoutSummary) } };
}
