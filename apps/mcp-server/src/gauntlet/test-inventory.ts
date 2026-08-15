










import * as fs from 'fs-extra';
import * as path from 'path';

export interface TestEntry {
  name: string;
  line: number;
  skipped: boolean;
}

export interface TestFileInventory {
  file: string;
  area: string;
  count: number;
  skipped: number;
  tests: TestEntry[];
}

export interface TestInventory {
  generated_at: string;
  total_files: number;
  total_tests: number;
  total_skipped: number;
  areas: Array<{ area: string; file_count: number; test_count: number; files: TestFileInventory[] }>;
}


const TEST_RE = /\b(?:test|it)(?:\.(skip|todo|only))?\s*\(\s*(['"`])((?:\\.|(?!\2).)*)\2/g;

const SKIP_OPT_RE = /\bskip\s*:/;

function deriveArea(relPath: string): string {
  const p = relPath.replace(/\\/g, '/');
  if (p.includes('/gauntlet/retrieval/')) return 'gauntlet · retrieval backends';
  if (p.includes('/gauntlet/')) return 'gauntlet · core';

  const base = path.basename(p).replace(/\.test\.ts$/, '');
  if (/listing|storage|analysis|workspace/.test(base)) return 'analysis & workspace listing';
  if (/agent|adoption|context|readiness|benchmark|live|idiom|capsule/.test(base)) return 'agent harness & benchmarks';
  if (/cross|was|contract|semantic|graph/.test(base)) return 'cross-codebase / WAS';
  if (/cas|analyzer|orchestrat|framework|route|domain|terminal/.test(base)) return 'analyzer / CAS';
  return 'other server modules';
}

async function listTestFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.git') continue;
        await walk(full);
      } else if (e.isFile() && e.name.endsWith('.test.ts')) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out.sort();
}

function scanFile(content: string): TestEntry[] {
  const entries: TestEntry[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    TEST_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TEST_RE.exec(line)) !== null) {
      const modifier = m[1];
      const rawName = m[3];

      const skipped = modifier === 'skip' || modifier === 'todo' || SKIP_OPT_RE.test(line.slice(m.index));
      entries.push({
        name: rawName.replace(/\\(['"`])/g, '$1'),
        line: i + 1,
        skipped,
      });
    }
  }
  return entries;
}

export async function buildTestInventory(srcRoot?: string): Promise<TestInventory> {
  const root = srcRoot || path.resolve(__dirname, '..');
  const repoRoot = path.resolve(root, '..');
  const files = await listTestFiles(root);

  const fileInventories: TestFileInventory[] = [];
  for (const abs of files) {
    let content = '';
    try { content = await fs.readFile(abs, 'utf8'); } catch { continue; }
    const tests = scanFile(content);
    const rel = path.relative(repoRoot, abs).replace(/\\/g, '/');
    fileInventories.push({
      file: rel,
      area: deriveArea(rel),
      count: tests.length,
      skipped: tests.filter(t => t.skipped).length,
      tests,
    });
  }


  const byArea = new Map<string, TestFileInventory[]>();
  for (const f of fileInventories) {
    if (!byArea.has(f.area)) byArea.set(f.area, []);
    byArea.get(f.area)!.push(f);
  }
  const areas = [...byArea.entries()]
    .map(([area, fs2]) => ({
      area,
      file_count: fs2.length,
      test_count: fs2.reduce((a, f) => a + f.count, 0),
      files: fs2.sort((a, b) => b.count - a.count || a.file.localeCompare(b.file)),
    }))
    .sort((a, b) => b.test_count - a.test_count);

  return {
    generated_at: new Date().toISOString(),
    total_files: fileInventories.length,
    total_tests: fileInventories.reduce((a, f) => a + f.count, 0),
    total_skipped: fileInventories.reduce((a, f) => a + f.skipped, 0),
    areas,
  };
}
