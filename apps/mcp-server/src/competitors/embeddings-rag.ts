





















import * as fs from 'fs-extra';
import * as path from 'path';


const OLLAMA_BASE = 'http://localhost:11434';
const EMBED_MODEL = 'nomic-embed-text';

const CHUNK_LINES = 40;


const SOURCE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt', '.swift',
  '.rb', '.php', '.cs', '.c', '.cc', '.cpp', '.h', '.hpp',
  '.ex', '.exs', '.scala', '.sol', '.vue', '.svelte', '.dart',
]);


const SKIP_DIR = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'target',
  '.next', 'vendor', '__pycache__', '.venv', 'venv',
]);

export interface RagChunk {

  file: string;

  text: string;

  score: number;
}

export interface RagSearchResult {

  available: boolean;

  chunks: RagChunk[];

  ms: number;

  note?: string;
}


async function ollamaUp(): Promise<boolean> {
  try {
    const r = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(800) });
    return r.ok;
  } catch {
    return false;
  }
}


async function modelAvailable(model: string): Promise<boolean> {
  try {
    const r = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return false;
    const j: any = await r.json();
    const names: string[] = (j?.models || []).map((m: any) => String(m?.name || ''));

    return names.some(n => n.split(':')[0] === model || n.startsWith(model));
  } catch {
    return false;
  }
}


async function embed(text: string, model: string): Promise<number[] | null> {
  try {
    const r = await fetch(`${OLLAMA_BASE}/api/embeddings`, {
      method: 'POST',
      body: JSON.stringify({ model, prompt: text }),
      signal: AbortSignal.timeout(20_000),
    });
    const j: any = await r.json();
    return Array.isArray(j?.embedding) ? j.embedding : null;
  } catch {
    return null;
  }
}

function cosine(a: number[], b: number[]): number {
  let d = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    d += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return d / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}


function walkSources(dir: string, root = dir): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIR.has(e.name) || e.name.startsWith('.')) continue;
      out.push(...walkSources(path.join(dir, e.name), root));
    } else if (e.isFile() && SOURCE_EXT.has(path.extname(e.name))) {
      out.push(path.relative(root, path.join(dir, e.name)));
    }
  }
  return out;
}


function chunkFile(text: string, file: string): RagChunk[] {
  const lines = text.split('\n');
  const chunks: RagChunk[] = [];
  for (let i = 0; i < lines.length; i += CHUNK_LINES) {
    const slice = lines.slice(i, i + CHUNK_LINES).join('\n').trim();
    if (slice) chunks.push({ file, text: slice, score: 0 });
  }

  if (chunks.length === 0 && text.trim()) {
    chunks.push({ file, text: text.trim(), score: 0 });
  }
  return chunks;
}






export async function ragSearch(
  repoDir: string,
  query: string,
  k: number,
): Promise<RagSearchResult> {
  const t0 = Date.now();

  if (!(await ollamaUp())) {
    return { available: false, chunks: [], ms: Date.now() - t0, note: 'ollama not reachable at ' + OLLAMA_BASE };
  }
  if (!(await modelAvailable(EMBED_MODEL))) {
    return { available: false, chunks: [], ms: Date.now() - t0, note: `embedding model ${EMBED_MODEL} not pulled` };
  }

  const qv = await embed(query, EMBED_MODEL);
  if (!qv) {
    return { available: false, chunks: [], ms: Date.now() - t0, note: 'query embedding failed' };
  }

  const files = walkSources(repoDir);
  const chunks: RagChunk[] = [];
  for (const file of files) {
    let content = '';
    try {
      content = await fs.readFile(path.join(repoDir, file), 'utf8');
    } catch {
      continue;
    }
    chunks.push(...chunkFile(content, file));
  }

  const scored: RagChunk[] = [];
  for (const c of chunks) {
    const v = await embed(c.text, EMBED_MODEL);
    if (v) scored.push({ ...c, score: cosine(qv, v) });
  }
  scored.sort((a, b) => b.score - a.score);

  return {
    available: true,
    chunks: scored.slice(0, Math.max(0, k)),
    ms: Date.now() - t0,
  };
}
