import type { TierStackFlow, TierStackIndex } from './read-tier-stack';
import { buildSeamInventory, type CommunicationSeam, type CommunicationSeamsResult } from '../core/communication-seams';

const HANDED_OVER = new Set(['event', 'message', 'background', 'schedule']);

const LINKED_CONFIDENCE = 0.8;

function partNamed(index: TierStackIndex): Map<string, string> {
  return new Map((index.partition?.sub_projects ?? []).map(part => [part.id, part.name || part.root || part.id]));
}

function spoken(flow: TierStackFlow): string {
  return flow.method ? `${flow.method} ${flow.operation}` : flow.operation;
}

export function seamsOf(index: TierStackIndex): CommunicationSeamsResult | undefined {
  const flows = index.comprehension?.flows ?? [];
  const byEntry = new Map(flows.map(flow => [flow.entry_point, flow]));
  const named = partNamed(index);
  const seams: CommunicationSeam[] = [];
  const seen = new Set<string>();
  for (const flow of flows) {
    if (!flow.project) continue;
    for (const entry of flow.leads_into ?? []) {
      const reached = byEntry.get(entry);
      if (!reached?.project || reached.project === flow.project) continue;
      const source = named.get(flow.project) ?? flow.project;
      const target = named.get(reached.project) ?? reached.project;
      const contract = spoken(reached);
      const key = `${source}\u0001${target}\u0001${contract}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const handedOver = HANDED_OVER.has(reached.kind);
      seams.push({
        id: `seam_linked_${seams.length + 1}`,
        modality: handedOver ? 'async' : 'sync',
        confidence: LINKED_CONFIDENCE,
        kind: handedOver ? 'messaging' : 'exit_point',
        source,
        target,
        evidence: `${spoken(flow)} reaches ${contract}`,
        summary: `${source} ${handedOver ? 'hands' : 'calls'} ${target} through ${contract}`,
        metadata: { contract, from_flow: flow.id, to_flow: reached.id },
      });
    }
  }
  for (const flow of flows) {
    if (!flow.project) continue;
    const source = named.get(flow.project) ?? flow.project;
    for (const service of flow.reaches ?? []) {
      const key = `${source}\u0001${service}`;
      if (seen.has(key)) continue;
      seen.add(key);
      seams.push({
        id: `seam_service_${seams.length + 1}`,
        modality: 'sync',
        confidence: LINKED_CONFIDENCE,
        kind: 'exit_point',
        source,
        target: service,
        evidence: `${spoken(flow)} reaches ${service}`,
        summary: `${source} calls ${service}`,
        metadata: { contract: service, from_flow: flow.id, external: true },
      });
    }
  }
  if (seams.length === 0) return undefined;
  const inventory = buildSeamInventory(seams, 'deployable');
  return { seams, inventory, deployable_inventory: inventory };
}
