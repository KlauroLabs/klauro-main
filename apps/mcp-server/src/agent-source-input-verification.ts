import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

type Identity = { representation: 'bytes' | 'utf8-text'; sha256: string; bytes: number };
type IndexedInput = { identities: Map<string, Identity>; reason?: string };
export type SourceInputComparison = {
  file: string;
  status: 'matched' | 'mismatched' | 'unverified';
  reason?: string;
  error_code?: string;
};
type VerificationLimits = { max_bytes?: number; max_duration_ms?: number; max_input_records?: number };

function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function unchanged(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function validRelative(file: unknown): file is string {
  return typeof file === 'string' && file.length > 0 && file !== '.' && !file.includes('\\')
    && !path.posix.isAbsolute(file) && !path.win32.isAbsolute(file)
    && path.posix.normalize(file) === file && file !== '..' && !file.startsWith('../');
}

export function verifyAgentSourceInputs(
  projectPath: string,
  files: string[],
  contributions: unknown[] = [],
  limits: VerificationLimits = {},
) {
  const startedAt = performance.now();
  const maxBytes = Math.max(0, limits.max_bytes ?? 8 * 1024 * 1024);
  const maxDuration = Math.max(0, limits.max_duration_ms ?? 250);
  const maxRecords = Math.max(0, limits.max_input_records ?? 200_000);
  const root = path.resolve(projectPath);
  const citations = [...new Set(files)].slice(0, 20);
  const index = new Map<string, IndexedInput>();
  const keys = new Map(citations.map(file => [file, path.relative(root, path.resolve(root, file)).split(path.sep).join('/')]));
  const selected = new Set(keys.values());
  let recordsScanned = 0;
  let indexGap: string | undefined;
  let bytesRead = 0;
  let filesCompared = 0;
  const expired = () => performance.now() - startedAt >= maxDuration;

  for (const contribution of contributions) {
    if (expired()) { indexGap = 'verification-time-budget'; break; }
    const inputs = (contribution as any)?.source_inputs;
    if (!inputs || inputs.coverage === 'unavailable') continue;
    if (inputs.version !== 1 || inputs.digest_algorithm !== 'sha256'
      || inputs.coverage !== 'observed-reads' || !Array.isArray(inputs.files)) {
      indexGap = 'unsupported-input-metadata';
      break;
    }
    for (const input of inputs.files) {
      recordsScanned++;
      if (recordsScanned > maxRecords || expired()) {
        indexGap = recordsScanned > maxRecords ? 'input-record-budget' : 'verification-time-budget';
        break;
      }
      if (!validRelative(input?.path)) {
        indexGap = 'invalid-input-path';
        break;
      }
      if (!selected.has(input.path)) continue;
      const entry = index.get(input.path) || { identities: new Map<string, Identity>() };
      index.set(input.path, entry);
      if (input.status !== 'captured') {
        entry.reason = input.status === 'conflicting' ? 'conflicting-input-identities' : 'input-identity-unavailable';
        continue;
      }
      if (!['bytes', 'utf8-text'].includes(input.representation) || !/^[a-f0-9]{64}$/.test(input.sha256)
        || !Number.isSafeInteger(input.bytes) || input.bytes < 0) {
        entry.reason = 'invalid-input-identity';
        continue;
      }
      const previous = entry.identities.get(input.representation);
      if (previous && (previous.sha256 !== input.sha256 || previous.bytes !== input.bytes)) {
        entry.reason = 'conflicting-input-identities';
      }
      entry.identities.set(input.representation, {
        representation: input.representation, sha256: input.sha256, bytes: input.bytes,
      });
    }
    if (indexGap) break;
  }

  const results: SourceInputComparison[] = citations.map(file => {
    const entry = index.get(keys.get(file)!);
    const reason = indexGap || entry?.reason || (!entry?.identities.size ? 'analyzed-content-identity-unavailable' : undefined);
    if (reason) return { file, status: 'unverified', reason };
    if (expired()) return { file, status: 'unverified', reason: 'verification-time-budget' };
    let descriptor: number | undefined;
    try {
      const absolute = path.resolve(root, file);
      if (!within(root, absolute) || (path.win32.isAbsolute(file) && !path.isAbsolute(file))) {
        return { file, status: 'unverified', reason: 'outside-workspace' };
      }
      const realRoot = fs.realpathSync(root);
      const realFile = fs.realpathSync(absolute);
      if (!within(realRoot, realFile)) return { file, status: 'unverified', reason: 'outside-workspace' };
      const before = fs.statSync(realFile);
      if (!before.isFile()) return { file, status: 'unverified', reason: 'not-a-regular-file' };
      if (before.size * 2 > maxBytes - bytesRead) return { file, status: 'unverified', reason: 'source-byte-budget' };
      descriptor = fs.openSync(realFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const opened = fs.fstatSync(descriptor);
      if (!opened.isFile() || !unchanged(before, opened)) {
        return { file, status: 'unverified', reason: 'source-changed-during-verification' };
      }
      const rawHash = createHash('sha256');
      const textHash = createHash('sha256');
      const decoder = new StringDecoder('utf8');
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let offset = 0;
      let textBytes = 0;
      const addText = (text: string) => { textHash.update(text); textBytes += Buffer.byteLength(text); };
      while (offset < opened.size) {
        if (expired()) return { file, status: 'unverified', reason: 'verification-time-budget' };
        const read = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, opened.size - offset), offset);
        if (!read) return { file, status: 'unverified', reason: 'source-changed-during-verification' };
        const chunk = buffer.subarray(0, read);
        rawHash.update(chunk);
        addText(decoder.write(chunk));
        offset += read;
        bytesRead += read;
      }
      addText(decoder.end());
      const rawDigest = rawHash.digest('hex');
      const confirmationHash = createHash('sha256');
      let confirmed = 0;
      while (confirmed < opened.size) {
        if (expired()) return { file, status: 'unverified', reason: 'verification-time-budget' };
        const read = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, opened.size - confirmed), confirmed);
        if (!read) return { file, status: 'unverified', reason: 'source-changed-during-verification' };
        confirmationHash.update(buffer.subarray(0, read));
        confirmed += read;
        bytesRead += read;
      }
      if (confirmationHash.digest('hex') !== rawDigest) {
        return { file, status: 'unverified', reason: 'source-changed-during-verification' };
      }
      if (!unchanged(opened, fs.fstatSync(descriptor)) || fs.realpathSync(absolute) !== realFile
        || !unchanged(opened, fs.statSync(absolute))) {
        return { file, status: 'unverified', reason: 'source-changed-during-verification' };
      }
      if (expired()) return { file, status: 'unverified', reason: 'verification-time-budget' };
      const digests = { bytes: { sha256: rawDigest, bytes: offset },
        'utf8-text': { sha256: textHash.digest('hex'), bytes: textBytes } };
      filesCompared++;
      const matched = [...entry!.identities.values()].every(identity => {
        const actual = digests[identity.representation];
        return actual.sha256 === identity.sha256 && actual.bytes === identity.bytes;
      });
      return { file, status: matched ? 'matched' : 'mismatched' };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      return { file, status: 'unverified', reason: 'source-read-error', error_code: typeof code === 'string' ? code : 'UNKNOWN' };
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  });
  const summarize = (status: SourceInputComparison['status']) => {
    const matches = results.filter(item => item.status === status);
    return { count: matches.length, examples: matches.slice(0, 5) };
  };
  return {
    results,
    summary: {
      provenance: 'observed-reads' as const,
      certifies_complete_analysis: false,
      matched: summarize('matched'),
      mismatched: summarize('mismatched'),
      unverified: summarize('unverified'),
      scan: { method: 'sha256-observed-inputs' as const, bytes_read: bytesRead, files_compared: filesCompared,
        input_records_scanned: recordsScanned, content_read_passes: 2, max_bytes: maxBytes, max_duration_ms: maxDuration,
        max_input_records: maxRecords, duration_ms: performance.now() - startedAt },
      note: 'Matches cover recorded input observations only, not unobserved analyzer inputs, dependencies, graph correctness, or future edits.',
    },
  };
}
