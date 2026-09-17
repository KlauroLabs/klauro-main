import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
require('ts-node/register/transpile-only');

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const registry = require(path.join(root, 'src/analyzer/core/language-registry.ts')).LANGUAGE_REGISTRY;
const scaffold = require(path.join(root, 'src/analyzer/core/scaffold-paths.ts')).SCAFFOLD_DIR_NAMES;
const discovery = require(path.join(root, 'src/analyzer/core/source-discovery.ts'));

const unique = values => [...new Set(values)].sort();
const literal = values => values.map(value => `    ${JSON.stringify(value)},`).join('\n');

const extensions = unique(registry.flatMap(entry => entry.extensions.map(e => e.toLowerCase())));
const manifestNames = unique(registry.flatMap(entry => entry.manifests.map(m => m.toLowerCase())));
const manifestExtensions = unique(registry.flatMap(entry => (entry.manifestExtensions ?? []).map(e => e.toLowerCase())));
const manifestPatterns = unique(registry.flatMap(entry => (entry.manifestPatterns ?? []).map(p => p.source)));
const languageByExtension = [];
for (const entry of registry) {
  for (const extension of entry.extensions) {
    languageByExtension.push([extension.toLowerCase(), entry.id]);
  }
}
languageByExtension.sort((a, b) => a[0].localeCompare(b[0]));
const DATA_FORMATS = new Set(['json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'xml', 'ini', 'cfg', 'conf', 'properties', 'lock']);
const claimants = new Map();
for (const entry of registry) {
  for (const manifest of entry.manifests) {
    const name = manifest.toLowerCase();
    if (!claimants.has(name)) claimants.set(name, []);
    claimants.get(name).push(entry.id);
  }
}
const languageByManifest = [...claimants]
  .filter(([name]) => !DATA_FORMATS.has(name.split('.').pop()))
  .map(([name, ids]) => [name, ids.filter(id => name.startsWith(id)).sort((a, b) => b.length - a.length)[0] ?? (ids.length === 1 ? ids[0] : undefined)])
  .filter(([, id]) => id !== undefined)
  .sort((a, b) => a[0].localeCompare(b[0]));
const skipped = unique([...discovery.SKIPPED_DIRECTORY_NAMES, ...scaffold]);

const generated = `pub static SOURCE_EXTENSIONS: &[&str] = &[
${literal(extensions)}
];

pub static MANIFEST_NAMES: &[&str] = &[
${literal(manifestNames)}
];

pub static MANIFEST_EXTENSIONS: &[&str] = &[
${literal(manifestExtensions)}
];

pub static MANIFEST_PATTERNS: &[&str] = &[
${literal(manifestPatterns)}
];

pub static SKIPPED_DIRECTORIES: &[&str] = &[
${literal(skipped)}
];

pub static LANGUAGE_BY_MANIFEST: &[(&str, &str)] = &[
${languageByManifest.map(([name, id]) => `    (${JSON.stringify(name)}, ${JSON.stringify(id)}),`).join('\n')}
];

pub static LANGUAGE_BY_EXTENSION: &[(&str, &str)] = &[
${languageByExtension.map(([extension, id]) => `    (${JSON.stringify(extension)}, ${JSON.stringify(id)}),`).join('\n')}
];
`;

const target = path.join(root, 'native/klauro-index/src/language_tables.rs');
fs.writeFileSync(target, generated);
process.stdout.write(`${extensions.length} extensions, ${manifestNames.length} manifests, ${skipped.length} skipped directories\n`);
