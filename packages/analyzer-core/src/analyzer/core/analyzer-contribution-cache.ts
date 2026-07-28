import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { CASContribution } from '../../types/cas.types';

const FORMAT = 'klauro-analyzer-contribution-cache';
const FORMAT_VERSION = 1;

export interface AnalyzerContributionCacheIdentity {
  id: string;
  version: string;
  type?: 'language' | 'framework' | 'library' | 'pattern';
  implementationFingerprint?: string;
}

export interface AnalyzerContributionCacheInput {
  sourceIdentity: string;
  sourceContentHash: string;
  analyzer: AnalyzerContributionCacheIdentity;
  relevantConfig?: unknown;
  semanticPackIdentity?: unknown;
}

export type AnalyzerContributionCacheInvalidationReason =
  | 'cold'
  | 'source-content-changed'
  | 'analyzer-version-changed'
  | 'analyzer-type-changed'
  | 'analyzer-implementation-changed'
  | 'relevant-config-changed'
  | 'semantic-pack-changed'
  | 'cache-schema-changed'
  | 'entry-missing'
  | 'corrupt-entry';

export type AnalyzerContributionCacheStatus =
  | 'disabled'
  | 'hit'
  | 'miss'
  | 'invalidated'
  | 'coalesced';

export interface AnalyzerContributionCacheEvidence {
  status: AnalyzerContributionCacheStatus;
  key: string;
  analyzerId: string;
  analyzerVersion: string;
  sourceIdentity: string;
  componentFingerprints: CacheComponents;
  invalidationReasons: AnalyzerContributionCacheInvalidationReason[];
  payloadBytes?: number;
  createdAt?: string;
  persisted?: boolean;
}

export interface AnalyzerContributionCacheLookup {
  contribution?: CASContribution;
  evidence: AnalyzerContributionCacheEvidence;
}

export interface AnalyzerContributionCacheStats {
  hits: number;
  misses: number;
  invalidations: number;
  corruptions: number;
  writes: number;
  coalesced: number;
}

export interface PersistentAnalyzerContributionCacheOptions {
  rootPath?: string;
  schemaVersion?: string;
}

interface CacheComponents {
  schema: string;
  sourceContent: string;
  analyzerVersion: string;
  analyzerType: string;
  analyzerImplementation: string;
  relevantConfig: string;
  semanticPack: string;
}

interface CacheDescriptor {
  format: typeof FORMAT;
  formatVersion: number;
  key: string;
  analyzerId: string;
  analyzerVersion: string;
  sourceIdentity: string;
  components: CacheComponents;
  createdAt: string;
}

interface CacheEnvelope extends CacheDescriptor {
  payloadChecksum: string;
  payloadBytes: number;
  contribution: CASContribution;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalize(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === undefined) return { $type: 'undefined' };
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { $type: 'number', value: 'NaN' };
    if (value === Infinity) return { $type: 'number', value: 'Infinity' };
    if (value === -Infinity) return { $type: 'number', value: '-Infinity' };
    if (Object.is(value, -0)) return { $type: 'number', value: '-0' };
    return value;
  }
  if (typeof value === 'bigint') return { $type: 'bigint', value: value.toString() };
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError(`Cache identity cannot contain ${typeof value} values`);
  }
  if (value instanceof RegExp) return { $type: 'regexp', source: value.source, flags: value.flags };
  if (value instanceof Date) return { $type: 'date', value: value.toISOString() };
  if (Buffer.isBuffer(value)) return { $type: 'buffer', value: value.toString('base64') };
  if (typeof value !== 'object') return String(value);
  if (ancestors.has(value)) throw new TypeError('Cache identity cannot contain circular values');
  ancestors.add(value);
  try {
    if (value instanceof Set) {
      const members = [...value].map(item => JSON.stringify(canonicalize(item, ancestors))).sort();
      return { $type: 'set', values: members };
    }
    if (value instanceof Map) {
      const entries = [...value].map(([key, item]) => [
        JSON.stringify(canonicalize(key, ancestors)),
        canonicalize(item, ancestors),
      ] as const).sort(([left], [right]) => left.localeCompare(right));
      return { $type: 'map', entries };
    }
    if (Array.isArray(value)) return value.map(item => canonicalize(item, ancestors));
    const record = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) normalized[key] = canonicalize(record[key], ancestors);
    return normalized;
  } finally {
    ancestors.delete(value);
  }
}

export function stableAnalyzerCacheIdentity(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function componentFingerprint(value: unknown): string {
  return sha256(stableAnalyzerCacheIdentity(value));
}

function validateInput(input: AnalyzerContributionCacheInput): void {
  if (!input.sourceIdentity.trim()) throw new TypeError('sourceIdentity is required');
  if (!input.sourceContentHash.trim()) throw new TypeError('sourceContentHash is required');
  if (!input.analyzer.id.trim()) throw new TypeError('analyzer.id is required');
  if (!input.analyzer.version.trim()) throw new TypeError('analyzer.version is required');
}

function safeDirectoryName(value: string): string {
  const readable = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'analyzer';
  return `${readable}-${sha256(value).slice(0, 12)}`;
}

function isContribution(value: unknown): value is CASContribution {
  if (!value || typeof value !== 'object') return false;
  const metadata = (value as Partial<CASContribution>).analyzer_metadata;
  return Boolean(metadata && typeof metadata === 'object' && typeof metadata.analyzer_id === 'string');
}

function invalidationReasons(previous: CacheDescriptor, current: CacheDescriptor): AnalyzerContributionCacheInvalidationReason[] {
  const reasons: AnalyzerContributionCacheInvalidationReason[] = [];
  if (previous.components.schema !== current.components.schema) reasons.push('cache-schema-changed');
  if (previous.components.sourceContent !== current.components.sourceContent) reasons.push('source-content-changed');
  if (previous.components.analyzerVersion !== current.components.analyzerVersion) reasons.push('analyzer-version-changed');
  if (previous.components.analyzerType !== current.components.analyzerType) reasons.push('analyzer-type-changed');
  if (previous.components.analyzerImplementation !== current.components.analyzerImplementation) reasons.push('analyzer-implementation-changed');
  if (previous.components.relevantConfig !== current.components.relevantConfig) reasons.push('relevant-config-changed');
  if (previous.components.semanticPack !== current.components.semanticPack) reasons.push('semantic-pack-changed');
  return reasons;
}

async function atomicReplace(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function atomicCreate(filePath: string, content: string): Promise<boolean> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
    try {
      await fs.link(temporary, filePath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

export class PersistentAnalyzerContributionCache {
  private readonly rootPath?: string;
  private readonly schemaVersion: string;
  private readonly inFlight = new Map<string, Promise<CASContribution>>();
  private readonly stats: AnalyzerContributionCacheStats = {
    hits: 0,
    misses: 0,
    invalidations: 0,
    corruptions: 0,
    writes: 0,
    coalesced: 0,
  };

  constructor(options: PersistentAnalyzerContributionCacheOptions = {}) {
    this.rootPath = options.rootPath?.trim() || undefined;
    this.schemaVersion = options.schemaVersion?.trim() || String(FORMAT_VERSION);
  }

  describe(input: AnalyzerContributionCacheInput): CacheDescriptor {
    validateInput(input);
    const components: CacheComponents = {
      schema: componentFingerprint({ format: FORMAT, formatVersion: FORMAT_VERSION, schemaVersion: this.schemaVersion }),
      sourceContent: componentFingerprint(input.sourceContentHash),
      analyzerVersion: componentFingerprint(input.analyzer.version),
      analyzerType: componentFingerprint(input.analyzer.type ?? ''),
      analyzerImplementation: componentFingerprint(input.analyzer.implementationFingerprint ?? ''),
      relevantConfig: componentFingerprint(input.relevantConfig),
      semanticPack: componentFingerprint(input.semanticPackIdentity),
    };
    const key = componentFingerprint({
      sourceIdentity: input.sourceIdentity,
      analyzerId: input.analyzer.id,
      components,
    });
    return {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      key,
      analyzerId: input.analyzer.id,
      analyzerVersion: input.analyzer.version,
      sourceIdentity: input.sourceIdentity,
      components,
      createdAt: new Date().toISOString(),
    };
  }

  getStats(): AnalyzerContributionCacheStats {
    return { ...this.stats };
  }

  async get(input: AnalyzerContributionCacheInput): Promise<AnalyzerContributionCacheLookup> {
    const descriptor = this.describe(input);
    if (!this.rootPath) return { evidence: this.evidence('disabled', descriptor, []) };
    const entryPath = this.entryPath(descriptor);
    try {
      const raw = await fs.readFile(entryPath, 'utf8');
      const envelope = JSON.parse(raw) as CacheEnvelope;
      const payload = JSON.stringify(envelope.contribution);
      if (!this.validEnvelope(envelope, descriptor, payload)) throw new Error('invalid cache envelope');
      this.stats.hits++;
      return {
        contribution: envelope.contribution,
        evidence: this.evidence('hit', descriptor, [], {
          payloadBytes: envelope.payloadBytes,
          createdAt: envelope.createdAt,
          persisted: true,
        }),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.stats.invalidations++;
        this.stats.corruptions++;
        await fs.rm(entryPath, { force: true }).catch(() => undefined);
        return { evidence: this.evidence('invalidated', descriptor, ['corrupt-entry']) };
      }
    }

    const previous = await this.readFamilyDescriptor(descriptor);
    const reasons = previous ? invalidationReasons(previous, descriptor) : ['cold' as const];
    if (previous && reasons.length === 0) reasons.push('entry-missing');
    if (reasons.some(reason => reason !== 'cold' && reason !== 'entry-missing')) {
      this.stats.invalidations++;
      return { evidence: this.evidence('invalidated', descriptor, reasons) };
    }
    this.stats.misses++;
    return { evidence: this.evidence('miss', descriptor, reasons) };
  }

  async put(input: AnalyzerContributionCacheInput, contribution: CASContribution): Promise<boolean> {
    if (!this.rootPath) return false;
    if (!isContribution(contribution)) throw new TypeError('contribution must contain analyzer_metadata.analyzer_id');
    const descriptor = this.describe(input);
    const payload = JSON.stringify(contribution);
    if (payload === undefined) throw new TypeError('contribution is not JSON serializable');
    const envelope: CacheEnvelope = {
      ...descriptor,
      payloadChecksum: sha256(payload),
      payloadBytes: Buffer.byteLength(payload),
      contribution,
    };
    const created = await atomicCreate(this.entryPath(descriptor), JSON.stringify(envelope));
    if (created) this.stats.writes++;
    await atomicReplace(this.familyPath(descriptor), JSON.stringify(descriptor));
    return created;
  }

  async getOrCompute(
    input: AnalyzerContributionCacheInput,
    compute: () => Promise<CASContribution>
  ): Promise<AnalyzerContributionCacheLookup> {
    const lookup = await this.get(input);
    if (lookup.contribution) return lookup;
    const descriptor = this.describe(input);
    const active = this.inFlight.get(descriptor.key);
    if (active) {
      this.stats.coalesced++;
      return {
        contribution: await active,
        evidence: this.evidence('coalesced', descriptor, lookup.evidence.invalidationReasons),
      };
    }
    const pending = compute();
    this.inFlight.set(descriptor.key, pending);
    try {
      const contribution = await pending;
      const persisted = await this.put(input, contribution);
      return {
        contribution,
        evidence: { ...lookup.evidence, persisted },
      };
    } finally {
      if (this.inFlight.get(descriptor.key) === pending) this.inFlight.delete(descriptor.key);
    }
  }

  private evidence(
    status: AnalyzerContributionCacheStatus,
    descriptor: CacheDescriptor,
    reasons: AnalyzerContributionCacheInvalidationReason[],
    additional: Partial<AnalyzerContributionCacheEvidence> = {}
  ): AnalyzerContributionCacheEvidence {
    return {
      status,
      key: descriptor.key,
      analyzerId: descriptor.analyzerId,
      analyzerVersion: descriptor.analyzerVersion,
      sourceIdentity: descriptor.sourceIdentity,
      componentFingerprints: { ...descriptor.components },
      invalidationReasons: [...reasons],
      ...additional,
    };
  }

  private analyzerDirectory(descriptor: CacheDescriptor): string {
    return path.join(this.rootPath!, `v${FORMAT_VERSION}`, safeDirectoryName(descriptor.analyzerId));
  }

  private entryPath(descriptor: CacheDescriptor): string {
    return path.join(this.analyzerDirectory(descriptor), 'entries', descriptor.key.slice(0, 2), `${descriptor.key}.json`);
  }

  private familyPath(descriptor: CacheDescriptor): string {
    const family = componentFingerprint({ analyzerId: descriptor.analyzerId, sourceIdentity: descriptor.sourceIdentity });
    return path.join(this.analyzerDirectory(descriptor), 'families', family.slice(0, 2), `${family}.json`);
  }

  private async readFamilyDescriptor(descriptor: CacheDescriptor): Promise<CacheDescriptor | undefined> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.familyPath(descriptor), 'utf8')) as CacheDescriptor;
      return parsed?.format === FORMAT && parsed?.components ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private validEnvelope(envelope: CacheEnvelope, descriptor: CacheDescriptor, payload: string): boolean {
    return envelope?.format === FORMAT
      && envelope.formatVersion === FORMAT_VERSION
      && envelope.key === descriptor.key
      && stableAnalyzerCacheIdentity(envelope.components) === stableAnalyzerCacheIdentity(descriptor.components)
      && envelope.payloadChecksum === sha256(payload)
      && envelope.payloadBytes === Buffer.byteLength(payload)
      && isContribution(envelope.contribution);
  }
}
