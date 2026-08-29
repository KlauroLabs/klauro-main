import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { CASOutput, SystemCapability } from '../../../../packages/analyzer-core/src/types/cas.types';

export const TERMINAL_RECEIPT_IDENTITY = Object.freeze({
  provider: 'deepinfra',
  model: 'Qwen/Qwen3-Next-80B-A3B-Instruct',
  promptVersion: 'capability_catalog.v2',
  semanticSchemaVersion: 'e1.1',
});

interface CorpusMember {
  repoId: string;
  source: string;
  license: string;
  archive: string;
  archiveSha256: string;
  root: string;
  sourceFile: string;
  sourceSha256: string;
  receipt?: string;
}
interface CorpusFixture { corpus: CorpusMember[]; }
export interface AnalyzerSourceIdentity { commit: string; digest: string; fileCount: number; }
export interface ReceiptGeneratorDependencies {
  analyze(root: string): Promise<CASOutput>;
  resolveSourceIdentity(root: string): AnalyzerSourceIdentity;
  runTerminalGate(root: string): void;
}
export interface ReceiptGeneratorOptions {
  repoRoot: string;
  fixturePath: string;
  semanticTraceRoot: string;
  dependencies: ReceiptGeneratorDependencies;
  env?: NodeJS.ProcessEnv;
}

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

export function assertTerminalReceiptEnvironment(env: NodeJS.ProcessEnv): void {
  const exact: Record<string, string> = {
    DEEPINFRA_MODEL: TERMINAL_RECEIPT_IDENTITY.model,
    DEEPINFRA_STRUCTURED_MODEL: TERMINAL_RECEIPT_IDENTITY.model,
    KLAURO_AI_ENABLED: 'true',
    KLAURO_AI_INTERPRETATION: 'true',
    KLAURO_AI_INTERPRETATION_ALLOW_DETERMINISTIC_KEEP: 'false',
    AI_CACHE_ENABLED: 'false',
  };
  if (!env.DEEPINFRA_API_KEY) throw new Error('DEEPINFRA_API_KEY is required');
  const conflictingProviderKeys = [
    'KLAURO_AI_PROVIDER_CHAIN', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY',
    'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_DEPLOYMENT', 'AZURE_OPENAI_MODEL',
  ];
  const configuredConflict = conflictingProviderKeys.find(name => env[name]);
  if (configuredConflict) throw new Error(`${configuredConflict} conflicts with the pinned DeepInfra receipt identity`);
  if (env.DEEPINFRA_FAST_FALLBACK_MODEL !== TERMINAL_RECEIPT_IDENTITY.model) {
    throw new Error(`DEEPINFRA_FAST_FALLBACK_MODEL must equal ${TERMINAL_RECEIPT_IDENTITY.model}`);
  }
  if (!['1', 'true'].includes(env.KLAURO_AI_INTERPRETATION_FORCE || '')) {
    throw new Error('KLAURO_AI_INTERPRETATION_FORCE must be true');
  }
  if (!env.KLAURO_SEMANTIC_DATASET_DIR) throw new Error('KLAURO_SEMANTIC_DATASET_DIR is required');
  for (const [name, expected] of Object.entries(exact)) {
    if (env[name] !== expected) throw new Error(`${name} must equal ${expected}`);
  }
}

function analyzerSourceFiles(repoRoot: string): string[] {
  const files: string[] = [];
  const visit = (absolute: string) => {
    const stat = fs.statSync(absolute);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) visit(path.join(absolute, name));
      return;
    }
    const relative = path.relative(repoRoot, absolute).split(path.sep).join('/');
    if (!relative.includes('/__tests__/') && !/\.(test|spec)\.ts$/.test(relative)) files.push(relative);
  };
  visit(path.join(repoRoot, 'packages/analyzer-core/src'));
  visit(path.join(repoRoot, 'apps/mcp-server/src/analyzer.ts'));
  return files.sort();
}

export function resolveTerminalReceiptSourceIdentity(repoRoot: string): AnalyzerSourceIdentity {
  const trackedStatus = execFileSync('git', ['diff-index', '--name-only', 'HEAD', '--'], { cwd: repoRoot, encoding: 'utf8' });
  if (trackedStatus.trim()) throw new Error('Terminal corpus receipt generation requires tracked files to match HEAD');
  const identityPaths = [
    'packages/analyzer-core/src',
    'apps/mcp-server/src/analyzer.ts',
    'apps/mcp-server/src/gauntlet/fixtures/terminality-public-corpus.json',
    'apps/mcp-server/src/gauntlet/fixtures/terminality-public-corpus',
  ];
  const untrackedIdentityFiles = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', ...identityPaths], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (untrackedIdentityFiles.trim()) throw new Error('Terminal corpus identity paths contain untracked files');
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('Terminal corpus receipt generation requires an exact 40-character commit');
  const digest = createHash('sha256');
  const files = analyzerSourceFiles(repoRoot);
  for (const relative of files) {
    digest.update(relative);
    digest.update('\0');
    digest.update(fs.readFileSync(path.join(repoRoot, relative)));
    digest.update('\0');
  }
  return { commit, digest: digest.digest('hex'), fileCount: files.length };
}

function readSemanticTrace(directory: string): Buffer {
  const files = fs.readdirSync(directory).filter(file => file.endsWith('.jsonl')).sort();
  if (files.length !== 1) throw new Error(`Expected exactly one semantic trace, found ${files.length}`);
  const bytes = fs.readFileSync(path.join(directory, files[0]));
  const rows = bytes.toString('utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const providerAttempts = rows.filter(row => row.decision_type === 'ai_provider_attempt');
  const catalogDecisions = rows.filter(row => row.decision_type === 'capability_catalog');
  if (!providerAttempts.length || !catalogDecisions.length) throw new Error('Semantic trace lacks provider or catalog decisions');
  if (!providerAttempts.every(row => row.provider === TERMINAL_RECEIPT_IDENTITY.provider
    && row.model === TERMINAL_RECEIPT_IDENTITY.model
    && row.schema_version === TERMINAL_RECEIPT_IDENTITY.semanticSchemaVersion)) {
    throw new Error('Every provider attempt must use the pinned provider/model/schema identity');
  }
  if (!catalogDecisions.every(row => row.prompt_version === TERMINAL_RECEIPT_IDENTITY.promptVersion
    && row.schema_version === TERMINAL_RECEIPT_IDENTITY.semanticSchemaVersion)) {
    throw new Error('Every capability catalog decision must use the pinned prompt/schema identity');
  }
  return bytes;
}

function evidenceFor(capability: SystemCapability, nodes: Set<string>, flows: Set<string>) {
  const source_node_ids = [...new Set((capability.operations || [])
    .map(operation => operation.entry_point_id)
    .filter((id): id is string => typeof id === 'string' && nodes.has(id)))].sort();
  const source_flow_ids = [...new Set((capability.related_flows || [])
    .map(flow => flow.flow_id)
    .filter(id => flows.has(id)))].sort();
  if (source_node_ids.length + source_flow_ids.length === 0) {
    throw new Error(`Capability ${capability.id} has no source evidence in its produced CAS`);
  }
  return { source_node_ids, source_flow_ids };
}

function validateStaged(output: CASOutput, receipt: any, casBytes: Buffer, semanticBytes: Buffer): void {
  if (sha256(casBytes) !== receipt.analysis.production_cas_sha256) throw new Error('Production CAS digest mismatch');
  if (sha256(semanticBytes) !== receipt.analysis.semantic_trace_sha256) throw new Error('Semantic trace digest mismatch');
  const decoded = JSON.parse(gunzipSync(casBytes).toString('utf8')) as CASOutput;
  const payload = receipt.capabilities.map((item: any) => item.capability);
  if (sha256(JSON.stringify(payload)) !== receipt.analysis.capabilities_sha256) throw new Error('Capability digest mismatch');
  if (JSON.stringify(payload) !== JSON.stringify(decoded.capabilities || [])) throw new Error('Receipt capability payload differs from CAS');
  const nodes = new Set(output.nodes.map(node => node.id));
  const flows = new Set((output.flows || []).map(flow => flow.flow_id));
  for (const item of receipt.capabilities) {
    if (!item.source_node_ids.length && !item.source_flow_ids.length) throw new Error(`${item.capability.id} has no evidence`);
    for (const id of item.source_node_ids) if (!nodes.has(id)) throw new Error(`Unknown node evidence ${id}`);
    for (const id of item.source_flow_ids) if (!flows.has(id)) throw new Error(`Unknown flow evidence ${id}`);
  }
}

async function stageMember(member: CorpusMember, fixtureDir: string, stagedBundle: string, extractionRoot: string,
  traceRoot: string, identity: AnalyzerSourceIdentity, analyze: ReceiptGeneratorDependencies['analyze']): Promise<void> {
  if (!member.receipt) return;
  const archivePath = path.join(fixtureDir, member.archive);
  const archiveBytes = fs.readFileSync(archivePath);
  if (sha256(archiveBytes) !== member.archiveSha256) throw new Error(`Archive digest mismatch for ${member.repoId}`);
  const extraction = path.join(extractionRoot, member.repoId.replace(/[^a-z0-9]+/gi, '-'));
  fs.mkdirSync(extraction, { recursive: true });
  execFileSync('tar', ['-xzf', archivePath, '-C', extraction]);
  const projectRoot = path.join(extraction, member.root);
  if (sha256(fs.readFileSync(path.join(projectRoot, member.sourceFile))) !== member.sourceSha256) {
    throw new Error(`Pinned source digest mismatch for ${member.repoId}`);
  }
  const memberTraceRoot = path.join(traceRoot, member.repoId.replace(/[^a-z0-9]+/gi, '-'));
  fs.mkdirSync(memberTraceRoot, { recursive: true });
  process.env.KLAURO_SEMANTIC_DATASET_DIR = memberTraceRoot;
  const output = await analyze(projectRoot);
  if (output.analysis_errors?.length) throw new Error(`Analysis failed for ${member.repoId}: ${output.analysis_errors.join('; ')}`);
  if (!output.capabilities?.length) throw new Error(`Analysis emitted no capabilities for ${member.repoId}`);
  if (!output.analysis_id || !output.analysis_timestamp || !output.parser_fingerprint || !output.derived_fingerprint) {
    throw new Error(`Analysis identity is incomplete for ${member.repoId}`);
  }
  const nodes = new Set(output.nodes.map(node => node.id));
  const flows = new Set((output.flows || []).map(flow => flow.flow_id));
  const capabilities = output.capabilities.map(capability => ({ capability, ...evidenceFor(capability, nodes, flows) }));
  const semanticBytes = readSemanticTrace(memberTraceRoot);
  const casBytes = gzipSync(JSON.stringify(output), { level: 9 });
  const relativeReceipt = member.receipt.replace(/^terminality-public-corpus\//, '');
  const stem = path.basename(relativeReceipt, '-receipt.json');
  const casName = `${stem}-cas.json.gz`;
  const traceName = `${stem}-semantic.jsonl`;
  const commit = member.repoId.slice(member.repoId.lastIndexOf('@') + 1);
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`${member.repoId} is not commit-pinned`);
  const repository = member.source.match(/^(https:\/\/github\.com\/[^/]+\/[^/]+)\/archive\//)?.[1];
  if (!repository) throw new Error(`Cannot derive repository from ${member.source}`);
  const sourceFiles = [...new Set([member.sourceFile, 'LICENSE', 'package.json', 'package-lock.json'])]
    .filter(file => fs.existsSync(path.join(projectRoot, file))).sort();
  const receipt = {
    schema_version: 'terminality-public-corpus-receipt.v1',
    source: { repository, commit, license: member.license, archive: path.basename(member.archive), archive_sha256: member.archiveSha256,
      root: member.root, file_sha256: Object.fromEntries(sourceFiles.map(file => [file, sha256(fs.readFileSync(path.join(projectRoot, file)))])) },
    analysis: { analysis_id: output.analysis_id, analysis_timestamp: output.analysis_timestamp,
      analyzer_build: `source-sha256:${identity.digest}`, analyzer_source_base_commit: identity.commit,
      analyzer_source_sha256: identity.digest, analyzer_source_file_count: identity.fileCount,
      production_cas: casName, production_cas_sha256: sha256(casBytes), capabilities_sha256: sha256(JSON.stringify(output.capabilities)),
      provider: TERMINAL_RECEIPT_IDENTITY.provider, model: TERMINAL_RECEIPT_IDENTITY.model,
      prompt_version: TERMINAL_RECEIPT_IDENTITY.promptVersion, semantic_schema_version: TERMINAL_RECEIPT_IDENTITY.semanticSchemaVersion,
      semantic_trace: traceName, semantic_trace_sha256: sha256(semanticBytes), ai_cache: 'disabled',
      parser_fingerprint: output.parser_fingerprint, derived_fingerprint: output.derived_fingerprint },
    repo_id: member.repoId, known_node_ids: [...nodes].sort(), known_flow_ids: [...flows].sort(), capabilities,
  };
  validateStaged(output, receipt, casBytes, semanticBytes);
  fs.writeFileSync(path.join(stagedBundle, casName), casBytes);
  fs.writeFileSync(path.join(stagedBundle, traceName), semanticBytes);
  fs.writeFileSync(path.join(stagedBundle, relativeReceipt), `${JSON.stringify(receipt, null, 2)}\n`);
}

interface PublicationJournal {
  current: string;
  backup: string;
  staged: string;
  stagingParent: string;
}

function fsyncPath(target: string): void {
  const descriptor = fs.openSync(target, 'r');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function fsyncTree(directory: string): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) fsyncTree(target);
    else fsyncPath(target);
  }
  fsyncPath(directory);
}

function writeJournal(journalPath: string, journal: PublicationJournal): void {
  const temporary = `${journalPath}.tmp-${process.pid}-${randomUUID()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(journal)}\n`);
  fsyncPath(temporary);
  fs.renameSync(temporary, journalPath);
  fsyncPath(path.dirname(journalPath));
}

export function recoverTerminalReceiptPublication(journalPath: string): void {
  if (!fs.existsSync(journalPath)) return;
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as PublicationJournal;
  if (fs.existsSync(journal.backup)) {
    if (fs.existsSync(journal.current)) fs.rmSync(journal.current, { recursive: true, force: true });
    fs.renameSync(journal.backup, journal.current);
    fsyncPath(path.dirname(journal.current));
  }
  if (fs.existsSync(journal.stagingParent)) fs.rmSync(journal.stagingParent, { recursive: true, force: true });
  fs.rmSync(journalPath, { force: true });
  fsyncPath(path.dirname(journalPath));
}

export async function generateTerminalPublicCorpusReceipts(options: ReceiptGeneratorOptions): Promise<void> {
  const env = options.env || process.env;
  assertTerminalReceiptEnvironment(env);
  const fixture = JSON.parse(fs.readFileSync(options.fixturePath, 'utf8')) as CorpusFixture;
  const members = fixture.corpus.filter(member => member.receipt);
  if (!members.length) throw new Error('Corpus contains no receipt-backed members');
  const identity = options.dependencies.resolveSourceIdentity(options.repoRoot);
  const fixtureDir = path.dirname(options.fixturePath);
  const current = path.join(fixtureDir, 'terminality-public-corpus');
  const journalPath = path.join(fixtureDir, '.terminality-public-corpus-publish.json');
  recoverTerminalReceiptPublication(journalPath);
  const stagingParent = fs.mkdtempSync(path.join(fixtureDir, '.terminal-receipts-'));
  const staged = path.join(stagingParent, path.basename(current));
  const extractionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-terminal-source-'));
  const backup = `${current}.backup-${process.pid}-${randomUUID()}`;
  fs.cpSync(current, staged, { recursive: true });
  fs.rmSync(options.semanticTraceRoot, { recursive: true, force: true });
  fs.mkdirSync(options.semanticTraceRoot, { recursive: true });
  const previousTraceRoot = process.env.KLAURO_SEMANTIC_DATASET_DIR;
  try {
    for (const member of members) await stageMember(member, fixtureDir, staged, extractionRoot, options.semanticTraceRoot, identity, options.dependencies.analyze);
    fsyncTree(staged);
    writeJournal(journalPath, { current, backup, staged, stagingParent });
    fs.renameSync(current, backup);
    fsyncPath(fixtureDir);
    fs.renameSync(staged, current);
    fsyncPath(fixtureDir);
    try {
      options.dependencies.runTerminalGate(options.repoRoot);
      fs.rmSync(backup, { recursive: true, force: true });
      fs.rmSync(journalPath, { force: true });
      fsyncPath(fixtureDir);
    } catch (error) {
      recoverTerminalReceiptPublication(journalPath);
      throw error;
    }
  } finally {
    if (previousTraceRoot === undefined) delete process.env.KLAURO_SEMANTIC_DATASET_DIR;
    else process.env.KLAURO_SEMANTIC_DATASET_DIR = previousTraceRoot;
    if (fs.existsSync(journalPath)) recoverTerminalReceiptPublication(journalPath);
    fs.rmSync(stagingParent, { recursive: true, force: true });
    fs.rmSync(extractionRoot, { recursive: true, force: true });
  }
}
