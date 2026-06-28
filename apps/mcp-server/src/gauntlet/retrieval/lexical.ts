/**
 * Lexical retrieval backend — a Cursor-style BM25/TF-IDF index proxy.
 *
 * Walks the repo's source files, tokenizes file contents and the query, and
 * ranks files by BM25 overlap with the query terms. This models what a
 * Cursor-style lexical index gives an agent: fast, keyword-driven file ranking
 * with no semantic understanding. Deterministic, offline, bounded.
 */

import * as fs from 'fs-extra';
import * as path from 'path';
import type { RetrievalBackend, RetrievalRequest, RetrievalResult, RetrievalCandidate } from './types';

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'vendor', 'target', 'coverage',
  '.next', '.nuxt', 'out', '.cache', '.venv', 'venv', '__pycache__',
]);

const MAX_FILES = 4000;
const MAX_FILE_BYTES = 512 * 1024;

/** Source-ish extensions worth indexing. Everything else is skipped as binary/noise. */
const SOURCE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs',
  '.java', '.kt', '.kts', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.php',
  '.swift', '.scala', '.clj', '.ex', '.exs', '.erl', '.sh', '.bash', '.zsh',
  '.sql', '.graphql', '.gql', '.proto', '.vue', '.svelte', '.json', '.yaml',
  '.yml', '.toml', '.md', '.txt', '.html', '.css', '.scss', '.less',
]);

const TOKEN_RE = /[A-Za-z_][A-Za-z0-9_]*/g;

/** Tokenize, lowercase, split camelCase/snake_case so `getUser` matches `user`. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const raw = text.match(TOKEN_RE);
  if (!raw) return out;
  for (const w of raw) {
    const lw = w.toLowerCase();
    out.push(lw);
    // split camelCase and snake_case into sub-terms
    const parts = w
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/_/g, ' ')
      .toLowerCase()
      .split(/\s+/)
      .filter(p => p.length > 1);
    for (const p of parts) if (p !== lw) out.push(p);
  }
  return out.filter(t => t.length > 1);
}

/** Heuristic: a line >2KB with no spaces is almost certainly minified. */
function looksMinified(content: string): boolean {
  const nl = content.indexOf('\n');
  const firstLine = nl === -1 ? content : content.slice(0, nl);
  if (firstLine.length > 2000 && !/\s/.test(firstLine.slice(0, 2000))) return true;
  // very long average line length across a sample
  const sample = content.slice(0, 4000);
  const lines = sample.split('\n');
  if (lines.length > 0 && sample.length / lines.length > 400) return true;
  return false;
}

/** Bounded recursive walk yielding repo-relative source file paths. */
export async function walkSourceFiles(repoPath: string): Promise<string[]> {
  const found: string[] = [];
  async function recurse(dir: string): Promise<void> {
    if (found.length >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (found.length >= MAX_FILES) return;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name) || ent.name.startsWith('.') && ent.name !== '.') continue;
        await recurse(full);
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        if (!SOURCE_EXT.has(ext)) continue;
        if (/\.min\.(js|css)$/i.test(ent.name)) continue;
        found.push(full);
      }
    }
  }
  await recurse(repoPath);
  return found;
}

interface DocStats {
  rel: string;
  tf: Map<string, number>;
  len: number;
}

export const lexicalBackend: RetrievalBackend = {
  id: 'cursor-proxy',
  async retrieve(req: RetrievalRequest): Promise<RetrievalResult> {
    const start = Date.now();
    const k = req.k > 0 ? req.k : 12;
    try {
      const files = await walkSourceFiles(req.repoPath);
      if (files.length === 0) {
        return { backend: this.id, candidates: [], index_ms: Date.now() - start, note: 'no source files found' };
      }
      const queryTerms = [...new Set(tokenize(req.query))];
      if (queryTerms.length === 0) {
        return { backend: this.id, candidates: [], index_ms: Date.now() - start, note: 'empty query after tokenization' };
      }

      const docs: DocStats[] = [];
      const df = new Map<string, number>(); // document frequency per term
      for (const full of files) {
        let content: string;
        try {
          const st = await fs.stat(full);
          if (st.size > MAX_FILE_BYTES) continue;
          content = await fs.readFile(full, 'utf8');
        } catch {
          continue;
        }
        if (content.indexOf("\u0000") !== -1 || looksMinified(content)) continue;
        const tokens = tokenize(content);
        if (tokens.length === 0) continue;
        const tf = new Map<string, number>();
        for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
        // only track df for query terms (all we score on)
        for (const qt of queryTerms) if (tf.has(qt)) df.set(qt, (df.get(qt) || 0) + 1);
        docs.push({ rel: path.relative(req.repoPath, full), tf, len: tokens.length });
      }

      if (docs.length === 0) {
        return { backend: this.id, candidates: [], index_ms: Date.now() - start, note: 'no indexable text content' };
      }

      const N = docs.length;
      const avgdl = docs.reduce((a, d) => a + d.len, 0) / N;
      const k1 = 1.5;
      const b = 0.75;

      const scored: RetrievalCandidate[] = [];
      for (const d of docs) {
        let score = 0;
        let bestTerm: string | undefined;
        let bestContrib = 0;
        for (const qt of queryTerms) {
          const f = d.tf.get(qt);
          if (!f) continue;
          const n = df.get(qt) || 0;
          // BM25 idf (with +1 to stay non-negative)
          const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
          const denom = f + k1 * (1 - b + (b * d.len) / avgdl);
          const contrib = idf * ((f * (k1 + 1)) / denom);
          score += contrib;
          if (contrib > bestContrib) { bestContrib = contrib; bestTerm = qt; }
        }
        if (score > 0) {
          scored.push({ file: d.rel, score, hint: bestTerm ? `term:${bestTerm}` : undefined });
        }
      }

      scored.sort((a, b2) => b2.score - a.score || a.file.localeCompare(b2.file));
      const candidates = scored.slice(0, k);
      return {
        backend: this.id,
        candidates,
        index_ms: Date.now() - start,
        note: `bm25 over ${docs.length} files, ${queryTerms.length} query terms`,
      };
    } catch (err) {
      return {
        backend: this.id,
        candidates: [],
        index_ms: Date.now() - start,
        note: `degraded: ${(err as Error)?.message ?? String(err)}`,
      };
    }
  },
};
