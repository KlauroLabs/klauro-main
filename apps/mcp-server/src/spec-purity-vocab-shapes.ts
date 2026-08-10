/**
 * Vocabulary-table SHAPE gate (spec-purity gate, part 2).
 *
 * The name-leak check in spec-purity-gate.ts (`runSpecPurityGate`) catches a
 * KNOWN corpus/client name leaking into product source. It cannot catch the
 * other half of the cardinal rule — "deterministic structural facts + AI
 * interpretation, NEVER a hardcoded brand/keyword/domain categorizer" —
 * because a fresh hardcoded vocabulary table never repeats a name the gate
 * has already seen. What IS catchable without knowing the words in advance
 * is the SHAPE: a large literal string array/Set declared at module scope
 * and then consulted by a classification function. A one-off audit already
 * found one (query.ts's `isCriticalDomain`, mixing generic security terms
 * with an unrelated fleet-logistics vocabulary to rank change-risk severity)
 * that a name-only gate would never have flagged, because the words were
 * new, not repeats of a name already on a forbidden list.
 *
 * WHY THIS IS A RATCHET, NOT A HARD SIZE CAP: a real repo-agnostic analyzer
 * legitimately contains many large literal arrays that are NOT the
 * forbidden shape — language keyword lists (`if`/`else`/`for`... is a
 * closed, exhaustive set for a given grammar), file-extension lists,
 * dependency-manifest signature tables (real package/import names checked
 * against `package.json`/`Cargo.toml`/etc — "framework detection from real
 * structural evidence" is explicitly NOT a violation), generic English
 * stopword lists, and closed OUTPUT taxonomies (ENTRY_POINT_TYPES, node
 * roles). A blind "array of N+ strings = violation" rule would be so noisy
 * on this codebase (155+ existing arrays, the overwhelming majority
 * legitimate) that it would train reviewers to ignore it — exactly the
 * "whatever isn't a gate silently rots, but a gate nobody can act on rots
 * the same way" failure. So this check is a RATCHET:
 *
 *   1. BASELINE (spec-purity-vocab-baseline.json) — every large literal
 *      array shape already in the tree as of the day this gate shipped,
 *      recorded by (file, declared name) so moving/renaming a legitimate
 *      list re-surfaces it for a fresh look rather than silently carrying
 *      the pass forward under a new name.
 *   2. INLINE ATTESTATION — a NEW large array is also accepted when a
 *      comment within a few lines above its declaration contains the
 *      literal marker `spec-purity:vocab-ok` — the author's one-line,
 *      reviewable acknowledgment of why this list is a closed/structural
 *      vocabulary and not a domain-categorizer, immediately next to the
 *      code (visible in the same diff a reviewer/agent already reads),
 *      rather than a separate baseline-file edit that is easy to rubber-
 *      stamp without reading the list itself.
 *   3. Anything else — a large array with neither a baseline entry nor an
 *      inline attestation — is a NEW, UNREVIEWED vocabulary-table shape and
 *      fails the gate. This is exactly the class the owner named: "a lane
 *      needs a decision, a literal list is the fastest way to get it, and
 *      it passes tests" — this gate is what makes it NOT pass silently.
 *
 * This is a shape-based ratchet, not a correctness judgment: it does not
 * (cannot, statically) know whether a given array is a legitimate closed
 * vocabulary or a hardcoded categorizer — it only guarantees a human looked
 * at it once (baseline) or the author said why (inline marker). Both the
 * baseline and the marker are reviewable in a diff; neither is a rubber
 * stamp a future lane can silently regenerate to hide a real leak — a
 * baseline addition without a matching source-array addition is itself a
 * visible, questionable diff.
 */

import * as fs from 'fs-extra';
import * as path from 'path';
import { EXCLUDED_EVIDENCE_PATH_RE, EXCLUDED_EVIDENCE_FILE_RE } from './spec-purity-gate';

export interface VocabShapeCandidate {
  file: string;
  line: number;
  name: string;
  count: number;
  sample: string[];
}

export interface VocabShapeResult {
  ok: boolean;
  candidates: VocabShapeCandidate[];
  newViolations: VocabShapeCandidate[];
}

const GATED_SOURCE_ROOTS = ['packages/analyzer-core/src', 'apps/mcp-server/src'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-hosted', '.git', '.cache', 'coverage', 'build']);

/** Minimum string-literal count for a module-scope array/Set to be a
 *  candidate. Chosen from this repo's own real distribution (see the module
 *  doc): every legitimate list surveyed is either well above this floor
 *  (dependency signature tables, keyword lists) or well below it (small
 *  closed enums like DIRECT_TYPE_TO_ROLE's 4 entries) — 12 is the same
 *  threshold used to derive the baseline, so raising or lowering it without
 *  regenerating the baseline will systematically mis-flag every existing
 *  list on one side of the new line. */
export const VOCAB_SHAPE_THRESHOLD = 12;

export const INLINE_ATTESTATION_MARKER = 'spec-purity:vocab-ok';

const DECL_RE = /^(export\s+)?const\s+([A-Za-z0-9_]+)(?:\s*:\s*[^=]+)?\s*=\s*(new Set(?:<[^>]*>)?\(\s*\[|(?:Partial<[^>]*>\s*)?\[)/;
const STRING_LITERAL_RE = /'[^'\\]*(?:\\.[^'\\]*)*'|"[^"\\]*(?:\\.[^"\\]*)*"/g;

/** A regex ALTERNATION group is the other shape a keyword bag takes — see
 *  the isCriticalDomain/isSecuritySensitiveName defect this gate was written
 *  after (query.ts, TASK-#audit-2026-08-09): a `/\b(word1|word2|...)\b/i`
 *  literal is functionally the same hardcoded vocabulary table as a `new
 *  Set([...])`, just spelled as a regex, and an array-only scan would have
 *  missed exactly that violation. Matches an alternation of >=
 *  REGEX_ALTERNATION_THRESHOLD bare-word alternatives (letters/digits/./-/_
 *  only — no nested groups/anchors, which would signal a structural pattern
 *  rather than a word list) anywhere in gated source, module scope or not
 *  (unlike the array/Set check, a keyword-bag regex is just as much a
 *  violation inside a function body — see the fixed defect). */
const REGEX_ALTERNATION_RE = /\/(?:[^/\r\n\\]|\\.)*\(([^()]+)\)(?:[^/\r\n\\]|\\.)*\/[a-z]*/g;
export const REGEX_ALTERNATION_THRESHOLD = 10;

/**
 * Stable content key for an anonymous keyword-bag shape.
 *
 * Order-insensitive (alternatives get reordered during refactors without the bag
 * changing meaning) and whitespace/case-insensitive. Deliberately NOT a crypto
 * hash: this is a baseline key, not a security boundary, and a short readable
 * digest keeps the baseline file reviewable by a human — which matters, because
 * the whole point of the baseline is that someone reads what got grandfathered.
 */
function vocabShapeFingerprint(group: string): string {
  const normalized = group
    .split('|')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join('|');
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < normalized.length; i++) {
    const c = normalized.charCodeAt(i);
    h1 = ((h1 ^ c) * 0x01000193) >>> 0;
    h2 = ((h2 + c) * 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(36)}${h2.toString(36)}`.slice(0, 12);
}

function countBareWordAlternatives(group: string): number {
  const parts = group.split('|');
  if (parts.length < 2) return 0;
  const bareWordPart = /^[\w.\-]+\??$/; // plain word, optionally with a trailing `?`
  const bareCount = parts.filter(p => bareWordPart.test(p.trim())).length;
  // Require the OVERWHELMING majority of alternatives to be bare words (not
  // sub-patterns like `\d+` or `[a-z]+`) — a real keyword bag is a flat word
  // list; a regex with a few structural alternatives mixed in is a parsing
  // pattern, not a vocabulary table.
  return bareCount >= parts.length * 0.8 ? bareCount : 0;
}

async function walkFiles(root: string, includeRelPath: (relPath: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  async function recurse(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs);
      if (entry.isDirectory()) {
        await recurse(abs);
      } else if (/\.[jt]sx?$/.test(entry.name) && includeRelPath(rel)) {
        out.push(abs);
      }
    }
  }
  await recurse(root);
  return out;
}

function isExcludedEvidencePath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/');
  if (EXCLUDED_EVIDENCE_PATH_RE.test(`/${normalized}/`)) return true;
  if (EXCLUDED_EVIDENCE_FILE_RE.test(normalized)) return true;
  return false;
}

function hasInlineAttestation(lines: string[], declLineIndex: number): boolean {
  const start = Math.max(0, declLineIndex - 6);
  for (let i = start; i < declLineIndex; i++) {
    if (lines[i].toLowerCase().includes(INLINE_ATTESTATION_MARKER)) return true;
  }
  return false;
}

/** Scans gated source for module-scope literal-array/Set declarations with
 *  >= VOCAB_SHAPE_THRESHOLD string-literal members. Same excluded-path
 *  policy as the name-leak gate (test/fixture/gauntlet/bench/corpus are
 *  excluded — those paths' whole job is real, named, concrete detail). */
export async function findVocabShapeCandidates(repoRoot: string): Promise<VocabShapeCandidate[]> {
  const candidates: VocabShapeCandidate[] = [];
  for (const root of GATED_SOURCE_ROOTS) {
    const abs = path.join(repoRoot, root);
    if (!(await fs.pathExists(abs))) continue;
    const files = await walkFiles(abs, relPath => !isExcludedEvidencePath(path.join(root, relPath)));
    for (const file of files) {
      let content: string;
      try {
        content = await fs.readFile(file, 'utf8');
      } catch {
        continue;
      }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const m = DECL_RE.exec(lines[i]);
        if (m) {
          const name = m[2];
          if (!hasInlineAttestation(lines, i)) {
            let depth = 0;
            let started = false;
            let windowEnd = i;
            for (let j = i; j < Math.min(lines.length, i + 400); j++) {
              for (const ch of lines[j]) {
                if (ch === '[') { depth++; started = true; }
                if (ch === ']') depth--;
              }
              windowEnd = j;
              if (started && depth <= 0) break;
            }
            const block = lines.slice(i, windowEnd + 1).join('\n');
            const literals = (block.match(STRING_LITERAL_RE) || []).filter(s => s.length > 3);
            if (literals.length >= VOCAB_SHAPE_THRESHOLD) {
              candidates.push({
                file: path.relative(repoRoot, file),
                line: i + 1,
                name,
                count: literals.length,
                sample: literals.slice(0, 6),
              });
            }
          }
        }

        // Regex-alternation keyword-bag shape (module scope or not — see
        // REGEX_ALTERNATION_RE's doc comment).
        if (!hasInlineAttestation(lines, i)) {
          REGEX_ALTERNATION_RE.lastIndex = 0;
          let rm: RegExpExecArray | null;
          while ((rm = REGEX_ALTERNATION_RE.exec(lines[i]))) {
            const altCount = countBareWordAlternatives(rm[1]);
            if (altCount >= REGEX_ALTERNATION_THRESHOLD) {
              const assign = /const\s+([A-Za-z0-9_]+)\s*[:=]/.exec(lines[i]);
              candidates.push({
                file: path.relative(repoRoot, file),
                line: i + 1,
                // Anonymous shapes are keyed by their CONTENT, not their line
                // number. A line-keyed baseline is invalidated by any edit above
                // it, so every future commit touching a large file would fail the
                // gate on shapes it had already grandfathered — which is exactly
                // what happened the first time this ran against orchestrator.ts
                // (31k lines, edited by six lanes in one day). Content keying also
                // means MOVING a bag keeps it grandfathered while CHANGING its
                // contents correctly re-flags it for review.
                name: assign ? assign[1] : `<inline:${vocabShapeFingerprint(rm[1])}>`,
                count: altCount,
                sample: rm[1].split('|').slice(0, 6),
              });
            }
          }
        }
      }
    }
  }
  return candidates;
}

export async function loadVocabShapeBaseline(repoRoot: string): Promise<Set<string>> {
  const baselinePath = path.join(repoRoot, 'apps/mcp-server/src/spec-purity-vocab-baseline.json');
  try {
    const raw = await fs.readJson(baselinePath);
    const entries: Array<{ file: string; name: string }> = raw.entries || [];
    return new Set(entries.map(e => `${e.file}::${e.name}`));
  } catch {
    return new Set();
  }
}

export async function runVocabShapeGate(repoRoot: string): Promise<VocabShapeResult> {
  const candidates = await findVocabShapeCandidates(repoRoot);
  const baseline = await loadVocabShapeBaseline(repoRoot);
  const newViolations = candidates.filter(c => !baseline.has(`${c.file}::${c.name}`));
  return { ok: newViolations.length === 0, candidates, newViolations };
}
