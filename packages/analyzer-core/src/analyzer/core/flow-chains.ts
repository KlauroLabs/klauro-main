import type { CASEntryPoint, CASOutput, FlowConcept } from '../../types/cas.types';
import type { JourneyBounds, JourneyFlow, JourneyProjection, JourneyStep, JourneyView } from '../../types/journey-view.types';
import { USER_FACING_ENTRY_TYPES } from './entry-point-flow-builder';

const MOST_FLOWS_PER_JOURNEY = 8;
const MOST_BRANCHES_PER_FLOW = 48;
const MOST_JOURNEYS_ENUMERATED = 5000;

interface Link {
  to: string;
  via: string;
  channel?: string;
  programs: [string, string];
}

interface Chain {
  flows: FlowConcept[];
  links: Link[];
}

interface Held {
  flows: Map<string, FlowConcept>;
  entries: Map<string, CASEntryPoint>;
  onward: Map<string, Link[]>;
  files: Map<string, string>;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function linksOf(cas: CASOutput): Map<string, Link[]> {
  const onward = new Map<string, Link[]>();
  const seen = new Set<string>();
  for (const seam of cas.communication_seams?.seams ?? []) {
    const from = text(seam.metadata?.from_flow);
    const to = text(seam.metadata?.to_flow);
    const via = text(seam.metadata?.via);
    if (from === undefined || to === undefined || via === undefined || seen.has(`${from}\u0001${to}`)) continue;
    seen.add(`${from}\u0001${to}`);
    const held = onward.get(from) ?? [];
    held.push({
      to,
      via,
      channel: text(seam.metadata?.channel),
      programs: [seam.source, seam.target],
    });
    onward.set(from, held);
  }
  for (const held of onward.values()) held.sort((left, right) => left.to.localeCompare(right.to));
  return onward;
}

function held(cas: CASOutput): Held {
  return {
    flows: new Map((cas.flows ?? []).map(flow => [flow.flow_id, flow])),
    entries: new Map((cas.entry_points ?? []).map(entry => [entry.id, entry])),
    onward: linksOf(cas),
    files: new Map((cas.nodes ?? []).map(node => [node.id, node.source?.file ?? ''])),
  };
}

function isUserFacing(flow: FlowConcept, at: Held): boolean {
  const entry = at.entries.get(flow.entry_point);
  return entry !== undefined && entry.interaction_reach !== 'internal' && USER_FACING_ENTRY_TYPES.has(entry.type);
}

function effectOf(flow: FlowConcept): string | undefined {
  return flow.terminus === undefined ? undefined : `${flow.terminus.kind}:${flow.terminus.produces}`;
}

function chainsFrom(start: FlowConcept, at: Held, bounds: JourneyBounds, enumerated: number): Chain[] {
  const found: Chain[] = [];
  const walk = (chain: Chain) => {
    const last = chain.flows[chain.flows.length - 1];
    const onward = (at.onward.get(last.flow_id) ?? []).filter(
      link => at.flows.has(link.to) && !chain.flows.some(held => held.flow_id === link.to),
    );
    const open = chain.flows.length < MOST_FLOWS_PER_JOURNEY && enumerated + found.length < MOST_JOURNEYS_ENUMERATED;
    const followed = open ? onward.slice(0, MOST_BRANCHES_PER_FLOW) : [];
    bounds.links_not_followed += onward.length - followed.length;
    if (followed.length === 0) {
      found.push(chain);
      return;
    }
    for (const link of followed) {
      const next = at.flows.get(link.to);
      if (next !== undefined) walk({ flows: [...chain.flows, next], links: [...chain.links, link] });
    }
  };
  walk({ flows: [start], links: [] });
  return found;
}

function stepsOf(chain: Chain, at: Held): JourneyStep[] {
  return chain.flows.flatMap((flow, position) =>
    flow.steps.map((step, order) => {
      const unit = step.functions[0]?.function_id;
      const via = order === 0 ? chain.links[position - 1]?.via : undefined;
      return {
        flow_id: flow.flow_id,
        name: step.name,
        ...(unit === undefined ? {} : { unit, file: at.files.get(unit) || undefined }),
        ...(via === undefined ? {} : { via }),
      };
    }),
  );
}

function flowsOf(chain: Chain): JourneyFlow[] {
  return chain.flows.map((flow, position) => {
    const link = chain.links[position - 1];
    return {
      flow_id: flow.flow_id,
      name: flow.name,
      entry_point: flow.entry_point,
      ...(link === undefined ? {} : { via: link.via, ...(link.channel === undefined ? {} : { channel: link.channel }) }),
      steps: flow.steps.length,
      ...(effectOf(flow) === undefined ? {} : { effect: effectOf(flow) }),
      capabilities: (flow.capability_relationships ?? []).map(held => held.capability_id),
    };
  });
}

function programsOf(chain: Chain): number {
  return new Set(chain.links.flatMap(link => link.programs)).size || 1;
}

function labelOf(chain: Chain): string {
  const first = chain.flows[0];
  const last = chain.flows[chain.flows.length - 1];
  return last === first ? first.name : `${first.name} → ${last.name}`;
}

function viewOf(chain: Chain, at: Held): JourneyView {
  const last = chain.flows[chain.flows.length - 1];
  const effect = effectOf(last);
  const entry = at.entries.get(chain.flows[0].entry_point);
  return {
    id: `journey:${chain.flows.map(flow => flow.flow_id).join('>')}`,
    label: labelOf(chain),
    does: `${chain.flows.map(flow => flow.name).join(' → ')}${effect === undefined ? '' : `, ending in ${effect}`}`,
    rank: 0,
    programs: programsOf(chain),
    flows: flowsOf(chain),
    steps: stepsOf(chain, at),
    ...(effect === undefined ? {} : { effect }),
    ...(entry?.metadata?.unshipped === undefined ? {} : { unshipped: true }),
  };
}

function strength(view: JourneyView): number[] {
  const linked = view.flows.filter(flow => flow.capabilities.length > 0).length;
  return [
    view.unshipped ? 0 : 1,
    view.programs,
    linked,
    view.effect === undefined ? 0 : 1,
    view.flows.length,
  ];
}

function stronger(left: JourneyView, right: JourneyView): number {
  const [one, other] = [strength(left), strength(right)];
  for (let at = 0; at < one.length; at += 1) {
    if (one[at] !== other[at]) return other[at] - one[at];
  }
  return left.id.localeCompare(right.id);
}

function withoutTails(chains: Chain[]): Chain[] {
  const tails = new Set<string>();
  for (const chain of chains) {
    const ids = chain.flows.map(flow => flow.flow_id);
    for (let from = 1; from < ids.length; from += 1) tails.add(ids.slice(from).join('>'));
  }
  return chains.filter(chain => !tails.has(chain.flows.map(flow => flow.flow_id).join('>')));
}

export function projectJourneys(cas: CASOutput): JourneyProjection {
  const at = held(cas);
  const bounds: JourneyBounds = {
    max_flows_per_journey: MOST_FLOWS_PER_JOURNEY,
    max_branches_per_flow: MOST_BRANCHES_PER_FLOW,
    max_journeys_enumerated: MOST_JOURNEYS_ENUMERATED,
    links_not_followed: 0,
  };
  const chains: Chain[] = [];
  for (const flow of [...at.flows.values()].filter(held => isUserFacing(held, at))) {
    for (const chain of chainsFrom(flow, at, bounds, chains.length)) {
      if (chain.flows.length > 1 || effectOf(flow) !== undefined) chains.push(chain);
    }
  }
  const views = withoutTails(chains).map(chain => viewOf(chain, at));
  views.sort(stronger);
  views.forEach((view, position) => {
    view.rank = position + 1;
  });
  return { total: views.length, journeys: views, bounds };
}
