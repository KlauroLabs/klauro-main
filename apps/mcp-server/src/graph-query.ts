











import type { CASOutput, CASNode } from '../../../packages/analyzer-core/src/types/cas.types';

interface ParsedQuery {
  aVar: string;
  relType?: string;
  bVar?: string;
  where?: { var: string; field: string; value: string };
  returnVars: string[];
}

function nodeField(n: CASNode, field: string): string | undefined {
  switch (field) {
    case 'name': return n.name;
    case 'type': return String(n.type);
    case 'id': return n.id;
    case 'file': return n.source?.file;
    case 'qualified_name': return n.qualified_name;
    default: return (n as any)[field] ?? (n.metadata as any)?.[field];
  }
}

export function parseQuery(q: string): ParsedQuery | null {
  const rel = q.match(/\(\s*(\w+)[^)]*\)\s*-\s*\[\s*:?\s*(\w+)?\s*\]\s*->\s*\(\s*(\w+)[^)]*\)/i);
  let aVar: string, relType: string | undefined, bVar: string | undefined;
  if (rel) {
    aVar = rel[1]; relType = rel[2]; bVar = rel[3];
  } else {
    const single = q.match(/MATCH\s*\(\s*(\w+)[^)]*\)/i);
    if (!single) return null;
    aVar = single[1];
  }
  const w = q.match(/WHERE\s+(\w+)\.(\w+)\s*=\s*['"]([^'"]+)['"]/i);
  const where = w ? { var: w[1], field: w[2], value: w[3] } : undefined;
  const ret = q.match(/RETURN\s+(.+?)\s*$/i);
  if (!ret) return null;
  const returnVars = ret[1].split(',').map(s => s.trim().split('.')[0]);
  return { aVar, relType, bVar, where, returnVars };
}

function project(nodes: CASNode[], limit: number) {
  return nodes.slice(0, limit).map(n => ({ id: n.id, name: n.name, type: n.type, file: n.source?.file }));
}

export function queryGraph(cas: CASOutput, q: string, opts: { limit?: number } = {}) {
  const limit = opts.limit ?? 200;
  const parsed = parseQuery(q);
  if (!parsed) return { error: 'Unsupported query. Use: MATCH (a)[-[:TYPE]->(b)] [WHERE a.field = \'v\'] RETURN a|b', results: {} as Record<string, unknown> };

  const nodes = cas.nodes || [];
  const byId = new Map(nodes.map(n => [n.id, n]));
  const matchesWhere = (n: CASNode, v: string) =>
    !parsed.where || parsed.where.var !== v || nodeField(n, parsed.where.field) === parsed.where.value;

  const out: Record<string, ReturnType<typeof project>> = {};

  if (!parsed.relType && !parsed.bVar) {
    const aNodes = nodes.filter(n => matchesWhere(n, parsed.aVar));
    if (parsed.returnVars.includes(parsed.aVar)) out[parsed.aVar] = project(aNodes, limit);
    return { total: aNodes.length, results: out };
  }


  const aSet: CASNode[] = [];
  const bSet: CASNode[] = [];
  const relLc = parsed.relType?.toLowerCase();
  for (const e of cas.edges || []) {
    if (relLc && String(e.type).toLowerCase() !== relLc) continue;
    const a = byId.get(e.source);
    const b = byId.get(e.target);
    if (!a || !b) continue;
    if (!matchesWhere(a, parsed.aVar)) continue;
    if (parsed.bVar && !matchesWhere(b, parsed.bVar)) continue;
    aSet.push(a);
    bSet.push(b);
  }
  if (parsed.returnVars.includes(parsed.aVar)) out[parsed.aVar] = project([...new Map(aSet.map(n => [n.id, n])).values()], limit);
  if (parsed.bVar && parsed.returnVars.includes(parsed.bVar)) out[parsed.bVar] = project([...new Map(bSet.map(n => [n.id, n])).values()], limit);
  return { total: aSet.length, results: out };
}
