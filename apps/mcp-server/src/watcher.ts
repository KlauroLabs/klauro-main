import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { runAnalysis } from './analyzer';
import type { ChangeReport } from '../../../packages/analyzer-core/src/types/cas.types';

interface WatchSession {
  id: string;
  projectPath: string;
  watcher: fs.FSWatcher | null;
  status: 'active' | 'paused' | 'stopped' | 'error';
  startedAt: string;
  lastAnalysis: string | null;
  pendingChanges: Map<string, { path: string; type: 'add' | 'change' | 'unlink'; timestamp: number }>;
  recentImpactPreviews: ImpactPreview[];
  recentChanges: ChangeReport[];
  analysisInProgress: boolean;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  impactTimer: ReturnType<typeof setTimeout> | null;
  error: string | null;
  stats: {
    totalChangesDetected: number;
    totalAnalysesRun: number;
    averageAnalysisTimeMs: number;
  };
}

interface ImpactPreview {
  timestamp: string;
  filesChanged: number;
  files: string[];
  changeTypes: Array<'add' | 'change' | 'unlink'>;
  scope: 'source' | 'test' | 'config' | 'infrastructure' | 'mixed';
  likelyFullRebuild: boolean;
  guidance: string;
}

const DEFAULT_DEBOUNCE_MS = 5_000;
const DEFAULT_IMPACT_DEBOUNCE_MS = 250;
const MAX_RECENT_CHANGES = 10;
const MAX_RECENT_IMPACT_PREVIEWS = 20;

const sessions = new Map<string, WatchSession>();
const emitter = new EventEmitter();

function generateWatchId(): string {
  return `watch_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

function getIgnorePatterns(): RegExp[] {
  return [
    /node_modules/,
    /\.git/,
    /dist\//,
    /build\//,
    /coverage\//,
    /\.nyc_output/,
    /\.next/,
    /\.nuxt/,
    /\.cache/,
    /\.turbo/,
    /\.swp$/,
    /\.swo$/,
    /~$/,
    /\.DS_Store/,
    /Thumbs\.db/,
  ];
}

function shouldIgnore(filePath: string): boolean {
  const patterns = getIgnorePatterns();
  return patterns.some(p => p.test(filePath));
}

function getDebounceMs(): number {
  const parsed = Number.parseInt(process.env.KLAURO_WATCH_DEBOUNCE_MS || '', 10);
  if (!Number.isFinite(parsed)) return DEFAULT_DEBOUNCE_MS;
  return Math.max(2_000, Math.min(parsed, 120_000));
}

function getImpactDebounceMs(): number {
  const parsed = Number.parseInt(process.env.KLAURO_WATCH_IMPACT_DEBOUNCE_MS || '', 10);
  if (!Number.isFinite(parsed)) return DEFAULT_IMPACT_DEBOUNCE_MS;
  return Math.max(50, Math.min(parsed, 5_000));
}

function isSourceFile(filePath: string): boolean {
  const sourceExtensions = [
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.py', '.pyw',
    '.java',
    '.cs',
    '.go',
    '.rs',
    '.php',
    '.vue', '.svelte',
    '.json', '.yaml', '.yml',
  ];
  const ext = path.extname(filePath).toLowerCase();
  return sourceExtensions.includes(ext);
}

async function runIncrementalAnalysis(session: WatchSession): Promise<void> {
  if (session.analysisInProgress) return;
  if (session.pendingChanges.size === 0) return;

  session.analysisInProgress = true;
  const changesSnapshot = Array.from(session.pendingChanges.values());
  session.pendingChanges.clear();

  const startTime = Date.now();

  try {
    const result = await runAnalysis(session.projectPath);
    if (!result.changeReport) {
      throw new Error('Incremental analysis returned no change report');
    }
    const duration = Date.now() - startTime;

    session.lastAnalysis = new Date().toISOString();
    session.stats.totalAnalysesRun++;
    session.stats.averageAnalysisTimeMs = Math.round(
      ((session.stats.averageAnalysisTimeMs * (session.stats.totalAnalysesRun - 1)) + duration) /
      session.stats.totalAnalysesRun
    );

    session.recentChanges.unshift(result.changeReport);
    if (session.recentChanges.length > MAX_RECENT_CHANGES) {
      session.recentChanges.pop();
    }

    emitter.emit('analysis-complete', {
      watchId: session.id,
      projectPath: session.projectPath,
      files: changesSnapshot.map(change => change.path),
      changeReport: result.changeReport,
      duration,
      wasFullRebuild: result.wasFullRebuild,
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    session.error = errorMessage;
    emitter.emit('analysis-error', {
      watchId: session.id,
      projectPath: session.projectPath,
      error: errorMessage,
    });
  } finally {
    session.analysisInProgress = false;

    if (session.pendingChanges.size > 0) {
      scheduleAnalysis(session);
    }
  }
}

function scheduleAnalysis(session: WatchSession): void {
  if (session.debounceTimer) {
    clearTimeout(session.debounceTimer);
  }
  session.debounceTimer = setTimeout(() => {
    session.debounceTimer = null;
    runIncrementalAnalysis(session);
  }, getDebounceMs());
}

function classifyScope(files: string[]): ImpactPreview['scope'] {
  const scopes = new Set<ImpactPreview['scope']>();
  for (const file of files) {
    const normalized = file.replace(/\\/g, '/');
    if (/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|package\.json|tsconfig\.json|vite\.config\.|next\.config\.|nest-cli\.json|pyproject\.toml|Cargo\.toml|go\.mod|composer\.json)$/i.test(normalized)) {
      scopes.add('config');
    } else if (/(^|\/)(Dockerfile|docker-compose\.ya?ml|compose\.ya?ml|k8s\/|kubernetes\/|helm\/|terraform\/|infra\/)|\.(tf|hcl)$/i.test(normalized)) {
      scopes.add('infrastructure');
    } else if (/(^|\/)(test|tests|__tests__|spec)\/|(\.test|\.spec)\.[tj]sx?$|_test\.(go|py)$/i.test(normalized)) {
      scopes.add('test');
    } else {
      scopes.add('source');
    }
  }
  return scopes.size === 1 ? Array.from(scopes)[0] : 'mixed';
}

function shouldLikelyFullRebuild(files: string[], changeTypes: Array<'add' | 'change' | 'unlink'>): boolean {
  if (changeTypes.includes('unlink')) return true;
  return files.some(file => {
    const normalized = file.replace(/\\/g, '/');
    return /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|package\.json|tsconfig\.json|vite\.config\.|next\.config\.|nest-cli\.json|pyproject\.toml|Cargo\.toml|go\.mod|composer\.json|schema\.prisma|migrations?\/|Dockerfile|docker-compose\.ya?ml|compose\.ya?ml)|\.(tf|hcl)$/i.test(normalized);
  });
}

function buildImpactGuidance(preview: Omit<ImpactPreview, 'guidance'>): string {
  if (preview.likelyFullRebuild) {
    return 'Treat this as a broad in-flight impact candidate: configuration, dependency, schema, infrastructure, delete, or placement changes may affect more than the changed files.';
  }
  if (preview.scope === 'test') {
    return 'Test-only in-flight change detected. Prefer focused validation and compare against touched behavior before widening scope.';
  }
  if (preview.scope === 'source') {
    return 'Source in-flight change detected. Use the next coalesced analysis for affected capabilities, tests, idioms, and overlap before finalizing.';
  }
  return 'Mixed in-flight change detected. Wait for the coalesced analysis before treating impact as complete.';
}

function emitImpactPreview(session: WatchSession): void {
  if (session.pendingChanges.size === 0) return;
  const changes = Array.from(session.pendingChanges.values());
  const files = changes.map(change => change.path).sort((left, right) => left.localeCompare(right));
  const changeTypes = Array.from(new Set(changes.map(change => change.type))).sort();
  const previewWithoutGuidance = {
    timestamp: new Date().toISOString(),
    filesChanged: files.length,
    files: files.slice(0, 50),
    changeTypes,
    scope: classifyScope(files),
    likelyFullRebuild: shouldLikelyFullRebuild(files, changeTypes),
  };
  const preview: ImpactPreview = {
    ...previewWithoutGuidance,
    guidance: buildImpactGuidance(previewWithoutGuidance),
  };

  session.recentImpactPreviews.unshift(preview);
  if (session.recentImpactPreviews.length > MAX_RECENT_IMPACT_PREVIEWS) {
    session.recentImpactPreviews.pop();
  }

  emitter.emit('impact-preview', {
    watchId: session.id,
    projectPath: session.projectPath,
    preview,
  });
}

function scheduleImpactPreview(session: WatchSession): void {
  if (session.impactTimer) {
    clearTimeout(session.impactTimer);
  }
  session.impactTimer = setTimeout(() => {
    session.impactTimer = null;
    emitImpactPreview(session);
  }, getImpactDebounceMs());
}

function handleFileChange(session: WatchSession, eventType: string, filename: string | null): void {
  if (!filename) return;

  const fullPath = path.join(session.projectPath, filename);

  if (shouldIgnore(fullPath)) return;
  if (!isSourceFile(fullPath)) return;

  const changeType: 'add' | 'change' | 'unlink' = eventType === 'rename'
    ? (fs.existsSync(fullPath) ? 'add' : 'unlink')
    : 'change';

  session.pendingChanges.set(filename, {
    path: filename,
    type: changeType,
    timestamp: Date.now(),
  });

  session.stats.totalChangesDetected++;

  emitter.emit('file-change', {
    watchId: session.id,
    projectPath: session.projectPath,
    file: filename,
    type: changeType,
  });

  scheduleImpactPreview(session);
  scheduleAnalysis(session);
}

export function startWatch(projectPath: string): { watchId: string; status: string } {
  const normalizedPath = path.resolve(projectPath);

  for (const [id, session] of sessions) {
    if (session.projectPath === normalizedPath && session.status === 'active') {
      return { watchId: id, status: 'already_watching' };
    }
  }

  const watchId = generateWatchId();

  const session: WatchSession = {
    id: watchId,
    projectPath: normalizedPath,
    watcher: null,
    status: 'active',
    startedAt: new Date().toISOString(),
    lastAnalysis: null,
    pendingChanges: new Map(),
    recentImpactPreviews: [],
    recentChanges: [],
    analysisInProgress: false,
    debounceTimer: null,
    impactTimer: null,
    error: null,
    stats: {
      totalChangesDetected: 0,
      totalAnalysesRun: 0,
      averageAnalysisTimeMs: 0,
    },
  };

  try {
    const watcher = fs.watch(normalizedPath, { recursive: true }, (eventType, filename) => {
      handleFileChange(session, eventType, filename);
    });

    watcher.on('error', (error) => {
      session.status = 'error';
      session.error = error.message;
      emitter.emit('watcher-error', { watchId, error: error.message });
    });

    session.watcher = watcher;
    sessions.set(watchId, session);

    return { watchId, status: 'started' };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    session.status = 'error';
    session.error = errorMessage;
    sessions.set(watchId, session);
    return { watchId, status: 'error' };
  }
}

export function stopWatch(watchId: string): { success: boolean; message: string } {
  const session = sessions.get(watchId);

  if (!session) {
    return { success: false, message: `Watch session not found: ${watchId}` };
  }

  if (session.watcher) {
    session.watcher.close();
    session.watcher = null;
  }

  if (session.debounceTimer) {
    clearTimeout(session.debounceTimer);
    session.debounceTimer = null;
  }
  if (session.impactTimer) {
    clearTimeout(session.impactTimer);
    session.impactTimer = null;
  }

  session.status = 'stopped';

  return { success: true, message: `Watch session stopped: ${watchId}` };
}

export interface WatchStatus {
  watchId: string;
  projectPath: string;
  status: 'active' | 'paused' | 'stopped' | 'error';
  startedAt: string;
  lastAnalysis: string | null;
  pendingChanges: number;
  pendingFiles: string[];
  recentImpactPreviews: ImpactPreview[];
  debounceMs: number;
  impactDebounceMs: number;
  analysisInProgress: boolean;
  error: string | null;
  stats: {
    totalChangesDetected: number;
    totalAnalysesRun: number;
    averageAnalysisTimeMs: number;
  };
  recentChanges: Array<{
    timestamp: string;
    filesChanged: number;
    nodesAdded: number;
    nodesModified: number;
    nodesDeleted: number;
    riskLevel: string;
  }>;
}

export function getWatchStatus(watchId: string): WatchStatus | null {
  const session = sessions.get(watchId);

  if (!session) {
    return null;
  }

  return {
    watchId: session.id,
    projectPath: session.projectPath,
    status: session.status,
    startedAt: session.startedAt,
    lastAnalysis: session.lastAnalysis,
    pendingChanges: session.pendingChanges.size,
    pendingFiles: Array.from(session.pendingChanges.keys()).slice(0, 20),
    recentImpactPreviews: session.recentImpactPreviews.slice(0, 5),
    debounceMs: getDebounceMs(),
    impactDebounceMs: getImpactDebounceMs(),
    analysisInProgress: session.analysisInProgress,
    error: session.error,
    stats: session.stats,
    recentChanges: session.recentChanges.map(r => ({
      timestamp: r.timestamp,
      filesChanged: r.summary.filesAdded + r.summary.filesModified + r.summary.filesDeleted,
      nodesAdded: r.summary.nodesAdded,
      nodesModified: r.summary.nodesModified,
      nodesDeleted: r.summary.nodesDeleted,
      riskLevel: r.impact.riskLevel,
    })),
  };
}

export function listWatches(): WatchStatus[] {
  const result: WatchStatus[] = [];
  for (const [watchId] of sessions) {
    const status = getWatchStatus(watchId);
    if (status) result.push(status);
  }
  return result;
}

export function pollWatchChanges(watchId: string, since?: string): {
  hasChanges: boolean;
  changes: Array<{
    timestamp: string;
    filesChanged: number;
    nodesAdded: number;
    nodesModified: number;
    nodesDeleted: number;
    riskLevel: string;
  }>;
  pendingFiles: string[];
  impactPreviews: ImpactPreview[];
  analysisInProgress: boolean;
} | null {
  const session = sessions.get(watchId);

  if (!session) {
    return null;
  }

  let changes = session.recentChanges.map(r => ({
    timestamp: r.timestamp,
    filesChanged: r.summary.filesAdded + r.summary.filesModified + r.summary.filesDeleted,
    nodesAdded: r.summary.nodesAdded,
    nodesModified: r.summary.nodesModified,
    nodesDeleted: r.summary.nodesDeleted,
    riskLevel: r.impact.riskLevel,
  }));

  if (since) {
    const sinceTime = new Date(since).getTime();
    changes = changes.filter(c => new Date(c.timestamp).getTime() > sinceTime);
  }

  return {
    hasChanges: changes.length > 0 || session.pendingChanges.size > 0,
    changes,
    pendingFiles: Array.from(session.pendingChanges.keys()).slice(0, 20),
    impactPreviews: session.recentImpactPreviews.slice(0, 5),
    analysisInProgress: session.analysisInProgress,
  };
}

export function getWatchEmitter(): EventEmitter {
  return emitter;
}

export function cleanupAllWatches(): void {
  for (const [watchId] of sessions) {
    stopWatch(watchId);
  }
  sessions.clear();
}
