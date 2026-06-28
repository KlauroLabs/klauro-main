/**
 * ctags retrieval backend — symbol-index proxy.
 *
 * Shells out to the system ctags (`/usr/bin/ctags`, BSD ctags on macOS — NOT
 * universal-ctags, so `--output-format=json` is unavailable). We run plain
 * `ctags -R -f - <dir>`, which emits classic tab-separated tags:
 *   <tagname>\t<file>\t<exaddress>
 * We match query tokens against tag (symbol) names and rank files by how many
 * distinct query-matching symbols they define. Models a symbol-aware index.
 *
 * If the binary is missing or errors, returns an empty result with a note (the
 * arm then degrades to unaided exploration — honest competitor behavior).
 */

import { execFile } from 'child_process';
import * as fs from 'fs-extra';
import * as path from 'path';
import type { RetrievalBackend, RetrievalRequest, RetrievalResult, RetrievalCandidate } from './types';
import { tokenize } from './lexical';

const CTAGS_BIN = '/usr/bin/ctags';
const TIMEOUT_MS = 30_000;
const MAX_BUFFER = 32 * 1024 * 1024; // tag streams can be large

interface CtagsRun {
  stdout: string;
  error?: string;
}

/** Run ctags recursively, emitting tags to stdout. Never rejects. */
function runCtags(repoPath: string): Promise<CtagsRun> {
  return new Promise(resolve => {
    execFile(
      CTAGS_BIN,
      ['-R', '-f', '-', repoPath],
      { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: 'utf8' },
      (err, stdout) => {
        // BSD ctags may exit non-zero on warnings yet still emit useful tags.
        if (err && !stdout) {
          resolve({ stdout: '', error: err.message });
        } else {
          resolve({ stdout: stdout ?? '' });
        }
      },
    );
  });
}

interface FileHit {
  symbols: Set<string>;
  firstHint?: string;
}

export const ctagsBackend: RetrievalBackend = {
  id: 'ctags',
  async retrieve(req: RetrievalRequest): Promise<RetrievalResult> {
    const start = Date.now();
    const k = req.k > 0 ? req.k : 12;
    try {
      // Fail fast & honestly if the binary isn't present.
      if (!(await fs.pathExists(CTAGS_BIN))) {
        return { backend: this.id, candidates: [], index_ms: Date.now() - start, note: `ctags binary missing at ${CTAGS_BIN}` };
      }

      const queryTerms = new Set(tokenize(req.query));
      if (queryTerms.size === 0) {
        return { backend: this.id, candidates: [], index_ms: Date.now() - start, note: 'empty query after tokenization' };
      }

      const { stdout, error } = await runCtags(req.repoPath);
      if (error) {
        return { backend: this.id, candidates: [], index_ms: Date.now() - start, note: `ctags failed: ${error}` };
      }
      if (!stdout.trim()) {
        return { backend: this.id, candidates: [], index_ms: Date.now() - start, note: 'ctags produced no tags' };
      }

      const byFile = new Map<string, FileHit>();
      let tagCount = 0;
      for (const line of stdout.split('\n')) {
        if (!line || line.startsWith('!')) continue; // skip pseudo-tags / blanks
        const tab1 = line.indexOf('\t');
        if (tab1 <= 0) continue;
        const tab2 = line.indexOf('\t', tab1 + 1);
        if (tab2 <= tab1) continue;
        const tagName = line.slice(0, tab1);
        const tagFile = line.slice(tab1 + 1, tab2);
        tagCount++;

        // Does the symbol name match any query term? Compare on the symbol's
        // own tokenized sub-terms so `getUserById` matches `user`/`id`.
        const symTokens = new Set(tokenize(tagName));
        let matched = false;
        for (const st of symTokens) {
          if (queryTerms.has(st)) { matched = true; break; }
        }
        if (!matched) continue;

        const rel = path.isAbsolute(tagFile) ? path.relative(req.repoPath, tagFile) : tagFile;
        // Defend against tags pointing outside the repo.
        if (rel.startsWith('..')) continue;
        let hit = byFile.get(rel);
        if (!hit) { hit = { symbols: new Set() }; byFile.set(rel, hit); }
        hit.symbols.add(tagName);
        if (!hit.firstHint) hit.firstHint = tagName;
      }

      if (byFile.size === 0) {
        return {
          backend: this.id,
          candidates: [],
          index_ms: Date.now() - start,
          note: `no symbols matched query (${tagCount} tags scanned)`,
        };
      }

      const scored: RetrievalCandidate[] = [];
      for (const [rel, hit] of byFile) {
        scored.push({
          file: rel,
          score: hit.symbols.size,
          hint: hit.firstHint ? `sym:${hit.firstHint}` : undefined,
        });
      }
      scored.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));

      return {
        backend: this.id,
        candidates: scored.slice(0, k),
        index_ms: Date.now() - start,
        note: `${tagCount} tags, ${byFile.size} files with matching symbols`,
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
