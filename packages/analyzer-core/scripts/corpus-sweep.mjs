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
  ['clojure', 'tree-sitter-clojure pins tree-sitter 0.25'],
  ['tcl', 'no crate at this tree-sitter'],
  ['rescript', 'no crate at this tree-sitter'],
  ['twig', 'no crate'],
  ['glimmer', 'no crate'],
  ['gdshader', 'no crate'],
  ['installer_scripts', 'batch and installer scripts have no grammar']
]);

function index(root, repeat) {
  const run = spawnSync(INDEXER, [root], {
    env: { ...process.env, KLAURO_REPORT_COVERAGE: '1' },
    maxBuffer: 1 << 30
  });
  if (run.status !== 0) {
    return { failed: run.error ? run.error.message : `exit ${run.status}` };
  }
  const report = run.stderr.toString();
  const number = pattern => {
    const found = report.match(pattern);
    return found ? Number(found[1]) : 0;
  };
  const coverage = [...report.matchAll(/^ {2}coverage (\S+)\s+(\d+) of\s+(\d+)$/gm)].map(
    ([, language, extracted, total]) => ({ language, extracted: Number(extracted), total: Number(total) })
  );
  const again = repeat
    ? createHash('sha1').update(spawnSync(INDEXER, [root], { maxBuffer: 1 << 30 }).stdout).digest('hex').slice(0, 12)
    : undefined;
  return {
    again,
    digest: createHash('sha1').update(run.stdout).digest('hex').slice(0, 12),
    files: number(/\((\d+) files\)/),
    errors: number(/parse errors (\d+)/),
    milliseconds: seconds(report, /parse ([\d.]+)(m?s)/) + seconds(report, /discover ([\d.]+)(m?s)/) +
      seconds(report, /resolve ([\d.]+)(m?s)/) + seconds(report, /graph ([\d.]+)(m?s)/),
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
console.log('repo'.padEnd(30) + 'files'.padStart(7) + 'errors'.padStart(8) + 't1 ms'.padStart(8) + '  digest');
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
  const allowance = Math.max(200, measured.files * MILLISECONDS_PER_FILE);
  if (measured.milliseconds > allowance) {
    failures.push(
      `${repo} spent ${Math.round(measured.milliseconds)} ms on ${measured.files} files, over its ${Math.round(allowance)} ms allowance`
    );
  }
  console.log(
    repo.padEnd(30) +
      String(measured.files).padStart(7) +
      String(measured.errors).padStart(8) +
      String(Math.round(measured.milliseconds)).padStart(8) +
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
