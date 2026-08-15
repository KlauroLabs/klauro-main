


























































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
  staleBaselineEntries: string[];
}

const GATED_SOURCE_ROOTS = ['packages/analyzer-core/src', 'apps/mcp-server/src'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-hosted', '.git', '.cache', 'coverage', 'build']);









export const VOCAB_SHAPE_THRESHOLD = 12;

const DECL_RE = /^(export\s+)?const\s+([A-Za-z0-9_]+)(?:\s*:\s*[^=]+)?\s*=\s*(new Set(?:<[^>]*>)?\(\s*\[|(?:Partial<[^>]*>\s*)?\[)/;
const STRING_LITERAL_RE = /'[^'\\]*(?:\\.[^'\\]*)*'|"[^"\\]*(?:\\.[^"\\]*)*"/g;












const REGEX_ALTERNATION_RE = /\/(?:[^/\r\n\\]|\\.)*\(([^()]+)\)(?:[^/\r\n\\]|\\.)*\/[a-z]*/g;
export const REGEX_ALTERNATION_THRESHOLD = 10;










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
  const bareWordPart = /^[\w.\-]+\??$/;
  const bareCount = parts.filter(p => bareWordPart.test(p.trim())).length;




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



        REGEX_ALTERNATION_RE.lastIndex = 0;
        let rm: RegExpExecArray | null;
        while ((rm = REGEX_ALTERNATION_RE.exec(lines[i]))) {
          const altCount = countBareWordAlternatives(rm[1]);
          if (altCount >= REGEX_ALTERNATION_THRESHOLD) {
            const assign = /const\s+([A-Za-z0-9_]+)\s*[:=]/.exec(lines[i]);
            candidates.push({
              file: path.relative(repoRoot, file),
              line: i + 1,








              name: assign ? assign[1] : `<inline:${vocabShapeFingerprint(rm[1])}>`,
              count: altCount,
              sample: rm[1].split('|').slice(0, 6),
            });
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
  const allowlistPath = path.join(repoRoot, 'apps/mcp-server/src/spec-purity-vocab-allowlist.json');
  const allowlist = new Set<string>();
  try {
    const raw = await fs.readJson(allowlistPath);
    for (const entry of raw.entries || []) allowlist.add(`${entry.file}::${entry.name}`);
  } catch {
  }
  const candidateKeys = new Set(candidates.map(candidate => `${candidate.file}::${candidate.name}`));
  const newViolations = candidates.filter(candidate => {
    const key = `${candidate.file}::${candidate.name}`;
    return !baseline.has(key) && !allowlist.has(key);
  });
  const staleBaselineEntries = [...baseline].filter(key => !candidateKeys.has(key));
  return {
    ok: newViolations.length === 0 && staleBaselineEntries.length === 0,
    candidates,
    newViolations,
    staleBaselineEntries,
  };
}
