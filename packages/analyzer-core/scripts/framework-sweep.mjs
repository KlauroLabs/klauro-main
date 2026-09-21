import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync, statSync } from 'node:fs';
import * as path from 'node:path';

const CORPUS = process.argv[2] || path.join(process.env.HOME, 'dev', 'corpus');
const INDEXER = path.resolve('native/klauro-engine/target/release/klauro-engine');

const claimed = () => {
  const source = spawnSync('grep', ['-oE', 'known\\("[^"]+", "framework"', 'native/klauro-engine/src/dependencies.rs'], { encoding: 'utf8' });
  return [...new Set(String(source.stdout).split('\n').filter(Boolean).map(line => /known\("([^"]+)"/.exec(line)[1]))].sort();
};

const read = root => {
  const done = spawnSync(INDEXER, [root], {
    env: { ...process.env, KLAURO_ENRICH: '0' },
    maxBuffer: 1 << 30,
    timeout: 600000
  });
  const noise = String(done.stderr || '');
  const number = pattern => { const m = pattern.exec(noise); return m ? Number(m[1]) : 0; };
  return {
    served: number(/\| served (\d+)/),
    frameworks: [...String(noise).matchAll(/framework:([^\s,]+)/g)].map(m => m[1]),
    ran: done.status === 0
  };
};

const roots = readdirSync(CORPUS, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => path.join(CORPUS, entry.name));

const wanted = claimed();

const answeredBy = name => {
  const held = name.toLowerCase();
  return wanted
    .filter(entry => {
      const prefix = entry.toLowerCase();
      if (!held.startsWith(prefix)) return false;
      const next = held[prefix.length];
      return next === undefined || next === '/' || next === '.';
    })
    .sort((left, right) => right.length - left.length)[0];
};

const seen = new Map();
for (const root of roots) {
  const held = read(root);
  for (const framework of held.frameworks) {
    const entry = answeredBy(framework);
    if (!entry) continue;
    if (!seen.has(entry)) seen.set(entry, []);
    seen.get(entry).push({ repo: path.basename(root), served: held.served });
  }
}
const bare = wanted.filter(framework => !seen.has(framework));
const silent = [...seen.entries()].filter(([, rows]) => rows.every(row => row.served === 0));

console.log(`${wanted.length} frameworks claimed, ${seen.size} exercised by ${roots.length} repositories\n`);
for (const framework of [...seen.keys()].sort()) {
  const rows = seen.get(framework);
  const best = Math.max(...rows.map(row => row.served));
  console.log(`  ${framework.padEnd(30)} ${String(rows.length).padStart(2)} repos  best served ${String(best).padStart(5)}  ${best === 0 ? 'SERVES NOTHING' : ''}`);
}
if (bare.length) console.log(`\nclaimed but never exercised (${bare.length}): ${bare.join(' ')}`);
if (silent.length) console.log(`\nexercised but serving nothing (${silent.length}): ${silent.map(([f]) => f).join(' ')}`);
process.exit(bare.length === 0 && silent.length === 0 ? 0 : 1);
