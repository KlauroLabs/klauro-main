import * as crypto from 'node:crypto';
import * as path from 'node:path';
import type { CASAnalyzerSourceInputs, CASSourceInputIdentity } from '../../types/cas.types';

export type SourceInputObservation = Omit<CASSourceInputIdentity, 'path'>;

export function sourceInputObservation(value: string | Buffer, encoding: string): SourceInputObservation {
  const representation = Buffer.isBuffer(value) ? 'bytes' : 'utf8-text';
  if (typeof value === 'string' && !/^utf-?8$/i.test(encoding)) {
    return { status: 'unavailable', reason: 'unsupported-text-encoding' };
  }
  return {
    status: 'captured',
    representation,
    sha256: crypto.createHash('sha256').update(value).digest('hex'),
    bytes: Buffer.isBuffer(value) ? value.length : Buffer.byteLength(value, 'utf8'),
  };
}

export class AnalyzerSourceInputCapture {
  private readonly files = new Set<string>();
  private readonly observations = new Map<string, SourceInputObservation>();

  constructor(private readonly parent?: AnalyzerSourceInputCapture) {}

  add(file: string): void {
    const absolute = path.resolve(file);
    this.files.add(absolute);
    this.parent?.add(absolute);
  }

  observe(file: string, observation: SourceInputObservation): void {
    const absolute = path.resolve(file);
    this.add(absolute);
    const previous = this.observations.get(absolute);
    if (!previous) this.observations.set(absolute, observation);
    else if (previous.status === 'captured' && observation.status === 'captured') {
      if (previous.sha256 !== observation.sha256 || previous.representation !== observation.representation) {
        this.observations.set(absolute, { status: 'conflicting', reason: 'multiple-input-identities' });
      }
    } else if (previous.status !== 'conflicting' && observation.status !== 'captured') {
      this.observations.set(absolute, observation);
    }
    this.parent?.observe(absolute, observation);
  }

  paths(): string[] {
    return [...this.files].sort();
  }

  snapshot(rootPath: string, representedFiles: string[] = []): CASAnalyzerSourceInputs {
    const root = path.resolve(rootPath);
    const allFiles = new Set([...this.files, ...representedFiles.map(file => path.resolve(root, file))]);
    const files: CASSourceInputIdentity[] = [];
    let outsideRootReads = 0;
    for (const absolute of allFiles) {
      const relative = path.relative(root, absolute).replace(/\\/g, '/');
      if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
        outsideRootReads++;
        continue;
      }
      files.push({
        path: relative,
        ...(this.observations.get(absolute) || { status: 'unavailable' as const, reason: 'source-not-observed' }),
      });
    }
    files.sort((left, right) => left.path.localeCompare(right.path));
    return { version: 1, coverage: 'observed-reads', digest_algorithm: 'sha256', files, outside_root_reads: outsideRootReads };
  }
}
