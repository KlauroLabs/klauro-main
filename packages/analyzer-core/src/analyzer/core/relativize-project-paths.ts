import * as path from 'path';
import type { CASOutput } from '../../types/cas.types';
import { ANALYSIS_YIELD_BUDGET_MS, yieldToEventLoop } from './event-loop-yield';

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

/**
 * Single-value counterpart to `relativizeProjectPaths`, for normalising a
 * `source.file` / `handler.file` at the point it ENTERS a node or entry
 * point, rather than relying solely on the end-of-pipeline sweep above to
 * catch it later. Same prefix-strip rule, so the two can never disagree.
 *
 * Returns `rawFile` unchanged when it is already relative, or when it is
 * absolute but does not resolve under `projectRoot` (a dependency genuinely
 * outside the analysis root) — forcing a relative rewrite there would
 * produce a WRONG path, which is worse than an honest absolute one.
 */
export function toRepoRelativeSourceFile(rawFile: string | undefined, projectRoot: string): string | undefined {
  if (!rawFile) return rawFile;
  const root = path.resolve(projectRoot);
  if (root === path.sep || root.length < 2) return rawFile;
  const prefixes = [`${root}${path.sep}`, `${root.replace(/\\/g, '/')}/`];
  return relativizeString(rawFile, prefixes);
}
