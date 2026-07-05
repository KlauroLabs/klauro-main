import * as fs from 'fs-extra';
import * as path from 'path';
import { glob } from 'glob';

/** One HTTP route extracted from a Go source file, path already includes any
 *  Group()/Route() prefix accumulated at the call site's lexical nesting depth. */
export interface GoRoute {
  method: string;
  path: string;
  handler: string;
  guards: string[];
  file: string;
  line: number;
}

/** Find every 1-based line number for a byte offset in `content`, memoized per call. */
export function lineForIndex(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

/** Best-effort human-readable handler name: bare identifier / selector as-is;
 *  inline func literal marked as inline (still navigable via file+line). */
export function describeGoHandler(raw: string): string {
  const trimmed = raw.trim();
  if (/^[A-Za-z_][\w.]*$/.test(trimmed)) return trimmed;
  if (/^func\s*\(/.test(trimmed)) return 'inline handler';
  return trimmed || 'anonymous';
}

/** A bare identifier / selector expression (e.g. `AuthMiddleware`,
 *  `middleware.RequireAuth()`) — not an inline func literal. Used to recognize
 *  guard/middleware args passed alongside a handler. */
export function isGoMiddlewareIdentifier(arg: string): boolean {
  const trimmed = arg.trim();
  if (!trimmed) return false;
  if (/^func\s*\(/.test(trimmed)) return false;
  return /^[A-Za-z_][\w.]*(\s*\([^)]*\))?$/.test(trimmed);
}

/**
 * Parse the arguments of a call starting just after the opening '(' (depth 1),
 * splitting on top-level commas while respecting nested parens/brackets/braces
 * and string/backtick literals. Mirrors the JS analyzers' arg parser for Go syntax.
 */
export function parseGoCallArgs(content: string, pos: number): string[] {
  const args: string[] = [];
  let depth = 1;
  let cur = '';
  let inStr: string | null = null;
  for (let i = pos; i < content.length; i++) {
    const ch = content[i];
    if (inStr) {
      cur += ch;
      if (ch === inStr && content[i - 1] !== '\\') inStr = null;
      continue;
    }
    if (ch === '"' || ch === '`' || ch === "'") { inStr = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; cur += ch; continue; }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) { if (cur.trim()) args.push(cur.trim()); break; }
      cur += ch;
      continue;
    }
    if (ch === ',' && depth === 1) { if (cur.trim()) args.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  return args;
}

/** Span `[openIndex, matching-close-index]` for the balanced bracket pair starting
 *  at `openIndex` (which must point at one of '(', '{', '['). */
export function balancedSpan(content: string, openIndex: number): [number, number] | null {
  const open = content[openIndex];
  const close = open === '(' ? ')' : open === '{' ? '}' : open === '[' ? ']' : undefined;
  if (!close) return null;
  let depth = 0;
  let inStr: string | null = null;
  for (let i = openIndex; i < content.length; i++) {
    const ch = content[i];
    if (inStr) {
      if (ch === inStr && content[i - 1] !== '\\') inStr = null;
      continue;
    }
    if (ch === '"' || ch === '`' || ch === "'") { inStr = ch; continue; }
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return [openIndex, i]; }
  }
  return null;
}

/** Join two path segments with exactly one '/' between them, collapsing repeats. */
export function joinGoPaths(a: string, b: string): string {
  const left = (a || '').replace(/\/+$/, '');
  const right = (b || '').replace(/^\/+/, '');
  if (!left) return right ? `/${right}` : '/';
  if (!right) return left;
  return `${left}/${right}`;
}

/** Find all `.go` files in a project (excluding vendor/tests), returning
 *  project-relative paths. */
export async function findGoFiles(projectPath: string, extraIgnore: string[] = []): Promise<string[]> {
  return glob(['**/*.go'], {
    cwd: projectPath,
    ignore: [
      '**/vendor/**',
      '**/node_modules/**',
      '**/.git/**',
      '**/*_test.go',
      ...extraIgnore
    ],
    nodir: true
  });
}

export async function readGoFiles(projectPath: string, files: string[]): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  for (const file of files) {
    contents.set(file, await fs.readFile(path.join(projectPath, file), 'utf-8'));
  }
  return contents;
}

/** True if go.mod (or any vendored copy) requires `modulePath`. */
export async function goModRequires(projectPath: string, modulePath: string): Promise<boolean> {
  const goModPath = path.join(projectPath, 'go.mod');
  if (!(await fs.pathExists(goModPath))) return false;
  try {
    const content = await fs.readFile(goModPath, 'utf-8');
    return content.includes(modulePath);
  } catch {
    return false;
  }
}
