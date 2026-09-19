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

// A repo with a known served surface, and the floors its analysis must hold. Pass 1.6 measures
// reachability from entry points, so a surface that silently drops reports working code as
// unreachable. Test entries are excluded: saleor declares 12,817 of them and 1,156 real ones.
// `observed` is pass 1.5: units of which some ICELOT facet was actually seen. A pass with no
// floor is a pass that rots, which is how entry points and exits both got here.
const SERVED_SURFACE = new Map([
  ['cal.com', { served: 300, exits: 615, observed: 15500, reachable: 9400, resolved: 19500, projects: 120 }],
  ['immich', { served: 720, exits: 295, observed: 17500, reachable: 10200, resolved: 20000, projects: 18 }],
  ['jellyfin', { served: 395, exits: 535, observed: 11800, reachable: 4450, resolved: 17500, projects: 42 }],
  ['jekyll', { served: 20, exits: 20 }],
  ['mastodon', { served: 230, exits: 250, observed: 40000, reachable: 28000, resolved: 21000, projects: 3 }],
  ['meilisearch', { served: 14, exits: 170 }],
  ['metabase', { served: 0, exits: 230, projects: 16 }],
  ['monica', { served: 218, exits: 100, observed: 6700, reachable: 400, resolved: 8700, projects: 3 }],
  ['neovim', { served: 25, exits: 470 }],
  ['ripgrep', { served: 6, exits: 40 }],
  ['saleor', { served: 1150, exits: 9570, observed: 21500, reachable: 16000, resolved: 55000, projects: 2 }],
  ['superset', { served: 290, exits: 6300, observed: 55000, reachable: 40000, resolved: 63000, projects: 36 }],
  ['tivi', { served: 20, exits: 290 }],
  ['traefik', { served: 25, exits: 750, observed: 6500, reachable: 3800, resolved: 7700, projects: 4 }]
]);

// The whole run, not a sum of the passes it reports: a pass left out of that sum is a pass
// with no budget at all, and one of them once spent 96 seconds where the sum read 1.
function run(root) {
  const started = Date.now();
  const finished = spawnSync(INDEXER, [root], {
    env: { ...process.env, KLAURO_REPORT_COVERAGE: '1' },
    maxBuffer: 1 << 30
  });
  finished.milliseconds = Date.now() - started;
  return finished;
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
  let milliseconds = first.milliseconds;
  let again;
  // Wall time on a machine that is also building is noisy, and a budget that fails at random
  // teaches everyone to re-run it until it is green. A repo is only over budget when it is
  // over twice, and the second run doubles as the determinism check.
  if (repeat || milliseconds > allowance) {
    const second = run(root);
    if (second.status === 0) {
      milliseconds = Math.min(milliseconds, second.milliseconds);
      again = createHash('sha1').update(second.stdout).digest('hex').slice(0, 12);
    }
  }
  return {
    again,
    allowance,
    digest: createHash('sha1').update(first.stdout).digest('hex').slice(0, 12),
    files,
    served: number(/\| served (\d+)/),
    observed: number(/\| observed (\d+)/),
    // Pass 1.3: edges that land on something declared here, rather than on a package or a
    // runtime. This is the number every later tier is built from.
    resolved: number(/resolve [^|]*\| edges (\d+)/) - number(/\| package (\d+)/) -
      number(/\| runtime (\d+)/),
    projects: number(/\| projects (\d+)/),
    unpartitioned: number(/unpartitioned (\d+)/),
    reachable: number(/reachable units (\d+)/),
    exits: number(/exit points (\d+)/),
    errors: number(/parse errors (\d+)/),
    milliseconds,
    coverage
  };
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
    if (surface.projects && measured.projects < surface.projects) {
      failures.push(
        `${repo} found ${measured.projects} projects, below its floor of ${surface.projects}`
      );
    }
    if (surface.resolved && measured.resolved < surface.resolved) {
      failures.push(
        `${repo} resolved ${measured.resolved} in-repo edges, below its floor of ${surface.resolved}`
      );
    }
    if (surface.observed && measured.observed < surface.observed) {
      failures.push(
        `${repo} observed ICELOT facets on ${measured.observed} units, below its floor of ${surface.observed}`
      );
    }
    if (surface.reachable && measured.reachable < surface.reachable) {
      failures.push(
        `${repo} reached ${measured.reachable} units, below its floor of ${surface.reachable}`
      );
    }
  }
  if (measured.unpartitioned > 0) {
    failures.push(`${repo} left ${measured.unpartitioned} declarations in no project`);
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
