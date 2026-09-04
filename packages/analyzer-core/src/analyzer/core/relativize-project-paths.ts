import * as path from 'path';
import type { CASOutput } from '../../types/cas.types';
import { ANALYSIS_YIELD_BUDGET_MS, yieldToEventLoop } from './event-loop-yield';

const MAX_PATH_STRING_LENGTH = 1024;








export async function relativizeProjectPaths(output: CASOutput, projectRoot: string): Promise<void> {
  const root = path.resolve(projectRoot);
  if (root === path.sep || root.length < 2) return;

  const prefixes = new Set<string>([`${root}${path.sep}`]);
  prefixes.add(`${root.replace(/\\/g, '/')}/`);

  const rootPath = output.system?.root_path;



  await relativizeValue(output, [...prefixes]);
  if (output.system && rootPath !== undefined) {
    output.system.root_path = rootPath;
  }
}

async function relativizeValue(value: unknown, prefixes: string[]): Promise<void> {
  const pending: unknown[] = [value];
  let lastYieldAt = Date.now();
  let visitedSinceClockCheck = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== 'object') continue;

    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index++) {
        const item = current[index];
        if (typeof item === 'string') current[index] = relativizeString(item, prefixes);
        else if (item && typeof item === 'object') pending.push(item);
      }
    } else {
      const record = current as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        const child = record[key];
        if (typeof child === 'string') record[key] = relativizeString(child, prefixes);
        else if (child && typeof child === 'object') pending.push(child);
      }
    }

    visitedSinceClockCheck++;
    if (visitedSinceClockCheck >= 512) {
      visitedSinceClockCheck = 0;
      const now = Date.now();
      if (now - lastYieldAt >= ANALYSIS_YIELD_BUDGET_MS) {
        await yieldToEventLoop();
        lastYieldAt = Date.now();
      }
    }
  }
}

function relativizeString(value: string, prefixes: string[]): string {
  if (value.length > MAX_PATH_STRING_LENGTH || value.includes('\n')) return value;
  for (const prefix of prefixes) {
    if (value.length > prefix.length && value.startsWith(prefix)) {
      return value.slice(prefix.length);
    }
  }
  return value;
}












export function toRepoRelativeSourceFile(rawFile: string | undefined, projectRoot: string): string | undefined {
  if (!rawFile) return rawFile;
  const root = path.resolve(projectRoot);
  if (root === path.sep || root.length < 2) return rawFile;
  const prefixes = [`${root}${path.sep}`, `${root.replace(/\\/g, '/')}/`];
  return relativizeString(rawFile, prefixes);
}


export function canonicalSourceFileIdentity(rawFile: string | undefined, projectRoot?: string): string {
  if (!rawFile) return '';
  const normalized = rawFile.replace(/\\/g, '/').replace(/^\.\//, '');
  if (projectRoot) return toRepoRelativeSourceFile(normalized, projectRoot) || '';
  const boundaryIndex = normalized.lastIndexOf('/src/');
  if (boundaryIndex !== -1) return normalized.slice(boundaryIndex + 1);
  const sourceIndex = normalized.indexOf('src/');
  return sourceIndex === -1 ? normalized : normalized.slice(sourceIndex);
}
