import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { defaultAnalysisId, fetchRemoteProjectRevisions, type RemoteSyncOptions } from './remote-sync-client';
import { loadKlauroConfig, resolveAnalysisId, resolveAnalyzerUrl } from './klauro-config';
import { detectRemoteProvider } from './remote-provider';
import { DEFAULT_KLAURO_CLOUD_URL } from './defaults';

export interface AgentRevisionTracks {
  status: 'success';
  path: string;
  project_id: string;
  server_url: string;
  selected_branch?: string;
  working_track: {
    visibility: 'private';
    dirty: boolean;
    changed_files: number;
    deleted_files: number;
    guidance: string;
  };
  committed_track: {
    visibility: 'shared';
    local_commit?: string;
    branch?: string;
    analyzed: boolean;
    latest_analyzed_commit?: string;
    latest_analysis_revision?: number;
  };
  incoming_track: {
    visibility: 'shared';
    available: boolean;
    commits: Array<{
      commit?: string;
      branch?: string;
      analysis_revision: number;
      generated_at: string;
      source: string;
    }>;
    guidance: string;
  };
  remote_provider?: ReturnType<typeof detectRemoteProvider>;
}

export async function getAgentRevisionTracks(options: RemoteSyncOptions): Promise<AgentRevisionTracks> {
  const projectPath = path.resolve(options.projectPath);
  const loaded = await loadKlauroConfig(projectPath);
  const serverUrl = resolveAnalyzerUrl(loaded, options.serverUrl) || DEFAULT_KLAURO_CLOUD_URL;
  const projectId = resolveAnalysisId(loaded, defaultAnalysisId(projectPath), options.analysisId);
  const branch = git(projectPath, ['branch', '--show-current']) || undefined;
  const head = git(projectPath, ['rev-parse', 'HEAD']) || undefined;
  const changes = gitStatus(projectPath);
  const remoteProvider = detectRemoteProvider(git(projectPath, ['remote', 'get-url', 'origin']) || undefined);

  let revisions: Awaited<ReturnType<typeof fetchRemoteProjectRevisions>>['revisions'] = [];
  try {
    revisions = (await fetchRemoteProjectRevisions({ ...options, projectPath })).revisions;
  } catch {
    revisions = [];
  }

  const latest = revisions[0];
  const incoming = revisions
    .filter(revision => revision.commit && revision.commit !== head)
    .filter(revision => !branch || !revision.branch || revision.branch === branch)
    .slice(0, 10)
    .map(revision => ({
      commit: revision.commit,
      branch: revision.branch,
      analysis_revision: revision.analysis_revision,
      generated_at: revision.generated_at,
      source: revision.source,
    }));

  return {
    status: 'success',
    path: projectPath,
    project_id: projectId,
    server_url: serverUrl,
    selected_branch: branch,
    working_track: {
      visibility: 'private',
      dirty: changes.length > 0,
      changed_files: changes.filter(change => change.status !== 'deleted').length,
      deleted_files: changes.filter(change => change.status === 'deleted').length,
      guidance: changes.length
        ? 'Use private working-copy context for local agent assistance. Commit before submitting shared project analysis.'
        : 'No uncommitted local changes detected.',
    },
    committed_track: {
      visibility: 'shared',
      local_commit: head,
      branch,
      analyzed: Boolean(head && revisions.some(revision => revision.commit === head)),
      latest_analyzed_commit: latest?.commit,
      latest_analysis_revision: latest?.analysis_revision,
    },
    incoming_track: {
      visibility: 'shared',
      available: incoming.length > 0,
      commits: incoming,
      guidance: incoming.length
        ? 'Incoming analyzed commits exist that are not your local HEAD. Check overlap before editing or pull/rebase first.'
        : 'No incoming analyzed commits detected for this branch.',
    },
    remote_provider: remoteProvider,
  };
}

function git(root: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function gitStatus(root: string): Array<{ path: string; status: 'added' | 'modified' | 'deleted' }> {
  const output = git(root, ['status', '--porcelain=v1', '-z']);
  const entries = output.split('\0').filter(Boolean);
  const changes: Array<{ path: string; status: 'added' | 'modified' | 'deleted' }> = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const code = entry.slice(0, 2);
    let filePath = entry.slice(3);
    if (code.includes('R') || code.includes('C')) {
      const newPath = entries[++index];
      if (newPath) filePath = newPath;
    }
    changes.push({
      path: filePath,
      status: code.includes('D') ? 'deleted' : code.includes('?') || code.includes('A') ? 'added' : 'modified',
    });
  }
  return changes;
}
