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
    if (entry.name === 'node_modules') continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkSourceFiles(target, extensions));
    } else if (
      extensions.some(extension => entry.name.endsWith(extension)) &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.test.tsx')
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

function hashBinaryContents(directory) {
  let entries;
  try {
    entries = fs.readdirSync(directory).filter(file => file.endsWith('.wasm')).sort();
  } catch {
    return 'no-grammars';
  }

  const hash = crypto.createHash('sha256');
  for (const name of entries) {
    hash.update(name);
    try {
      hash.update(fs.readFileSync(path.join(directory, name)));
    } catch {
      hash.update('MISSING');
    }
  }
  return hash.digest('hex').slice(0, 16);
}

function combineFingerprintParts(...parts) {
  const hash = crypto.createHash('sha256');
  for (const part of parts) {
    hash.update(String(part.length));
    hash.update(':');
    hash.update(part);
  }
  return hash.digest('hex').slice(0, 16);
}

function loadManifest(analyzerCoreRoot) {
  return JSON.parse(fs.readFileSync(path.join(analyzerCoreRoot, 'parser-stage-manifest.json'), 'utf8'));
}

function computeParserFingerprint(analyzerCoreRoot, manifest) {
  const walked = manifest.source_directories.flatMap(directory =>
    walkSourceFiles(path.join(analyzerCoreRoot, directory.path), directory.extensions)
  );
  const declared = manifest.source_files.map(file => path.join(analyzerCoreRoot, file));
  const sourceHash = hashSourceFiles([...walked, ...declared].sort(), analyzerCoreRoot);
  const grammarHash = hashBinaryContents(path.join(analyzerCoreRoot, manifest.grammar_directory));
  return combineFingerprintParts(sourceHash, grammarHash);
}

function computeDerivedFingerprint(analyzerCoreRoot, manifest) {
  const analyzerDirectory = path.join(analyzerCoreRoot, 'src', 'analyzer');
  const parserDirectories = manifest.source_directories
    .map(directory => path.join(analyzerCoreRoot, directory.path))
    .filter(directory => directory === analyzerDirectory || directory.startsWith(`${analyzerDirectory}${path.sep}`));
  const parserFiles = new Set(manifest.source_files.map(file => path.join(analyzerCoreRoot, file)));
  parserFiles.add(path.join(analyzerDirectory, 'core', 'stage-fingerprint.ts'));
  parserFiles.add(path.join(analyzerDirectory, 'core', 'build-identity.ts'));

  const derivedFiles = walkSourceFiles(analyzerDirectory, ['.ts', '.tsx']).filter(file =>
    !parserFiles.has(file) &&
    !parserDirectories.some(directory => file.startsWith(`${directory}${path.sep}`))
  );
  return hashSourceFiles(derivedFiles, analyzerCoreRoot);
}

function computeBuildStageFingerprints(analyzerCoreRoot) {
  const manifest = loadManifest(analyzerCoreRoot);
  return {
    parser_fingerprint: computeParserFingerprint(analyzerCoreRoot, manifest),
    derived_fingerprint: computeDerivedFingerprint(analyzerCoreRoot, manifest),
  };
}

module.exports = { computeBuildStageFingerprints };
