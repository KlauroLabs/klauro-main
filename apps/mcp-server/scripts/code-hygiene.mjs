#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { glob } from 'glob';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageRoot, '../..');
const fix = process.argv.includes('--fix');
const include = [
  'src/**/*.{ts,tsx,js,jsx,mjs,cjs}',
  'scripts/**/*.{ts,tsx,js,jsx,mjs,cjs}',
  '../../packages/analyzer-core/src/**/*.{ts,tsx,js,jsx,mjs,cjs}',
  '../../packages/analyzer-core/scripts/**/*.{ts,tsx,js,jsx,mjs,cjs}',
  '../../packages/klauro-sdk-js/src/**/*.{ts,tsx,js,jsx,mjs,cjs}',
  '../marketing-site/src/**/*.{ts,tsx,js,jsx,mjs,cjs}',
];
const ignore = [
  '**/node_modules/**',
  '**/target/**',
  '**/dist/**',
  '**/dist-*/**',
  '**/*.test.*',
  '**/*.spec.*',
  '**/__tests__/**',
  '**/fixtures/**',
  '**/test-data/**',
  '**/test-fixtures/**',
];
const standaloneCommentInclude = [
  'scripts/**/*.{sh,ps1}',
  '../../infrastructure/vps/**/*.{sh,yml,yaml}',
  '../../infrastructure/vps/**/Dockerfile*',
  '../../packages/analyzer-core/native/**/*.rs',
];

const files = (await glob(include, { cwd: packageRoot, absolute: true, nodir: true, ignore }))
  .filter(file => !isExcluded(file))
  .sort();
const standaloneCommentFiles = (await glob(standaloneCommentInclude, { cwd: packageRoot, absolute: true, nodir: true, ignore }))
  .sort();
const violations = [];

for (const file of files) {
  const source = await readFile(file, 'utf8');
  const ranges = commentRanges(source, file);
  if (ranges.length === 0) continue;
  violations.push({ file, count: ranges.length });
  if (fix) await writeFile(file, removeRanges(source, ranges), 'utf8');
}

for (const file of standaloneCommentFiles) {
  const source = await readFile(file, 'utf8');
  const lines = source.split(/(?<=\n)/);
  const marker = path.extname(file).toLowerCase() === '.rs'
    ? /^[\t ]*(?:\/\/|\/\*)/
    : /^[\t ]*#(?!\!)/;
  const indexes = lines.flatMap((line, index) => marker.test(line) ? [index] : []);
  if (indexes.length === 0) continue;
  violations.push({ file, count: indexes.length });
  if (fix) {
    const rejected = new Set(indexes);
    await writeFile(file, lines.filter((_, index) => !rejected.has(index)).join(''), 'utf8');
  }
}

if (violations.length === 0) {
  process.stdout.write(`Production code hygiene passed across ${files.length + standaloneCommentFiles.length} files.\n`);
} else if (fix) {
  const count = violations.reduce((sum, violation) => sum + violation.count, 0);
  process.stdout.write(`Removed ${count} comments from ${violations.length} production files.\n`);
} else {
  for (const violation of violations) {
    process.stderr.write(`${path.relative(packageRoot, violation.file)}: ${violation.count} comment(s)\n`);
  }
  process.stderr.write(`Production code hygiene failed in ${violations.length} file(s). Run npm run code-hygiene:fix.\n`);
  process.exitCode = 1;
}

function commentRanges(source, file) {
  const extension = path.extname(file).toLowerCase();
  const scriptKind = extension === '.tsx'
    ? ts.ScriptKind.TSX
    : extension === '.jsx'
      ? ts.ScriptKind.JSX
      : extension === '.ts'
        ? ts.ScriptKind.TS
        : ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind);
  if (sourceFile.parseDiagnostics.length > 0) {
    const diagnostic = sourceFile.parseDiagnostics[0];
    const position = sourceFile.getLineAndCharacterOfPosition(diagnostic.start || 0);
    throw new Error(`${path.relative(repoRoot, file)}:${position.line + 1}:${position.character + 1} is not valid source code`);
  }
  const ranges = new Map();
  const add = comments => {
    for (const comment of comments || []) ranges.set(`${comment.pos}:${comment.end}`, { start: comment.pos, end: comment.end });
  };
  const visit = node => {
    add(ts.getLeadingCommentRanges(source, node.getFullStart()));
    add(ts.getTrailingCommentRanges(source, node.end));
    for (const child of node.getChildren(sourceFile)) visit(child);
  };
  visit(sourceFile);
  return [...ranges.values()].sort((left, right) => left.start - right.start);
}

function removeRanges(source, ranges) {
  let output = '';
  let cursor = 0;
  for (const range of ranges) {
    output += source.slice(cursor, range.start);
    const comment = source.slice(range.start, range.end);
    const separatesIdentifiers = /[A-Za-z0-9_$]/.test(source[range.start - 1] || '') && /[A-Za-z0-9_$]/.test(source[range.end] || '');
    output += comment.includes('\n') || comment.includes('\r')
      ? comment.replace(/[^\r\n]/g, '')
      : separatesIdentifiers ? ' ' : '';
    cursor = range.end;
  }
  return output + source.slice(cursor);
}

function isExcluded(file) {
  const relative = path.relative(repoRoot, file).split(path.sep).join('/');
  return /(^|\/)(__tests__|fixtures|test-data|test-fixtures)(\/|$)/.test(relative) || /\.(test|spec)\.[^.]+$/.test(relative);
}
