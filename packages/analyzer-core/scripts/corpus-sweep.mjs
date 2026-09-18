import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';

const CORPUS = process.argv[2] || path.join(process.env.HOME, 'dev', 'corpus');
const INDEXER = path.resolve('native/klauro-index/target/release/klauro-index');
const COVERAGE_FLOOR = 95;
const MILLISECONDS_PER_FILE = 0.8;
const MINIMUM_FILES = 15;

const WITHOUT_A_GRAMMAR = new Map([
  ['installer_scripts', 'batch and installer scripts have no grammar']
]);

// A repo with a known served surface, and the floor its surface must hold. Pass 1.6 measures
// reachability from entry points, so a surface that silently drops reports working code as
// unreachable. Test entries are excluded: saleor declares 12,817 of them and 1,156 real ones.
const SERVED_SURFACE = new Map([
  ['cal.com', { served: 300, exits: 615 }],
  ['immich', { served: 720, exits: 295 }],
  ['jellyfin', { served: 395, exits: 535 }],
  ['jekyll', { served: 20, exits: 20 }],
  ['mastodon', { served: 230, exits: 250 }],
  ['meilisearch', { served: 14, exits: 170 }],
  ['metabase', { served: 0, exits: 230 }],
  ['monica', { served: 215, exits: 100 }],
  ['neovim', { served: 25, exits: 470 }],
  ['ripgrep', { served: 6, exits: 40 }],
  ['saleor', { served: 1150, exits: 9570 }],
  ['superset', { served: 290, exits: 385 }],
  ['tivi', { served: 20, exits: 290 }],
  ['traefik', { served: 25, exits: 750 }]
]);

function run(root) {
  return spawnSync(INDEXER, [root], {
    env: { ...process.env, KLAURO_REPORT_COVERAGE: '1' },
    maxBuffer: 1 << 30
  });
}

function elapsed(report) {
  return seconds(report, /parse ([\d.]+)(m?s)/) + seconds(report, /discover ([\d.]+)(m?s)/) +
    seconds(report, /resolve ([\d.]+)(m?s)/) + seconds(report, /graph ([\d.]+)(m?s)/);
}

function index(root, repeat) {
  const first = run(root);
  if (first.status !== 0) {
    return { failed: first.error ? first.error.message : `exit ${first.status}` };
  }
  const report = first.stderr.toString();
  const number = pattern => {
    const found = report.match(pattern);
    return found ? Number(found[1]) : 0;
  };
  const coverage = [...report.matchAll(/^ {2}coverage (\S+)\s+(\d+) of\s+(\d+)$/gm)].map(
    ([, language, extracted, total]) => ({ language, extracted: Number(extracted), total: Number(total) })
  );
  const files = number(/\((\d+) files\)/);
  const allowance = Math.max(200, files * MILLISECONDS_PER_FILE);
  let milliseconds = elapsed(report);
  let again;
  // Wall time on a machine that is also building is noisy, and a budget that fails at random
  // teaches everyone to re-run it until it is green. A repo is only over budget when it is
  // over twice, and the second run doubles as the determinism check.
  if (repeat || milliseconds > allowance) {
    const second = run(root);
    if (second.status === 0) {
      milliseconds = Math.min(milliseconds, elapsed(second.stderr.toString()));
      again = createHash('sha1').update(second.stdout).digest('hex').slice(0, 12);
    }
  }
  return {
    again,
    allowance,
    digest: createHash('sha1').update(first.stdout).digest('hex').slice(0, 12),
    files,
    served: number(/\| served (\d+)/),
    exits: number(/exit points (\d+)/),
    errors: number(/parse errors (\d+)/),
    milliseconds,
    coverage
  };
}

function seconds(report, pattern) {
  const found = report.match(pattern);
  if (!found) return 0;
  return found[2] === 'ms' ? Number(found[1]) : Number(found[1]) * 1000;
}

const repos = readdirSync(CORPUS)
  .filter(name => statSync(path.join(CORPUS, name)).isDirectory())
  .sort();

const totals = new Map();
const failures = [];
console.log(
  'repo'.padEnd(30) + 'files'.padStart(7) + 'errors'.padStart(8) + 't1 ms'.padStart(8) +
    'served'.padStart(8) + 'exits'.padStart(8) + '  digest'
);
for (const repo of repos) {
  const measured = index(path.join(CORPUS, repo), process.argv.includes('--twice'));
  if (measured.failed) {
    failures.push(`${repo} did not index: ${measured.failed}`);
    console.log(repo.padEnd(30) + '  FAILED');
    continue;
  }
  for (const { language, extracted, total } of measured.coverage) {
    const running = totals.get(language) || { extracted: 0, total: 0 };
    running.extracted += extracted;
    running.total += total;
    totals.set(language, running);
  }
  if (measured.again && measured.again !== measured.digest) {
    failures.push(`${repo} indexed differently on a second run`);
  }
  const surface = SERVED_SURFACE.get(repo);
  if (surface) {
    if (measured.served < surface.served) {
      failures.push(
        `${repo} found ${measured.served} served entry points, below its floor of ${surface.served}`
      );
    }
    if (measured.exits < surface.exits) {
      failures.push(
        `${repo} found ${measured.exits} exit points, below its floor of ${surface.exits}`
      );
    }
  }
  if (measured.milliseconds > measured.allowance) {
    failures.push(
      `${repo} spent ${Math.round(measured.milliseconds)} ms on ${measured.files} files on its fastest of two runs, over its ${Math.round(measured.allowance)} ms allowance`
    );
  }
  console.log(
    repo.padEnd(30) +
      String(measured.files).padStart(7) +
      String(measured.errors).padStart(8) +
      String(Math.round(measured.milliseconds)).padStart(8) +
      String(measured.served).padStart(8) +
      String(measured.exits).padStart(8) +
      '  ' + measured.digest
  );
}

console.log('\nlanguage'.padEnd(22) + 'files'.padStart(8) + 'read'.padStart(8) + '  note');
const ranked = [...totals.entries()]
  .filter(([, counts]) => counts.total >= MINIMUM_FILES)
  .sort((left, right) => left[1].extracted / left[1].total - right[1].extracted / right[1].total);
for (const [language, counts] of ranked) {
  const read = Math.round((100 * counts.extracted) / counts.total);
  const excused = WITHOUT_A_GRAMMAR.get(language);
  if (read < COVERAGE_FLOOR && !excused) {
    failures.push(`${language} reads ${read}% of ${counts.total} files, below the ${COVERAGE_FLOOR}% floor`);
  }
  console.log(language.padEnd(22) + String(counts.total).padStart(8) + `${read}%`.padStart(8) + '  ' + (excused || ''));
}

if (failures.length > 0) {
  console.log('\nsweep failed:');
  for (const failure of failures) console.log('  ' + failure);
  process.exit(1);
}
console.log('\nsweep ok');
