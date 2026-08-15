#!/usr/bin/env -S npx tsx





import * as fs from 'fs-extra';
import * as path from 'path';
import { findVocabShapeCandidates } from './spec-purity-vocab-shapes';

async function main() {
  const repoRoot = path.resolve(process.argv[2] || process.cwd());
  const candidates = await findVocabShapeCandidates(repoRoot);
  const allowlistPath = path.join(repoRoot, 'apps/mcp-server/src/spec-purity-vocab-allowlist.json');
  const allowlist = new Set<string>();
  try {
    const raw = await fs.readJson(allowlistPath);
    for (const entry of raw.entries || []) allowlist.add(`${entry.file}::${entry.name}`);
  } catch {
  }
  const entries = candidates
    .map(c => ({ file: c.file, name: c.name }))
    .filter(entry => !allowlist.has(`${entry.file}::${entry.name}`))
    .filter((e, i, arr) => arr.findIndex(x => x.file === e.file && x.name === e.name) === i)
    .sort((a, b) => (a.file + a.name).localeCompare(b.file + b.name));
  const out = { generated_at: new Date().toISOString(), note: 'Pre-existing large literal-array/regex-alternation shapes as of the day the spec-purity vocab-shape gate shipped. See spec-purity-vocab-shapes.ts. Regenerate only after reviewing what changed.', entries };
  await fs.writeJson(path.join(repoRoot, 'apps/mcp-server/src/spec-purity-vocab-baseline.json'), out, { spaces: 2 });
  console.log(`Wrote ${entries.length} baseline entries.`);
}

main();
