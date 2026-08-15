#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const configPath = path.resolve(process.argv[2] || 'tsconfig.json');
const write = process.argv.includes('--write');
const diagnosticCodes = new Set([6133, 6138, 6192, 6196]);

function loadConfig() {
  const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
  if (loaded.error) throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, '\n'));
  return ts.parseJsonConfigFileContent(
    loaded.config,
    ts.sys,
    path.dirname(configPath),
    { noEmit: true, noUnusedLocals: true, noUnusedParameters: false },
    configPath,
  );
}

function createService(parsed) {
  const versions = new Map(parsed.fileNames.map(file => [file, '0']));
  const host = {
    getCompilationSettings: () => parsed.options,
    getScriptFileNames: () => parsed.fileNames,
    getScriptVersion: file => versions.get(file) || '0',
    getScriptSnapshot: file => {
      if (!fs.existsSync(file)) return undefined;
      return ts.ScriptSnapshot.fromString(fs.readFileSync(file, 'utf8'));
    },
    getCurrentDirectory: () => path.dirname(configPath),
    getDefaultLibFileName: options => ts.getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  return ts.createLanguageService(host, ts.createDocumentRegistry());
}

function unusedDiagnostics(service, files) {
  return files.flatMap(file => service.getSemanticDiagnostics(file)
    .filter(diagnostic => diagnosticCodes.has(diagnostic.code) && diagnostic.start !== undefined)
    .map(diagnostic => ({ file, diagnostic })));
}

function editsForDiagnostics(service, diagnostics) {
  const edits = new Map();
  for (const { file, diagnostic } of diagnostics) {
    const fixes = service.getCodeFixesAtPosition(
      file,
      diagnostic.start,
      diagnostic.start + diagnostic.length,
      [diagnostic.code],
      {},
      {},
    );
    const fix = fixes.find(candidate => candidate.fixName.includes('unused')) || fixes[0];
    if (!fix) continue;
    for (const change of fix.changes) {
      const list = edits.get(change.fileName) || [];
      list.push(...change.textChanges);
      edits.set(change.fileName, list);
    }
  }
  return edits;
}

function applyEdits(edits) {
  let applied = 0;
  for (const [file, changes] of edits) {
    const unique = new Map(changes.map(change => [`${change.span.start}:${change.span.length}:${change.newText}`, change]));
    const ordered = [...unique.values()].sort((left, right) => right.span.start - left.span.start);
    let source = fs.readFileSync(file, 'utf8');
    let boundary = source.length + 1;
    for (const change of ordered) {
      const end = change.span.start + change.span.length;
      if (end > boundary) continue;
      source = source.slice(0, change.span.start) + change.newText + source.slice(end);
      boundary = change.span.start;
      applied += 1;
    }
    fs.writeFileSync(file, source);
  }
  return applied;
}

const parsed = loadConfig();
const service = createService(parsed);
const diagnostics = unusedDiagnostics(service, parsed.fileNames);
if (!write) {
  for (const { file, diagnostic } of diagnostics) {
    const position = service.getProgram().getSourceFile(file).getLineAndCharacterOfPosition(diagnostic.start);
    process.stdout.write(`${path.relative(process.cwd(), file)}:${position.line + 1}:${position.character + 1} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}\n`);
  }
  process.exitCode = diagnostics.length > 0 ? 1 : 0;
} else {
  const edits = editsForDiagnostics(service, diagnostics);
  const applied = applyEdits(edits);
  process.stdout.write(`Applied ${applied} compiler fixes for ${diagnostics.length} unused declarations.\n`);
}
