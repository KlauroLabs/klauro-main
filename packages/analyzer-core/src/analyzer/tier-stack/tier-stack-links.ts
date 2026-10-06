import type { FlowEffect } from '../../types/cas.types';
import type { CommunicationSeam } from '../core/communication-seams';
import type { TierStackCrossing, TierStackExitPoint, TierStackFlow, TierStackIndex } from './read-tier-stack';

const MOST_FLOWS_PER_ENDPOINT = 3;
const LINKED_CONFIDENCE = 0.8;

export function ownerOf(unit: string): string {
  const at = unit.indexOf(':callback:');
  return at < 0 ? unit : unit.slice(0, at);
}

function stepUnits(flow: TierStackFlow): Set<string> {
  return new Set((flow.steps ?? []).flatMap(step => step.regions.map(region => region.unit)));
}

function unitsOf(flow: TierStackFlow): Map<string, number> {
  const held = new Map<string, number>([...stepUnits(flow)].map(unit => [ownerOf(unit), 0]));
  for (const step of flow.path ?? []) {
    const owner = ownerOf(step.unit);
    if (!held.has(owner)) held.set(owner, step.depth + 1);
  }
  return held;
}

function flowsByStepUnit(flows: TierStackFlow[]): Map<string, TierStackFlow[]> {
  const held = new Map<string, TierStackFlow[]>();
  for (const flow of flows) {
    for (const unit of stepUnits(flow)) {
      const there = held.get(unit) ?? [];
      there.push(flow);
      held.set(unit, there);
    }
  }
  return held;
}

export function effectsByFlow(index: TierStackIndex): Map<string, FlowEffect[]> {
  const exits = new Map<string, TierStackExitPoint[]>();
  for (const exit of index.exit_points ?? []) {
    const held = exits.get(ownerOf(exit.source)) ?? [];
    held.push(exit);
    exits.set(ownerOf(exit.source), held);
  }
  const found = new Map<string, FlowEffect[]>();
  for (const flow of index.comprehension?.flows ?? []) {
    const effects: FlowEffect[] = [];
    const seen = new Set<string>();
    const ordered = [...unitsOf(flow)].sort((left, right) => left[1] - right[1]);
    for (const [unit] of ordered) {
      for (const exit of exits.get(unit) ?? []) {
        if (seen.has(exit.id)) continue;
        seen.add(exit.id);
        effects.push({ exit_point_id: exit.id, kind: exit.kind, produces: exit.target, node_id: exit.source });
      }
    }
    if (effects.length > 0) found.set(flow.id, effects);
  }
  return found;
}

function flowsByEntryHandler(flows: TierStackFlow[], index: TierStackIndex): Map<string, TierStackFlow[]> {
  const byEntry = new Map(flows.map(flow => [flow.entry_point, flow]));
  const held = new Map<string, TierStackFlow[]>();
  for (const entry of index.entry_points ?? []) {
    const flow = byEntry.get(entry.id);
    if (flow === undefined) continue;
    const there = held.get(entry.handler) ?? [];
    there.push(flow);
    held.set(entry.handler, there);
  }
  return held;
}

export function crossingSeamsOf(
  index: TierStackIndex,
  programsOf: (from: TierStackFlow, to: TierStackFlow) => [string, string],
  firstId: number,
): CommunicationSeam[] {
  const flows = index.comprehension?.flows ?? [];
  const leaving = flowsByStepUnit(flows);
  const receiving = flowsByEntryHandler(flows, index);
  const seams: CommunicationSeam[] = [];
  const seen = new Set<string>();
  const link = (crossing: TierStackCrossing, from: TierStackFlow, to: TierStackFlow) => {
    const key = `${from.id}\u0001${to.id}\u0001${crossing.kind}\u0001${crossing.channel}`;
    if (from.id === to.id || seen.has(key)) return;
    seen.add(key);
    const [source, target] = programsOf(from, to);
    seams.push({
      id: `seam_crossing_${firstId + seams.length}`,
      modality: crossing.communication === 'sync' ? 'sync' : 'async',
      confidence: LINKED_CONFIDENCE,
      kind: crossing.communication === 'sync' ? 'exit_point' : 'messaging',
      source,
      target,
      evidence: `${crossing.channel} sent from ${crossing.from} is received by ${crossing.to}`,
      summary: `${source} reaches ${target} over ${crossing.kind} ${crossing.channel}`,
      metadata: {
        contract: crossing.channel,
        via: crossing.kind,
        channel: crossing.channel,
        from_flow: from.id,
        to_flow: to.id,
        exit_unit: crossing.from,
        entry: to.entry_point,
      },
    });
  };
  for (const crossing of index.crossings ?? []) {
    const received = receiving.get(crossing.to) ?? [];
    for (const from of (leaving.get(crossing.from) ?? leaving.get(ownerOf(crossing.from)) ?? []).slice(0, MOST_FLOWS_PER_ENDPOINT)) {
      for (const to of received) link(crossing, from, to);
    }
  }
  return seams;
}
