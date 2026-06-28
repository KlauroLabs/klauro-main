/**
 * Real, installed competitor arms — Camp B (structural) run at full strength.
 *
 * These are not proxies. `scip-typescript` is Sourcegraph's compiler-accurate
 * SCIP indexer (the same engine behind Sourcegraph code intelligence); `ctags`
 * is Universal Ctags. We run them exactly as a Camp-B user would and read their
 * real output, so any Klauro win is honest.
 *
 * What the head-to-head reveals:
 *   - On TS/JS who-calls, scip is compiler-accurate and will TIE Klauro on
 *     quality (you cannot out-correct ground truth). Klauro's edge there is
 *     tokens (the exact caller set vs an index/files to read) and breadth.
 *   - scip-typescript indexes ONLY TS/JS. On Go, Java, Kotlin, Swift, C/C++,
 *     Python — every other language Klauro resolves — scip returns nothing.
 *     That is the decisive, not-even-close gap, and it is a fact of the tool,
 *     not a handicap we imposed.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';

/** Locate the scip CLI (Sourcegraph), preferring the user's Go bin. Null if absent. */
export function scipCliPath(): string | null {
  const candidates = [path.join(os.homedir(), 'go', 'bin', 'scip'), 'scip'];
  for (const c of candidates) {
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore' });
      return c;
    } catch {
      /* keep trying */
    }
  }
  return null;
}

export function scipTypescriptAvailable(): boolean {
  try {
    execFileSync('scip-typescript', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Does this SCIP symbol name `Class#method`? scip-typescript encodes a method
 *  as `... ClassName#methodName().`, so matching on `Class#method` excludes the
 *  same-name decoy on another class — the compiler-accurate precision we expect. */
function symbolNamesMethod(symbol: string, className: string, methodName: string): boolean {
  if (!symbol) return false;
  // Tolerate generics / overload suffixes; require the exact Class#method boundary.
  const re = new RegExp(`[#.\\/]${className}#${methodName}\\b`);
  if (re.test(symbol)) return true;
  // Some emits use `ClassName#methodName().` without a leading separator.
  return symbol.includes(`${className}#${methodName}`);
}

export interface ScipCallersResult {
  files: string[];
  ms: number;
  indexBytes: number;
  available: true;
}

/**
 * Compiler-accurate Camp B who-calls: index with scip-typescript, then read the
 * SCIP occurrences. A non-definition (reference) occurrence of the target
 * `Class#method` symbol is a call site; its file is a caller file. Returns null
 * when the tool isn't installed or the project isn't TS/JS (scip's real limit).
 */
export function scipCallers(
  dir: string,
  className: string,
  methodName: string,
): ScipCallersResult | null {
  const scip = scipCliPath();
  if (!scip || !scipTypescriptAvailable()) return null;

  const t0 = Date.now();
  const indexPath = path.join(dir, 'index.scip');
  try {
    // Real indexing. --infer-tsconfig lets it handle a bare fixture dir.
    execFileSync('scip-typescript', ['index', '--infer-tsconfig', '--output', indexPath], {
      cwd: dir,
      stdio: 'ignore',
      timeout: 180_000,
    });
  } catch {
    try { fs.removeSync(indexPath); } catch { /* noop */ }
    return null; // not a TS/JS project, or no sources scip could index
  }

  let indexBytes = 0;
  try { indexBytes = fs.statSync(indexPath).size; } catch { /* noop */ }

  let json = '';
  try {
    json = execFileSync(scip, ['print', '--json', indexPath], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    try { fs.removeSync(indexPath); } catch { /* noop */ }
    return null;
  }
  try { fs.removeSync(indexPath); } catch { /* noop */ }

  const files = new Set<string>();
  try {
    const doc = JSON.parse(json);
    for (const d of doc.documents || []) {
      const rel: string = d.relative_path || d.relativePath || '';
      for (const occ of d.occurrences || []) {
        const sym: string = occ.symbol || '';
        const roles: number = occ.symbol_roles ?? occ.symbolRoles ?? 0;
        const isDefinition = (roles & 1) === 1; // SymbolRole.Definition == 1
        if (!isDefinition && symbolNamesMethod(sym, className, methodName)) {
          files.add(path.basename(rel));
        }
      }
    }
  } catch {
    return null;
  }

  return { files: [...files], ms: Date.now() - t0, indexBytes, available: true };
}

/** GitHub stack-graphs (TS): syntactic name-resolution nav. Null if absent. */
export function stackGraphsTsPath(): string | null {
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'tree-sitter-stack-graphs-typescript'),
    'tree-sitter-stack-graphs-typescript',
  ];
  for (const c of candidates) {
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore' });
      return c;
    } catch {
      /* keep trying */
    }
  }
  return null;
}

/** Parse `has definition\n  <file>:<line>:<col>` from a stack-graphs query result. */
function parseStackGraphDef(out: string): { file: string; line: number } | null {
  const m = out.match(/has definition\s*\n\s*([^\s:]+\.[A-Za-z0-9]+):(\d+):(\d+)/);
  if (!m) return null;
  return { file: m[1], line: parseInt(m[2], 10) };
}

/** Does a resolved definition belong to `className`.`methodName`? Scan upward from
 *  the def line for the nearest enclosing `class <Name>`. */
function defBelongsToClass(
  defFile: string,
  defLine: number,
  className: string,
  methodName: string,
): boolean {
  let lines: string[];
  try {
    lines = fs.readFileSync(defFile, 'utf8').split('\n');
  } catch {
    return false;
  }
  const defText = lines[defLine - 1] || '';
  if (!new RegExp(`\\b${methodName}\\b`).test(defText)) return false;
  for (let i = defLine - 1; i >= 0; i--) {
    const cm = lines[i].match(/\bclass\s+([A-Za-z_]\w*)/);
    if (cm) return cm[1] === className;
  }
  return false;
}

/**
 * stack-graphs who-calls: enumerate every `.method(` call site, resolve each to
 * its definition with the real stack-graphs query engine, and keep the sites
 * whose definition is `className`.`methodName`. Name-resolution is syntactic, so
 * on simple typed receivers it matches a compiler (a ceiling tie); it is TS/JS
 * only, so it cannot run on other languages. Returns null if the tool is absent
 * or there are no TS/JS sources.
 */
export function stackGraphsCallers(
  dir: string,
  className: string,
  methodName: string,
): { files: string[]; ms: number } | null {
  const sg = stackGraphsTsPath();
  if (!sg) return null;

  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter(f => /\.(ts|tsx|js|jsx)$/.test(f));
  } catch {
    return null;
  }
  if (entries.length === 0) return null;

  const t0 = Date.now();
  const dbPath = path.join(os.tmpdir(), `klauro-sg-${process.pid}-${path.basename(dir)}.sqlite`);
  try {
    execFileSync(sg, ['index', '--force', '-D', dbPath, ...entries], {
      cwd: dir,
      stdio: 'ignore',
      timeout: 120_000,
    });
  } catch {
    try { fs.removeSync(dbPath); } catch { /* noop */ }
    return null;
  }

  // Enumerate call sites: `<recv>.<method>(` — record the method-name position.
  const callRe = new RegExp(`\\.\\s*${methodName}\\s*\\(`, 'g');
  const sites: Array<{ file: string; line: number; col: number }> = [];
  for (const file of entries) {
    let lines: string[];
    try {
      lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n');
    } catch {
      continue;
    }
    lines.forEach((ln, i) => {
      callRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = callRe.exec(ln))) {
        const nameIdx = ln.indexOf(methodName, m.index);
        if (nameIdx >= 0) sites.push({ file, line: i + 1, col: nameIdx + 1 });
      }
    });
  }

  const callerFiles = new Set<string>();
  for (const s of sites) {
    let out = '';
    try {
      out = execFileSync(sg, ['query', '-D', dbPath, 'definition', `${s.file}:${s.line}:${s.col}`], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 30_000,
      });
    } catch {
      continue;
    }
    const def = parseStackGraphDef(out);
    if (def && defBelongsToClass(def.file, def.line, className, methodName)) {
      callerFiles.add(path.basename(s.file));
    }
  }

  try { fs.removeSync(dbPath); } catch { /* noop */ }
  return { files: [...callerFiles], ms: Date.now() - t0 };
}

/** DeusData codebase-memory-mcp — the serious Camp-B+ contender (tree-sitter +
 *  Hybrid LSP knowledge graph). Null if the binary isn't installed. */
export function codebaseMemoryPath(): string | null {
  const candidates = [path.join(os.homedir(), '.local', 'bin', 'codebase-memory-mcp'), 'codebase-memory-mcp'];
  for (const c of candidates) {
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore' });
      return c;
    } catch {
      /* keep trying */
    }
  }
  return null;
}

/**
 * codebase-memory who-calls: index the repo, then read get_architecture. Its
 * `boundaries` are package-level caller→callee edges; the callers of
 * `className` are the `from` packages of boundaries whose `to` is the class.
 * Map each caller package back to its source file. LSP-backed, so on TS this is
 * compiler-accurate — a ceiling tie with Klauro. Returns null if absent.
 */
export function codebaseMemoryCallers(
  dir: string,
  className: string,
): { files: string[]; ms: number } | null {
  const bin = codebaseMemoryPath();
  if (!bin) return null;
  const t0 = Date.now();
  try {
    execFileSync(bin, ['cli', 'index_repository', JSON.stringify({ repo_path: dir })], {
      stdio: 'ignore',
      timeout: 120_000,
    });
  } catch {
    return null;
  }
  // The project id is the slugified absolute path. codebase-memory PRESERVES
  // underscores (slug charset [A-Za-z0-9_]); macOS temp dirs live under
  // /var/folders/<x>_/..., so we must keep '_' or the project lookup misses and
  // the competitor is silently under-read.
  const project = dir.replace(/^\/+/, '').replace(/[^A-Za-z0-9_]+/g, '-');
  let out = '';
  try {
    out = execFileSync(bin, ['cli', 'get_architecture', JSON.stringify({ project })], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
  const jsonLine = out.split('\n').find(l => l.trim().startsWith('{')) || '{}';
  let arch: any;
  try {
    arch = JSON.parse(jsonLine);
  } catch {
    return null;
  }
  const callerPkgs: string[] = (arch.boundaries || [])
    .filter((b: any) => b.to === className)
    .map((b: any) => String(b.from));

  // Resolve each caller package to its source file in the repo.
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    /* noop */
  }
  const files = new Set<string>();
  for (const pkg of callerPkgs) {
    const match = entries.find(f => f.replace(/\.[A-Za-z0-9]+$/, '') === pkg);
    if (match) files.add(match);
  }
  return { files: [...files], ms: Date.now() - t0 };
}

/**
 * codebase-memory LIVE out-category arm. Indexes the fixture, then queries its
 * own knowledge graph for nodes of `label` via search_graph. This is the FAIR
 * head-to-head for Camp-C facts: codebase-memory advertises first-class `Route`
 * nodes, so we let it answer with its strongest tool. In practice its tree-sitter
 * indexer does not recognize framework route declarations (`app.get(...)`,
 * `@GetMapping`, `path(...)`), so it returns the names it DID find for that label
 * (often []), which the bench scores against the true facts. Null if not installed.
 */
export function codebaseMemoryNodesByLabel(
  dir: string,
  label: string,
): { names: string[]; ms: number } | null {
  const bin = codebaseMemoryPath();
  if (!bin) return null;
  const t0 = Date.now();
  try {
    execFileSync(bin, ['cli', 'index_repository', JSON.stringify({ repo_path: dir })], {
      stdio: 'ignore',
      timeout: 120_000,
    });
  } catch {
    return null;
  }
  const project = dir.replace(/^\/+/, '').replace(/[^A-Za-z0-9_]+/g, '-');
  let out = '';
  try {
    out = execFileSync(bin, ['cli', 'search_graph', JSON.stringify({ project, label })], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
  const jsonLine = out.split('\n').find(l => l.trim().startsWith('{')) || '{}';
  let parsed: any;
  try {
    parsed = JSON.parse(jsonLine);
  } catch {
    return null;
  }
  const names: string[] = (parsed.results || []).map((r: any) => String(r.name));
  return { names, ms: Date.now() - t0 };
}

/**
 * codebase-memory edge-type inventory from get_architecture, run live. Used to
 * prove an out-category ABSENCE at full strength: its graph carries raw
 * structural edges (DEFINES/IMPORTS/USAGE/CALLS/DECORATES) but no ORM-cardinality
 * edge (OneToMany/ManyToOne) and no `renders` edge — so the directional ORM
 * relation and the component render tree are facts only Klauro produces, even
 * though codebase-memory indexed the very same code. Null if not installed.
 */
export function codebaseMemoryEdgeTypes(dir: string): { types: string[]; ms: number } | null {
  const bin = codebaseMemoryPath();
  if (!bin) return null;
  const t0 = Date.now();
  try {
    execFileSync(bin, ['cli', 'index_repository', JSON.stringify({ repo_path: dir })], {
      stdio: 'ignore',
      timeout: 120_000,
    });
  } catch {
    return null;
  }
  const project = dir.replace(/^\/+/, '').replace(/[^A-Za-z0-9_]+/g, '-');
  let out = '';
  try {
    out = execFileSync(bin, ['cli', 'get_architecture', JSON.stringify({ project })], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
  const jsonLine = out.split('\n').find(l => l.trim().startsWith('{')) || '{}';
  let arch: any;
  try {
    arch = JSON.parse(jsonLine);
  } catch {
    return null;
  }
  const types: string[] = (arch.edge_types || []).map((e: any) => String(e.type));
  return { types, ms: Date.now() - t0 };
}

export function ctagsAvailable(): boolean {
  try {
    execFileSync('ctags', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * ctags Camp B baseline. Universal Ctags is a DEFINITION indexer — it locates
 * where symbols are declared, not who calls them. The faithful "who-calls" a
 * ctags user can do is: find files that reference the method name (extras=+r).
 * It is name-based, so it cannot exclude a same-name decoy on another class —
 * exactly the precision wall Klauro's type resolution clears. Returns null if
 * ctags is absent.
 */
export function ctagsCallers(dir: string, methodName: string): { files: string[]; ms: number } | null {
  if (!ctagsAvailable()) return null;
  const t0 = Date.now();
  let out = '';
  try {
    // Reference tags (+r) emit one tag per use-site; field output is tab-separated:
    //   name<TAB>file<TAB>...
    out = execFileSync(
      'ctags',
      ['-R', '--extras=+r', '--fields=+r', '-f', '-', dir],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
  } catch {
    return { files: [], ms: Date.now() - t0 };
  }
  const files = new Set<string>();
  for (const line of out.split('\n')) {
    if (!line || line.startsWith('!')) continue;
    const [name, file] = line.split('\t');
    if (name === methodName && file && file !== 'truth.json') {
      files.add(path.basename(file));
    }
  }
  return { files: [...files], ms: Date.now() - t0 };
}
