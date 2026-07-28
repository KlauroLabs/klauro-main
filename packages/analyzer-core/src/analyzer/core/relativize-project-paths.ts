import * as path from 'path';
import type { CASOutput } from '../../types/cas.types';
import { createYieldBudget } from './event-loop-yield';

const MAX_PATH_STRING_LENGTH = 1024;

/**
 * Rewrites machine-specific absolute paths inside a CAS output to
 * project-relative paths so stored analyses do not embed the local
 * filesystem layout (user names, client directory names). The single
 * `system.root_path` field is kept absolute on purpose: it is the anchor
 * consumers use to resolve relative paths back to real files.
 */
export async function relativizeProjectPaths(output: CASOutput, projectRoot: string): Promise<void> {
  const root = path.resolve(projectRoot);
  if (root === path.sep || root.length < 2) return;

  const prefixes = new Set<string>([`${root}${path.sep}`]);
  prefixes.add(`${root.replace(/\\/g, '/')}/`);

  const rootPath = output.system?.root_path;
  // Budget-yield during the walk: rewriting a whale CAS (76k nodes, ~250MB
  // object graph) synchronously was a measured ~2s event-loop stall in the
  // in-process analyzer+HTTP server. Traversal order and results unchanged.
  await relativizeValue(output, [...prefixes], createYieldBudget());
  if (output.system && rootPath !== undefined) {
    output.system.root_path = rootPath;
  }
}

async function relativizeValue(value: unknown, prefixes: string[], maybeYield: () => Promise<void>): Promise<void> {
  if (Array.isArray(value)) {
    await maybeYield();
    for (let index = 0; index < value.length; index++) {
      const item = value[index];
      if (typeof item === 'string') {
        value[index] = relativizeString(item, prefixes);
      } else {
        await relativizeValue(item, prefixes, maybeYield);
      }
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  await maybeYield();
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const child = record[key];
    if (typeof child === 'string') {
      record[key] = relativizeString(child, prefixes);
    } else {
      await relativizeValue(child, prefixes, maybeYield);
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
