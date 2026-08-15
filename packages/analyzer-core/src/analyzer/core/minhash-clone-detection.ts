












export interface CloneItem {
  id: string;

  text: string;
}

export interface ClonePair {
  a: string;
  b: string;

  similarity: number;
}


function fnv1a(str: string, seed: number): number {
  let h = (2166136261 ^ seed) >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}



const KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'fn', 'def', 'func', 'return', 'if', 'else', 'elif', 'for',
  'while', 'do', 'switch', 'case', 'class', 'interface', 'struct', 'enum', 'import', 'from',
  'export', 'public', 'private', 'protected', 'static', 'async', 'await', 'new', 'this', 'self',
  'super', 'try', 'catch', 'finally', 'throw', 'throws', 'void', 'true', 'false', 'null', 'nil',
  'none', 'and', 'or', 'not', 'in', 'is', 'as', 'with', 'yield', 'lambda', 'match', 'when',
  'where', 'type', 'impl', 'trait', 'module', 'end', 'then', 'begin', 'using', 'namespace',
  'package', 'extends', 'implements', 'override', 'virtual', 'abstract', 'final', 'val', 'mut',
  'pub', 'use', 'mod', 'defer', 'go', 'select', 'map', 'range', 'break', 'continue', 'default',
]);








function tokenize(text: string): string[] {
  const raw = text.toLowerCase().match(/[a-z_$][\w$]*|\d+(?:\.\d+)?|[{}()[\];,.+\-*/%=<>!&|^~?:]/g) || [];
  return raw.map(t => {
    if (/^[a-z_$]/.test(t)) return KEYWORDS.has(t) ? t : '$id';
    if (/^\d/.test(t)) return '$n';
    return t;
  });
}


export function shingles(text: string, k = 3): Set<string> {
  const toks = tokenize(text);
  const out = new Set<string>();
  if (toks.length < k) {
    if (toks.length) out.add(toks.join(' '));
    return out;
  }
  for (let i = 0; i + k <= toks.length; i++) out.add(toks.slice(i, i + k).join(' '));
  return out;
}


export function minhashSignature(sh: Set<string>, numHashes = 64): number[] {
  const sig = new Array(numHashes).fill(0xffffffff);
  for (const s of sh) {
    for (let j = 0; j < numHashes; j++) {
      const h = fnv1a(s, j);
      if (h < sig[j]) sig[j] = h;
    }
  }
  return sig;
}


export function estimatedJaccard(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let eq = 0;
  for (let i = 0; i < n; i++) if (a[i] === b[i]) eq++;
  return eq / n;
}

export interface CloneOptions {
  numHashes?: number;
  shingleSize?: number;

  threshold?: number;
}





export function findNearClones(items: CloneItem[], options: CloneOptions = {}): ClonePair[] {
  const numHashes = options.numHashes ?? 64;
  const k = options.shingleSize ?? 3;
  const threshold = options.threshold ?? 0.8;

  const sigs = items
    .map(it => ({ id: it.id, sh: shingles(it.text, k) }))
    .filter(x => x.sh.size > 0)
    .map(x => ({ id: x.id, sig: minhashSignature(x.sh, numHashes) }));

  const pairs: ClonePair[] = [];
  for (let i = 0; i < sigs.length; i++) {
    for (let j = i + 1; j < sigs.length; j++) {
      const sim = estimatedJaccard(sigs[i].sig, sigs[j].sig);
      if (sim >= threshold) {
        const [a, b] = sigs[i].id < sigs[j].id ? [sigs[i].id, sigs[j].id] : [sigs[j].id, sigs[i].id];
        pairs.push({ a, b, similarity: sim });
      }
    }
  }
  pairs.sort((p, q) => q.similarity - p.similarity || p.a.localeCompare(q.a) || p.b.localeCompare(q.b));
  return pairs;
}
