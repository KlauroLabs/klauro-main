












































import { execFile } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as ts from 'typescript';

import type { SymbolChange, SymbolChangeKind, SymbolChangeShape } from './conceptual-conflict';

export interface CaptureOpts {

  repoPath: string;

  baseRef?: string;









  maxFiles?: number;
}







const ANALYZABLE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.cs', '.cpp', '.cc', '.c', '.h', '.hpp',
  '.php', '.scala', '.ex', '.exs', '.dart', '.vue', '.svelte',
]);

const TS_JS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

function runGit(repoPath: string, args: string[]): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    execFile('git', ['-C', repoPath, ...args], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {


      resolve({ stdout: stdout ?? '', code: error && typeof (error as any).code === 'number' ? (error as any).code : 0 });
    });
  });
}

interface ChangedFile {
  file: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'unknown';
}

async function listChangedFiles(repoPath: string, baseRef: string): Promise<ChangedFile[]> {
  const { stdout } = await runGit(repoPath, ['diff', '--name-status', baseRef, '--']);
  const files: ChangedFile[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('\t');
    const code = parts[0];
    let status: ChangedFile['status'] = 'unknown';
    let file = parts[1];
    if (code?.startsWith('A')) status = 'added';
    else if (code?.startsWith('M')) status = 'modified';
    else if (code?.startsWith('D')) status = 'deleted';
    else if (code?.startsWith('R')) {
      status = 'renamed';
      file = parts[2] || parts[1];
    }
    if (file) files.push({ file, status });
  }
  return files;
}

async function readBeforeContent(repoPath: string, baseRef: string, file: string): Promise<string | undefined> {
  const { stdout, code } = await runGit(repoPath, ['show', `${baseRef}:${file}`]);
  if (code !== 0) return undefined;
  return stdout;
}

async function readAfterContent(repoPath: string, file: string): Promise<string | undefined> {
  try {
    return await fsp.readFile(path.join(repoPath, file), 'utf8');
  } catch {
    return undefined;
  }
}





interface ExtractedSymbol {
  name: string;


  key: string;
  signature: string;
  return_type?: string;
  nullable?: boolean;
  params: string[];
  kind: 'function' | 'method' | 'arrow';
  body: string;
}

function scriptKindFor(file: string): ts.ScriptKind {
  const ext = path.extname(file);
  if (ext === '.tsx') return ts.ScriptKind.TSX;
  if (ext === '.jsx') return ts.ScriptKind.JSX;
  if (ext === '.ts') return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function typeNodeToString(node: ts.TypeNode | undefined, sourceText: string): string | undefined {
  if (!node) return undefined;
  return sourceText.slice(node.pos, node.end).trim();
}





function looksNullable(returnType: string | undefined): boolean | undefined {
  if (returnType === undefined) return undefined;
  return /\bnull\b/.test(returnType) || /\bundefined\b/.test(returnType);
}

function paramListToStrings(params: ts.NodeArray<ts.ParameterDeclaration>, sourceText: string): string[] {
  return params.map((p) => sourceText.slice(p.pos, p.end).trim());
}









function extractSymbols(sourceText: string, file: string): ExtractedSymbol[] {
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, scriptKindFor(file));
  const out: ExtractedSymbol[] = [];

  function addFunctionLike(
    name: string,
    kind: ExtractedSymbol['kind'],
    params: ts.NodeArray<ts.ParameterDeclaration>,
    returnTypeNode: ts.TypeNode | undefined,
    fullSignatureText: string,
    bodyText: string,
  ) {
    const return_type = typeNodeToString(returnTypeNode, sourceText);
    out.push({
      name,
      key: `${kind}:${name}`,
      signature: fullSignatureText.trim(),
      return_type,
      nullable: looksNullable(return_type),
      params: paramListToStrings(params, sourceText),
      kind,
      body: bodyText,
    });
  }

  function visit(node: ts.Node, className?: string) {
    if (ts.isFunctionDeclaration(node) && node.name) {
      const sigEnd = node.body ? node.body.pos : node.end;
      addFunctionLike(node.name.text, 'function', node.parameters, node.type, sourceText.slice(node.pos, sigEnd), node.body ? sourceText.slice(node.body.pos, node.body.end) : '');
    } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      const sigEnd = node.body ? node.body.pos : node.end;
      const name = className ? `${className}.${node.name.text}` : node.name.text;
      addFunctionLike(name, 'method', node.parameters, node.type, sourceText.slice(node.pos, sigEnd), node.body ? sourceText.slice(node.body.pos, node.body.end) : '');
    } else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
          const fn = decl.initializer;
          const sigEnd = fn.body ? fn.body.pos : fn.end;
          addFunctionLike(decl.name.text, 'arrow', fn.parameters, fn.type, sourceText.slice(node.pos, sigEnd), sourceText.slice(fn.body.pos, fn.body.end));
        }
      }
    }

    if (ts.isClassDeclaration(node) && node.name) {
      ts.forEachChild(node, (child) => visit(child, node.name!.text));
      return;
    }
    ts.forEachChild(node, (child) => visit(child, className));
  }

  ts.forEachChild(sourceFile, (n) => visit(n));
  return out;
}

function shapeOf(sym: ExtractedSymbol): SymbolChangeShape {
  return {
    signature: sym.signature,
    return_type: sym.return_type,
    nullable: sym.nullable,
  };
}

function classifyChange(before: ExtractedSymbol, after: ExtractedSymbol): { kind: SymbolChangeKind; changed: boolean } {
  if (before.nullable !== undefined && after.nullable !== undefined && before.nullable !== after.nullable) {
    return { kind: 'nullability', changed: true };
  }
  if (before.return_type !== after.return_type) {
    return { kind: 'return_type', changed: true };
  }
  if (before.params.length !== after.params.length || before.params.some((p, i) => p !== after.params[i])) {
    return { kind: 'param', changed: true };
  }
  if (before.signature !== after.signature) {
    return { kind: 'signature', changed: true };
  }
  return { kind: 'body', changed: before.body !== after.body };
}


function diffTsJsFile(file: string, beforeText: string | undefined, afterText: string | undefined): SymbolChange[] {
  const before = beforeText !== undefined ? extractSymbols(beforeText, file) : [];
  const after = afterText !== undefined ? extractSymbols(afterText, file) : [];

  const beforeByKey = new Map(before.map((s) => [s.key, s]));
  const afterByKey = new Map(after.map((s) => [s.key, s]));

  const changes: SymbolChange[] = [];

  for (const [key, afterSym] of afterByKey) {
    const beforeSym = beforeByKey.get(key);
    const symbol_id = `sym:${file}:${afterSym.name}`;
    if (!beforeSym) {






      changes.push({
        symbol_id,
        name: afterSym.name,
        file,
        change_kind: 'add',
        after: shapeOf(afterSym),
      });
      continue;
    }
    const { kind, changed } = classifyChange(beforeSym, afterSym);
    if (!changed) continue;
    changes.push({
      symbol_id,
      name: afterSym.name,
      file,
      change_kind: kind,
      before: shapeOf(beforeSym),
      after: shapeOf(afterSym),
    });
  }

  for (const [key, beforeSym] of beforeByKey) {
    if (afterByKey.has(key)) continue;
    const symbol_id = `sym:${file}:${beforeSym.name}`;
    changes.push({
      symbol_id,
      name: beforeSym.name,
      file,
      change_kind: 'delete',
      before: shapeOf(beforeSym),
    });
  }

  return changes;
}



function unknownChangeFallback(file: string, status: ChangedFile['status']): SymbolChange[] {
  if (status === 'deleted') {
    return [{
      symbol_id: `sym:${file}:__file__`,
      name: path.basename(file),
      file,
      change_kind: 'delete',
    }];
  }
  return [{
    symbol_id: `sym:${file}:__file__`,
    name: path.basename(file),
    file,
    change_kind: 'body',
  }];
}










export async function captureInFlightChanges(opts: CaptureOpts): Promise<SymbolChange[]> {
  const repoPath = opts.repoPath;
  const baseRef = opts.baseRef ?? 'HEAD';

  const changedFiles = await listChangedFiles(repoPath, baseRef);
  const changes: SymbolChange[] = [];
  let analyzed = 0;

  for (const { file, status } of changedFiles) {
    const ext = path.extname(file);
    if (!ANALYZABLE_EXTENSIONS.has(ext)) {



      changes.push(...unknownChangeFallback(file, status));
      continue;
    }
    const parseStructurally = opts.maxFiles === undefined || analyzed < opts.maxFiles;
    if (parseStructurally) analyzed++;

    if (status === 'deleted') {
      if (TS_JS_EXTENSIONS.has(ext) && parseStructurally) {
        const beforeText = await readBeforeContent(repoPath, baseRef, file);
        if (beforeText !== undefined) {
          changes.push(...diffTsJsFile(file, beforeText, undefined));
          continue;
        }
      }
      changes.push(...unknownChangeFallback(file, status));
      continue;
    }

    if (!TS_JS_EXTENSIONS.has(ext) || !parseStructurally) {
      changes.push(...unknownChangeFallback(file, status));
      continue;
    }

    const [beforeText, afterText] = await Promise.all([
      status === 'added' ? Promise.resolve(undefined) : readBeforeContent(repoPath, baseRef, file),
      readAfterContent(repoPath, file),
    ]);

    if (afterText === undefined) {


      changes.push(...unknownChangeFallback(file, status));
      continue;
    }

    try {
      changes.push(...diffTsJsFile(file, beforeText, afterText));
    } catch {



      changes.push(...unknownChangeFallback(file, status));
    }
  }

  return changes;
}
