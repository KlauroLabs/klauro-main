import * as fs from 'node:fs';
import * as path from 'node:path';
import { searchCompactCAS } from '../../../packages/analyzer-core/src/analyzer/core/compact-cas-search';
import { loadCompactCASSearch } from './segmented-analysis-storage';
import type { HostedProjectQueryWorkerRequest } from './hosted-project-query-process';
import { HOSTED_SEARCH_NODES_SCHEMA } from './hosted-project-query-schema';
import { boundToolPayload } from './response-budget';

interface AnalysisIndexEntry { file: string }
interface AnalysisIndex { analyses?: Record<string, AnalysisIndexEntry> }

function storagePath(): string {
  return process.env.KLAURO_STORAGE_PATH
    || path.join(process.env.HOME || process.env.USERPROFILE || '~', '.klauro', 'analyses');
}

async function analysisFile(workspace: string): Promise<string | null> {
  const root = storagePath();
  const index = JSON.parse(await fs.promises.readFile(path.join(root, 'index.json'), 'utf8')) as AnalysisIndex;
  const entry = index.analyses?.[workspace];
  return entry?.file ? path.join(root, entry.file) : null;
}

if (!process.send) {
  process.stderr.write('hosted-project-search-worker must be started through child_process.fork.\n');
  process.exit(1);
}

let cachedFile = '';
let cachedFingerprint = '';
let cachedSearch: Awaited<ReturnType<typeof loadCompactCASSearch>>;
let work = Promise.resolve();

function debugMemory(phase: string): void {
  if (process.env.KLAURO_DEBUG_QUERY_MEMORY !== '1') return;
  const memory = process.memoryUsage();
  process.stderr.write(`${JSON.stringify({
    event: 'hosted_compact_search_memory',
    phase,
    rss_mb: Math.round(memory.rss / 1024 / 1024),
    heap_mb: Math.round(memory.heapUsed / 1024 / 1024),
    external_mb: Math.round(memory.external / 1024 / 1024),
  })}\n`);
}

process.send!({ type: 'ready' });
process.on('message', (request: HostedProjectQueryWorkerRequest) => {
  if (!request || request.type !== 'query' || request.tool !== 'search_nodes') return;
  work = work.then(async () => {
    try {
      const file = await analysisFile(request.workspace);
      if (!file) throw new Error(`No analysis found for: ${request.workspace}. Run analyze_codebase first.`);
      const stat = await fs.promises.stat(file);
      const fingerprint = `${stat.mtimeMs}:${stat.size}`;
      if (!cachedSearch || cachedFile !== file || cachedFingerprint !== fingerprint) {
        cachedSearch = await loadCompactCASSearch(file);
        cachedFile = file;
        cachedFingerprint = fingerprint;
        debugMemory('loaded');
      }
      if (!cachedSearch) {
        process.send!({ type: 'fallback', id: request.id });
        return;
      }
      const args = HOSTED_SEARCH_NODES_SCHEMA.parse(request.args ?? {});
      const result = boundToolPayload(await searchCompactCAS(
        cachedSearch.graph,
        cachedSearch.index,
        args.query,
        cachedSearch.readPostings,
        cachedSearch.readSearchText,
        { type: args.type, file: args.file, limit: args.limit },
      ), { tool: 'search_nodes', parameterNames: Object.keys(args) });
      debugMemory('result');
      process.send!({ type: 'result', id: request.id, analysisTimestamp: cachedSearch.analysisTimestamp, result });
    } catch (error) {
      process.send!({ type: 'error', id: request.id, error: error instanceof Error ? error.message : String(error) });
    }
  });
});
