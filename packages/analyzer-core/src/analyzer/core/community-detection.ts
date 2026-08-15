












export interface Community {
  id: number;

  members: string[];

  internal_edges: number;
}

export interface CommunityEdge {
  source: string;
  target: string;
}






export function detectCommunities(nodeIds: string[], edges: CommunityEdge[]): Community[] {
  const nodeSet = new Set(nodeIds);
  const adj = new Map<string, Map<string, number>>();
  const degree = new Map<string, number>();
  let m2 = 0;

  const add = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Map());
    adj.get(a)!.set(b, (adj.get(a)!.get(b) || 0) + 1);
    degree.set(a, (degree.get(a) || 0) + 1);
  };
  for (const e of edges) {
    if (e.source === e.target) continue;
    if (!nodeSet.has(e.source) || !nodeSet.has(e.target)) continue;
    add(e.source, e.target);
    add(e.target, e.source);
    m2 += 2;
  }

  if (m2 === 0) return [];

  const ordered = [...nodeIds].sort();
  const comm = new Map<string, number>();
  ordered.forEach((id, i) => comm.set(id, i));
  const commDegree = new Map<number, number>();
  for (const id of ordered) {
    const c = comm.get(id)!;
    commDegree.set(c, (commDegree.get(c) || 0) + (degree.get(id) || 0));
  }

  let improved = true;
  let iter = 0;
  while (improved && iter++ < 100) {
    improved = false;
    for (const id of ordered) {
      const ki = degree.get(id) || 0;
      if (ki === 0) continue;
      const ci = comm.get(id)!;
      commDegree.set(ci, (commDegree.get(ci) || 0) - ki);


      const neigh = new Map<number, number>();
      for (const [nb, w] of adj.get(id) || []) {
        const c = comm.get(nb)!;
        neigh.set(c, (neigh.get(c) || 0) + w);
      }

      let bestC = ci;
      let bestGain = 0;

      for (const c of [...neigh.keys()].sort((a, b) => a - b)) {
        const wic = neigh.get(c)!;
        const gain = wic - ((commDegree.get(c) || 0) * ki) / m2;
        if (gain > bestGain + 1e-12) {
          bestGain = gain;
          bestC = c;
        }
      }
      comm.set(id, bestC);
      commDegree.set(bestC, (commDegree.get(bestC) || 0) + ki);
      if (bestC !== ci) improved = true;
    }
  }


  const byComm = new Map<number, string[]>();
  for (const id of ordered) {
    const c = comm.get(id)!;
    if (!byComm.has(c)) byComm.set(c, []);
    byComm.get(c)!.push(id);
  }
  const result: Community[] = [];
  for (const [, members] of byComm) {
    if (members.length === 0) continue;
    const mset = new Set(members);
    let internal = 0;
    for (const id of members) {
      for (const [nb, w] of adj.get(id) || []) {
        if (mset.has(nb)) internal += w;
      }
    }
    result.push({ id: 0, members: [...members].sort(), internal_edges: internal / 2 });
  }
  result.sort((a, b) => b.members.length - a.members.length || a.members[0].localeCompare(b.members[0]));
  result.forEach((c, i) => (c.id = i));

  return result.filter(c => c.members.length > 1 || c.internal_edges > 0);
}
