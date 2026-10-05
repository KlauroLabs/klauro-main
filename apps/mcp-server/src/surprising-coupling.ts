import type { Community } from '../../../packages/analyzer-core/src/analyzer/core/community-detection';

export interface SurprisingLink {
  from: string;
  to: string;
  from_community: number;
  to_community: number;
  callers_of_target: number;
  links_between_the_communities: number;
  why: string;
}

const HUB_SHARE = 0.01;
const MINIMUM_HUB_CALLERS = 8;
const RARE_LINKS = 2;
const REPORTED = 10;

export function surprisingCoupling(
  communities: Community[],
  edges: Array<{ source: string; target: string }>,
  nameOf: (id: string) => string,
): SurprisingLink[] {
  const size = new Map<number, number>();
  const where = new Map<string, number>();
  for (const community of communities) {
    size.set(community.id, community.members.length);
    for (const member of community.members) where.set(member, community.id);
  }
  const callers = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.source === edge.target) continue;
    const held = callers.get(edge.target);
    if (held) held.add(edge.source);
    else callers.set(edge.target, new Set([edge.source]));
  }
  const counts = [...callers.values()].map(held => held.size).sort((left, right) => right - left);
  const threshold = Math.max(MINIMUM_HUB_CALLERS, counts[Math.max(0, Math.floor(counts.length * HUB_SHARE) - 1)] ?? 0);
  const between = new Map<string, number>();
  for (const edge of edges) {
    const from = where.get(edge.source);
    const to = where.get(edge.target);
    if (from === undefined || to === undefined || from === to) continue;
    const key = `${from}>${to}`;
    between.set(key, (between.get(key) ?? 0) + 1);
  }
  const found: SurprisingLink[] = [];
  const seen = new Set<string>();
  for (const edge of edges) {
    const from = where.get(edge.source);
    const to = where.get(edge.target);
    if (from === undefined || to === undefined || from === to) continue;
    const fans = callers.get(edge.target)?.size ?? 0;
    const links = between.get(`${from}>${to}`) ?? 0;
    if (fans < threshold || links > RARE_LINKS || (size.get(from) ?? 0) >= (size.get(to) ?? 0)) continue;
    const key = `${edge.source}>${edge.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({
      from: nameOf(edge.source),
      to: nameOf(edge.target),
      from_community: from,
      to_community: to,
      callers_of_target: fans,
      links_between_the_communities: links,
      why: `a member of a ${size.get(from)}-member community reaches a unit called from ${fans} places in a ${size.get(to)}-member community, and only ${links} link${links === 1 ? ' joins' : 's join'} the two communities`,
    });
  }
  return found.sort((left, right) => right.callers_of_target - left.callers_of_target).slice(0, REPORTED);
}
