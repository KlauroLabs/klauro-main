#!/usr/bin/env -S npx tsx
// One-off baseline generator — NOT wired into deploy.sh. Run manually after
// reviewing new candidates: `npx tsx src/spec-purity-vocab-baseline-gen.ts .`
// regenerates spec-purity-vocab-baseline.json from the CURRENT candidate set,
// so it should only be run after a human has looked at what changed (a git
// diff on the baseline file itself is the review artifact).
import * as fs from 'fs-extra';
import * as path from 'path';
import { findVocabShapeCandidates } from './spec-purity-vocab-shapes';

async function main() {
  const repoRoot = path.resolve(process.argv[2] || process.cwd());
  const candidates = await findVocabShapeCandidates(repoRoot);
  const entries = candidates
    .map(c => ({ file: c.file, name: c.name }))
    .filter((e, i, arr) => arr.findIndex(x => x.file === e.file && x.name === e.name) === i)
    .sort((a, b) => (a.file + a.name).localeCompare(b.file + b.name));
  const out = { generated_at: new Date().toISOString(), note: 'Pre-existing large literal-array/regex-alternation shapes as of the day the spec-purity vocab-shape gate shipped. See spec-purity-vocab-shapes.ts. Regenerate only after reviewing what changed.', entries };
  await fs.writeJson(path.join(repoRoot, 'apps/mcp-server/src/spec-purity-vocab-baseline.json'), out, { spaces: 2 });
  console.log(`Wrote ${entries.length} baseline entries.`);
}

main();
