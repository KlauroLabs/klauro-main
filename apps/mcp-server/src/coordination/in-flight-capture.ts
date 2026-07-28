/**
 * Ambient in-flight capture (Fabric-v2 #2, docs/SPEC-COORDINATION-FABRIC-V2.md
 * §1.7): the fabric CAPTURES what an agent is actually changing from the git
 * working-tree diff, instead of requiring the agent to hand-report a
 * `SymbolChange[]` to `check_conceptual_conflicts`.
 *
 * ALGORITHM (same-machine local capture — git + a lightweight TS/JS symbol
 * extractor over the working tree):
 *   1. `git diff --name-only <baseRef>` in `repoPath` to find changed files,
 *      filtered to extensions we can meaningfully analyze.
 *   2. For each changed file, get the BEFORE content via
 *      `git show <baseRef>:<file>` and the AFTER content from the working
 *      tree (the file may be new — no BEFORE — or deleted — no AFTER).
 *   3. Extract per-symbol signatures from both versions and diff them,
 *      emitting a `SymbolChange` (the exact type `conceptual-conflict.ts`
 *      already exports and consumes — imported, not redefined) per symbol
 *      that changed shape (signature/return-type/nullability/params),
 *      structure (rename/split/move/delete), or was added.
 *
 * HONESTY / SCOPE: full whole-project re-analysis of both git revisions would
 * be heavy and is not attempted here. This module only reads and parses the
 * CHANGED files themselves (incremental by construction — never touches
 * unchanged files), and only for languages where a signature can be extracted
 * cheaply and reliably:
 *   - TypeScript / JavaScript (.ts/.tsx/.js/.jsx/.mjs/.cjs): full symbol-level
 *     before/after diffing via the TypeScript compiler API (`ts.createSourceFile`,
 *     no type-checker/program needed — this is syntactic signature extraction,
 *     not full type inference), covering functions, methods, and arrow-function
 *     class properties/const bindings. Return-type annotations, parameter
 *     lists/optionality, and easily-observed nullability (`| null` / `| undefined`
 *     in the return type) are compared before vs after.
 *   - Every other language (and deletes): a graceful "unknown-change" fallback
 *     — the file is reported as changed with `change_kind: 'body'` and no
 *     before/after shape, so callers know something moved without this module
 *     fabricating a signature diff it cannot actually verify. This is a real,
 *     bounded win (TS/JS ambient contract detection) plus honest degradation
 *     everywhere else, not a fake full-language solution.
 *
 * Pure-ish: the only IO is `git` subprocess calls and reading the working-tree
 * files already on disk; no network, no coordination-store writes (that is
 * `in-flight-sync.ts` / server.ts's job — this module only produces the
 * `SymbolChange[]` for a caller to attach to an `InFlightSnapshot` or feed
 * directly to `detectConceptualConflicts`).
 */

import { execFile } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as ts from 'typescript';

import type { SymbolChange, SymbolChangeKind, SymbolChangeShape } from './conceptual-conflict';

export interface CaptureOpts {
  /** Absolute path to the git repository working tree. */
  repoPath: string;
  /** Git ref to diff against (the "before" state). Defaults to 'HEAD'. */
  baseRef?: string;
  /**
   * Stop after this many ANALYZABLE changed files. Absent = unbounded (the
   * historical behavior every existing caller keeps). Callers on a latency
   * budget — e.g. the wave-2 ambient contract sweep, which runs inside a
   * fab_* tool response — pass a bound so a pathologically dirty tree
   * (hundreds of uncommitted files, each TS-parsed) cannot turn an advisory
   * observation into a slow call. Truncation is honest: the capture returns
   * fewer changes, never fabricated ones.
   */
  maxFiles?: number;
}

// "Analyzable" here means "worth reporting a change for at all" — broader than
// the set we can syntactically signature-diff (TS_JS_EXTENSIONS below). Source
// files in other mainstream languages still surface as an honest unknown-change
// fallback (see unknownChangeFallback); this list exists to filter out clearly
// non-source noise (lockfiles, images, etc.) rather than to gate signature
// extraction, which TS_JS_EXTENSIONS alone controls.
const ANALYZABLE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.cs', '.cpp', '.cc', '.c', '.h', '.hpp',
  '.php', '.scala', '.ex', '.exs', '.dart', '.vue', '.svelte',
]);

const TS_JS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

function runGit(repoPath: string, args: string[]): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    execFile('git', ['-C', repoPath, ...args], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      // Non-zero exit (e.g. `show` on a path that doesn't exist at baseRef —
      // a newly-added file) is expected and handled by callers; never reject.
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
      file = parts[2] || parts[1]; // renamed: old\tnew
    }
    if (file) files.push({ file, status });
  }
  return files;
}

async function readBeforeContent(repoPath: string, baseRef: string, file: string): Promise<string | undefined> {
  const { stdout, code } = await runGit(repoPath, ['show', `${baseRef}:${file}`]);
  if (code !== 0) return undefined; // file didn't exist at baseRef (new file)
  return stdout;
}

async function readAfterContent(repoPath: string, file: string): Promise<string | undefined> {
  try {
    return await fsp.readFile(path.join(repoPath, file), 'utf8');
  } catch {
    return undefined; // deleted in the working tree
  }
}

// ---------------------------------------------------------------------------
// TS/JS lightweight symbol-signature extraction (syntactic — no Program/checker)
// ---------------------------------------------------------------------------

interface ExtractedSymbol {
  name: string;
  /** Best-effort stable key: `<kind>:<name>` — good enough to match the same
   *  symbol across before/after since we operate on a single file's AST. */
  key: string;
  signature: string;
  return_type?: string;
  nullable?: boolean;
  params: string[];
  kind: 'function' | 'method' | 'arrow';
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

/** Nullability heuristic: does the return-type text mention `null`/`undefined`
 *  as a top-level union member? Purely textual — good enough for the common
 *  `T | null` / `T | undefined` shape this detector cares about; not full
 *  type-inference nullability (out of scope for syntactic extraction). */
function looksNullable(returnType: string | undefined): boolean | undefined {
  if (returnType === undefined) return undefined;
  return /\bnull\b/.test(returnType) || /\bundefined\b/.test(returnType);
}

function paramListToStrings(params: ts.NodeArray<ts.ParameterDeclaration>, sourceText: string): string[] {
  return params.map((p) => sourceText.slice(p.pos, p.end).trim());
}

/**
 * Walk a source file and collect top-level and class-member function-shaped
 * symbols: function declarations, class methods, and arrow-function /
 * function-expression const bindings (`const foo = (x: number) => ...`).
 * Deliberately shallow (no nested-closure symbols) — this is a signature
 * extractor for the "does this symbol's public shape change" question, not a
 * full CAS builder.
 */
function extractSymbols(sourceText: string, file: string): ExtractedSymbol[] {
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, scriptKindFor(file));
  const out: ExtractedSymbol[] = [];

  function addFunctionLike(
    name: string,
    kind: ExtractedSymbol['kind'],
    params: ts.NodeArray<ts.ParameterDeclaration>,
    returnTypeNode: ts.TypeNode | undefined,
    fullSignatureText: string
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
    });
  }

  function visit(node: ts.Node, className?: string) {
    if (ts.isFunctionDeclaration(node) && node.name) {
      const sigEnd = node.body ? node.body.pos : node.end;
      addFunctionLike(node.name.text, 'function', node.parameters, node.type, sourceText.slice(node.pos, sigEnd));
    } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      const sigEnd = node.body ? node.body.pos : node.end;
      const name = className ? `${className}.${node.name.text}` : node.name.text;
      addFunctionLike(name, 'method', node.parameters, node.type, sourceText.slice(node.pos, sigEnd));
    } else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
          const fn = decl.initializer;
          const sigEnd = fn.body ? fn.body.pos : fn.end;
          addFunctionLike(decl.name.text, 'arrow', fn.parameters, fn.type, sourceText.slice(node.pos, sigEnd));
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
  return { kind: 'body', changed: false };
}

/** Diff two versions of one TS/JS file's extracted symbols into `SymbolChange[]`. */
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
      // New symbol — 'add'. (Could also be a rename of a deleted symbol;
      // structural rename detection across a single file's symbol set is a
      // reasonable follow-on but out of scope for this first pass — see
      // detectStructuralDivergence in conceptual-conflict.ts, which this
      // module's output is compatible with once a caller wires rename
      // detection in.)
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

/** Fallback for changed files in languages we don't syntactically diff: report
 *  the file changed without fabricating a signature diff. */
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

/**
 * Capture what `repoPath`'s working tree actually changed relative to
 * `baseRef` (default `HEAD`) as `SymbolChange[]` — the same type
 * `detectConceptualConflicts` (conceptual-conflict.ts) consumes — with ZERO
 * agent self-reporting. TS/JS files get full syntactic before/after signature
 * diffing; every other analyzable-but-unsupported file, and deletes in any
 * language, degrade to an honest "unknown-change" (`body`/`delete`, no
 * before/after) rather than a fabricated diff.
 */
export async function captureInFlightChanges(opts: CaptureOpts): Promise<SymbolChange[]> {
  const repoPath = opts.repoPath;
  const baseRef = opts.baseRef ?? 'HEAD';

  const changedFiles = await listChangedFiles(repoPath, baseRef);
  const changes: SymbolChange[] = [];
  let analyzed = 0;

  for (const { file, status } of changedFiles) {
    if (opts.maxFiles !== undefined && analyzed >= opts.maxFiles) break;
    const ext = path.extname(file);
    if (!ANALYZABLE_EXTENSIONS.has(ext)) {
      // Non-source or genuinely unrecognized extension: skip silently (matches
      // "filter to analyzable extensions" in the algorithm spec) rather than
      // emitting noise for lockfiles, markdown, JSON config, etc.
      continue;
    }
    analyzed++;

    if (status === 'deleted') {
      if (TS_JS_EXTENSIONS.has(ext)) {
        const beforeText = await readBeforeContent(repoPath, baseRef, file);
        if (beforeText !== undefined) {
          changes.push(...diffTsJsFile(file, beforeText, undefined));
          continue;
        }
      }
      changes.push(...unknownChangeFallback(file, status));
      continue;
    }

    if (!TS_JS_EXTENSIONS.has(ext)) {
      changes.push(...unknownChangeFallback(file, status));
      continue;
    }

    const [beforeText, afterText] = await Promise.all([
      status === 'added' ? Promise.resolve(undefined) : readBeforeContent(repoPath, baseRef, file),
      readAfterContent(repoPath, file),
    ]);

    if (afterText === undefined) {
      // Working-tree read failed unexpectedly (race/permissions) — degrade
      // gracefully instead of throwing.
      changes.push(...unknownChangeFallback(file, status));
      continue;
    }

    try {
      changes.push(...diffTsJsFile(file, beforeText, afterText));
    } catch {
      // Parse failure (e.g. transient syntax error mid-edit) — never let a
      // single file's parse error break the whole capture; degrade to
      // unknown-change for that file only.
      changes.push(...unknownChangeFallback(file, status));
    }
  }

  return changes;
}
