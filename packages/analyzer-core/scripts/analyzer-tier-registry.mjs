import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const analyzerRoot = path.join(packageRoot, 'src', 'analyzer');
const registryPath = path.join(
  packageRoot,
  'src',
  '__tests__',
  'architecture',
  'analyzer-tier-registry.json',
);

function productionModules(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionModules(fullPath);
    if (
      !entry.isFile()
      || !entry.name.endsWith('.ts')
      || entry.name.endsWith('.test.ts')
      || entry.name.endsWith('.integration.test.ts')
    ) return [];
    return [path.relative(analyzerRoot, fullPath).split(path.sep).join('/')];
  }).sort();
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

const modules = productionModules(analyzerRoot);
const moduleSet = new Set(modules);
const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
const assignments = process.argv.slice(2).filter(argument => argument.startsWith('--assign='));
const pruneStale = process.argv.includes('--prune-stale');
const write = assignments.length > 0 || pruneStale;

for (const argument of assignments) {
  const match = /^--assign=(.+):([1-4])$/.exec(argument);
  if (!match) {
    fail(`Invalid assignment "${argument}". Expected --assign=analyzer/root/path.ts:1|2|3|4.`);
    continue;
  }
  const [, modulePath, tier] = match;
  if (!moduleSet.has(modulePath)) {
    fail(`Cannot assign an unknown production analyzer module: ${modulePath}`);
    continue;
  }
  registry[modulePath] = Number(tier);
}

const stale = Object.keys(registry).filter(modulePath => !moduleSet.has(modulePath)).sort();
if (pruneStale) {
  for (const modulePath of stale) delete registry[modulePath];
} else if (stale.length > 0) {
  fail(`Stale tier assignments:\n${stale.map(value => `  ${value}`).join('\n')}\nRe-run with --prune-stale only after verifying those modules were intentionally removed.`);
}

const missing = modules.filter(modulePath => registry[modulePath] === undefined);
if (missing.length > 0) {
  fail(`Unassigned production analyzer modules:\n${missing.map(value => `  ${value}`).join('\n')}\nAssign each explicitly with --assign=path.ts:tier.`);
}

const invalid = Object.entries(registry)
  .filter(([, tier]) => ![1, 2, 3, 4].includes(tier))
  .map(([modulePath, tier]) => `${modulePath}=${tier}`)
  .sort();
if (invalid.length > 0) fail(`Invalid tier assignments:\n${invalid.map(value => `  ${value}`).join('\n')}`);

if (process.exitCode) process.exit();

const sorted = Object.fromEntries(
  Object.entries(registry).sort(([left], [right]) => left.localeCompare(right)),
);
const serialized = `${JSON.stringify(sorted, null, 2)}\n`;

if (write) {
  fs.writeFileSync(registryPath, serialized);
  process.stdout.write(`Updated ${path.relative(packageRoot, registryPath)} with ${modules.length} explicit assignments.\n`);
} else if (fs.readFileSync(registryPath, 'utf8') !== serialized) {
  fail('Tier registry keys are not deterministically sorted. Run npm run tier-registry:update with explicit assignments as needed.');
} else {
  process.stdout.write(`Verified ${modules.length} production analyzer modules have explicit tier assignments.\n`);
}
