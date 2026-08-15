import * as fs from 'fs-extra';
import * as path from 'path';
import { cachedGlob as glob } from '../../core/glob-cache';



export interface GoRoute {
  method: string;
  path: string;
  handler: string;
  guards: string[];
  file: string;
  line: number;
}


export function lineForIndex(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}



export function describeGoHandler(raw: string): string {
  const trimmed = raw.trim();
  if (/^[A-Za-z_][\w.]*$/.test(trimmed)) return trimmed;
  if (/^func\s*\(/.test(trimmed)) return 'inline handler';
  return trimmed || 'anonymous';
}




export function isGoMiddlewareIdentifier(arg: string): boolean {
  const trimmed = arg.trim();
  if (!trimmed) return false;
  if (/^func\s*\(/.test(trimmed)) return false;
  return /^[A-Za-z_][\w.]*(\s*\([^)]*\))?$/.test(trimmed);
}






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


export function joinGoPaths(a: string, b: string): string {
  const left = (a || '').replace(/\/+$/, '');
  const right = (b || '').replace(/^\/+/, '');
  if (!left) return right ? `/${right}` : '/';
  if (!right) return left;
  return `${left}/${right}`;
}



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
