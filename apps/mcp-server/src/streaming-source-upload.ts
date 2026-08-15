import { Readable } from 'node:stream';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import type { StreamingSourceSnapshotPlan, StreamingWorkingTreePlan } from './remote-source';
import { REMOTE_ANALYSIS_PROTOCOL_VERSION } from './remote-analyzer-protocol';
import type { AnalysisFocus } from './analysis-focus';

export interface StreamingJsonRequest {
  readonly streamingJson: true;
  prepare(): Promise<void>;
  createBody(): Readable;
  dispose(): Promise<void>;
}

export function createAnalyzeUploadRequest(input: {
  project_id: string;
  organization_id?: string;
  project_path: string;
  snapshot: StreamingSourceSnapshotPlan;
  async: boolean;
  analysis_focus?: AnalysisFocus;

  force?: boolean;
}): StreamingJsonRequest {
  return streamingRequest(() => analyzeJson(input));
}

export function createIncrementalUploadRequest(input: {
  analysis_id: string;
  project_id: string;
  organization_id?: string;
  project_path: string;
  changes: StreamingWorkingTreePlan;
  async: boolean;
}): StreamingJsonRequest {
  return streamingRequest(() => incrementalJson(input));
}

export function isStreamingJsonRequest(value: unknown): value is StreamingJsonRequest {
  return Boolean(value && typeof value === 'object' && (value as StreamingJsonRequest).streamingJson === true);
}

function streamingRequest(factory: () => AsyncGenerator<string>): StreamingJsonRequest {
  let directory: string | undefined;
  let archive: string | undefined;
  return {
    streamingJson: true,
    async prepare() {
      if (archive) return;
      directory = await mkdtemp(path.join(os.tmpdir(), 'klauro-upload-'));
      archive = path.join(directory, 'request.json.gz');
      try {
        await pipeline(Readable.from(factory(), { encoding: 'utf8' }), createGzip(), createWriteStream(archive));
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        directory = undefined;
        archive = undefined;
        throw error;
      }
    },
    createBody() {
      if (!archive) throw new Error('Streaming request must be prepared before upload');
      return createReadStream(archive);
    },
    async dispose() {
      if (directory) await rm(directory, { recursive: true, force: true });
      directory = undefined;
      archive = undefined;
    },
  };
}

async function* analyzeJson(input: Parameters<typeof createAnalyzeUploadRequest>[0]): AsyncGenerator<string> {
  yield '{';
  yield field('protocol_version', REMOTE_ANALYSIS_PROTOCOL_VERSION);
  yield `,${field('project_id', input.project_id)}`;
  if (input.organization_id !== undefined) yield `,${field('organization_id', input.organization_id)}`;
  yield `,${field('project_path', input.project_path)}`;
  yield ',"snapshot":{';
  yield field('project_name', input.snapshot.project_name);
  if (input.snapshot.base_commit !== undefined) yield `,${field('base_commit', input.snapshot.base_commit)}`;
  yield `,${field('snapshot_source', input.snapshot.snapshot_source)}`;
  yield ',"files":[';
  for (let index = 0; index < input.snapshot.files.length; index += 1) {
    const file = input.snapshot.files[index];
    const content = await file.readContent();
    assertDescriptor(file, content);
    if (index > 0) yield ',';
    yield JSON.stringify({ path: file.path, content, hash: file.hash });
  }
  yield `],${field('manifest', input.snapshot.manifest)}}`;
  yield `,${field('async', input.async)}`;
  if (input.analysis_focus) yield `,${field('analysis_focus', input.analysis_focus)}`;
  if (input.force) yield `,${field('force', true)}`;
  yield '}';
}

async function* incrementalJson(input: Parameters<typeof createIncrementalUploadRequest>[0]): AsyncGenerator<string> {
  yield '{';
  yield field('protocol_version', REMOTE_ANALYSIS_PROTOCOL_VERSION);
  yield `,${field('analysis_id', input.analysis_id)}`;
  yield `,${field('project_id', input.project_id)}`;
  if (input.organization_id !== undefined) yield `,${field('organization_id', input.organization_id)}`;
  yield `,${field('project_path', input.project_path)}`;
  yield ',"changes":{';
  yield field('project_name', input.changes.project_name);
  if (input.changes.base_commit !== undefined) yield `,${field('base_commit', input.changes.base_commit)}`;
  const gitDiff = await input.changes.readGitDiff?.();
  if (gitDiff !== undefined) yield `,${field('git_diff', gitDiff)}`;
  yield ',"changed_files":[';
  for (let index = 0; index < input.changes.changed_files.length; index += 1) {
    const file = input.changes.changed_files[index];
    if (index > 0) yield ',';
    if (file.status === 'deleted') {
      yield JSON.stringify({ path: file.path, status: 'deleted' });
    } else {
      const content = await file.readContent();
      assertDescriptor(file, content);
      yield JSON.stringify({ path: file.path, content, hash: file.hash, status: file.status });
    }
  }
  yield `],${field('manifest', input.changes.manifest)}}`;
  yield `,${field('async', input.async)}}`;
}

function field(name: string, value: unknown): string {
  return `${JSON.stringify(name)}:${JSON.stringify(value)}`;
}

function assertDescriptor(file: { path: string; hash: string; bytes: number }, content: string): void {
  const bytes = Buffer.byteLength(content, 'utf8');
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  if (bytes !== file.bytes || hash !== file.hash) {
    throw new Error(`Source changed while Klauro was packaging ${file.path}; retry the upload to capture one coherent revision.`);
  }
}
