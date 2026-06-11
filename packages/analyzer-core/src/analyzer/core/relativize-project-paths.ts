import * as path from 'path';
import type { CASOutput } from '../../types/cas.types';

const MAX_PATH_STRING_LENGTH = 1024;

/**
 * Rewrites machine-specific absolute paths inside a CAS output to
 * project-relative paths so stored analyses do not embed the local
 * filesystem layout (user names, client directory names). The single
 * `system.root_path` field is kept absolute on purpose: it is the anchor
 * consumers use to resolve relative paths back to real files.
 */
export function relativizeProjectPaths(output: CASOutput, projectRoot: string): void {
  const root = path.resolve(projectRoot);
  if (root === path.sep || root.length < 2) return;

  const prefixes = new Set<string>([`${root}${path.sep}`]);
  prefixes.add(`${root.replace(/\\/g, '/')}/`);

  const rootPath = output.system?.root_path;
  relativizeValue(output, [...prefixes]);
  if (output.system && rootPath !== undefined) {
    output.system.root_path = rootPath;
  }
}

function relativizeValue(value: unknown, prefixes: string[]): void {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const item = value[index];
      if (typeof item === 'string') {
        value[index] = relativizeString(item, prefixes);
      } else {
        relativizeValue(item, prefixes);
      }
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const child = record[key];
    if (typeof child === 'string') {
      record[key] = relativizeString(child, prefixes);
    } else {
      relativizeValue(child, prefixes);
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
