/**
 * Embeddings-RAG competitor retrieval arm — the Cursor/Augment/Roo recipe.
 *
 * This is the LITERAL embeddings-RAG agent retrieval pipeline, run with OUR code
 * against a LOCAL ollama only:
 *
 *   1. Walk the repo's source files.
 *   2. Split each file into ~40-line chunks.
 *   3. Embed every chunk AND the query with nomic-embed-text (via ollama).
 *   4. Rank chunks by cosine similarity to the query.
 *   5. Return the top-k chunks (file + text + score).
 *
 * It is the FAIR semantic competitor to Klauro's structured retrieval: it finds
 * "code that reads like the query", not "the structural facts the query asks
 * for". When ollama or the model is absent we return `available:false` —
 * honestly, never a fabricated result. The win must be measured against this at
 * full strength, exactly as a Cursor user would experience it.
 *
 * The ollama call mirrors gauntlet/primitive-bench.ts and real-camp-arms.ts:
 * POST http://localhost:11434/api/embeddings { model, prompt } -> { embedding }.
 */

import * as fs from 'fs-extra';
import * as path from 'path';

/** Ollama endpoint + model, mirroring how the gauntlet's Camp-A arms call it. */
const OLLAMA_BASE = 'http://localhost:11434';
const EMBED_MODEL = 'nomic-embed-text';
/** ~40-line chunks — the standard code-RAG chunk size (Cursor/Augment recipe). */
const CHUNK_LINES = 40;

/** Source extensions an embeddings-RAG indexer would walk. */
const SOURCE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt', '.swift',
  '.rb', '.php', '.cs', '.c', '.cc', '.cpp', '.h', '.hpp',
  '.ex', '.exs', '.scala', '.sol', '.vue', '.svelte', '.dart',
]);

/** Directories an indexer skips (vendored / generated). */
const SKIP_DIR = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'target',
  '.next', 'vendor', '__pycache__', '.venv', 'venv',
]);

export interface RagChunk {
  /** Repo-relative file path the chunk came from. */
  file: string;
  /** The chunk text (~40 lines). */
  text: string;
  /** Cosine similarity to the query, -1..1. Higher is more relevant. */
  score: number;
}

export interface RagSearchResult {
  /** False when ollama / the embedding model is absent — never a faked result. */
  available: boolean;
  /** Top-k chunks ranked by cosine similarity (empty when unavailable). */
  chunks: RagChunk[];
  /** Wall-clock for the whole walk+embed+rank, ms. */
  ms: number;
  /** Why it was unavailable, when available is false. */
  note?: string;
}

/** Is ollama up and reachable? */
async function ollamaUp(): Promise<boolean> {
  try {
    const r = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(800) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Is the embedding model pulled locally? */
async function modelAvailable(model: string): Promise<boolean> {
  try {
    const r = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return false;
    const j: any = await r.json();
    const names: string[] = (j?.models || []).map((m: any) => String(m?.name || ''));
    // Match on the model base name (tags may be `nomic-embed-text:latest`).
    return names.some(n => n.split(':')[0] === model || n.startsWith(model));
  } catch {
    return false;
  }
}

/** Embed one text via ollama. Returns null on any error (treated as unavailable). */
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

/** Recursively collect source files under dir (repo-relative paths). */
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

/** Split a file's text into ~CHUNK_LINES-line chunks. */
function chunkFile(text: string, file: string): RagChunk[] {
  const lines = text.split('\n');
  const chunks: RagChunk[] = [];
  for (let i = 0; i < lines.length; i += CHUNK_LINES) {
    const slice = lines.slice(i, i + CHUNK_LINES).join('\n').trim();
    if (slice) chunks.push({ file, text: slice, score: 0 });
  }
  // A short file still yields one chunk.
  if (chunks.length === 0 && text.trim()) {
    chunks.push({ file, text: text.trim(), score: 0 });
  }
  return chunks;
}

/**
 * Embeddings-RAG retrieval: walk repo sources, ~40-line chunk them, embed chunks
 * and the query with nomic-embed-text via ollama, rank by cosine, return top-k.
 * Returns `available:false` (honest) if ollama/model is absent. Never faked.
 */
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
