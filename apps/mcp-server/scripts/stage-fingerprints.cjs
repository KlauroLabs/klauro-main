const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function walkSourceFiles(directory, extensions) {
  const files = [];
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'target') continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkSourceFiles(target, extensions));
    } else if (
      extensions.some(extension => entry.name.endsWith(extension)) &&
      !entry.name.endsWith('.test.ts')
    ) {
      files.push(target);
    }
  }
  return files.sort();
}

function hashSourceFiles(files, identityRoot) {
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(path.relative(identityRoot, file).split(path.sep).join('/'));
    try {
      hash.update(fs.readFileSync(file));
    } catch {
      hash.update('MISSING');
    }
  }
  return hash.digest('hex').slice(0, 16);
}

function loadManifest(analyzerCoreRoot) {
  return JSON.parse(fs.readFileSync(path.join(analyzerCoreRoot, 'parser-stage-manifest.json'), 'utf8'));
}

function computeStageFingerprint(analyzerCoreRoot, stage) {
  const walked = stage.directories.flatMap(directory =>
    walkSourceFiles(path.join(analyzerCoreRoot, directory.path), directory.extensions)
  );
  const declared = stage.files.map(file => path.join(analyzerCoreRoot, file));
  return hashSourceFiles([...new Set([...walked, ...declared])].sort(), analyzerCoreRoot);
}

function computeBuildStageFingerprints(analyzerCoreRoot) {
  const manifest = loadManifest(analyzerCoreRoot);
  return {
    parser_fingerprint: computeStageFingerprint(analyzerCoreRoot, manifest.parser),
    derived_fingerprint: computeStageFingerprint(analyzerCoreRoot, manifest.derived),
  };
}

module.exports = { computeBuildStageFingerprints };
