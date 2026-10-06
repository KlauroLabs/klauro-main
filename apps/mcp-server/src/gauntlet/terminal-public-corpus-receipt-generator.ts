import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { CASOutput, SystemCapability } from '../../../../packages/analyzer-core/src/types/cas.types';
import { computeDerivedFingerprintForRoot, computeParserFingerprintForRoot } from '../../../../packages/analyzer-core/src/analyzer/core/stage-fingerprint';

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
export interface AnalyzerSourceIdentity { commit: string; parserFingerprint: string; derivedFingerprint: string; }
export interface AuthorIdentity { endpoint: string; models: string[]; }
export interface ReceiptGeneratorDependencies {
  analyze(root: string): Promise<CASOutput>;
  resolveSourceIdentity(root: string): AnalyzerSourceIdentity;
  runTerminalGate(root: string): void;
}
export interface ReceiptGeneratorOptions {
  repoRoot: string;
  fixturePath: string;
  answerRoot: string;
  dependencies: ReceiptGeneratorDependencies;
  env?: NodeJS.ProcessEnv;
}

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

export function assertTerminalReceiptEnvironment(env: NodeJS.ProcessEnv): void {
  const exact: Record<string, string> = {
    KLAURO_AI_INTERPRETATION_ALLOW_DETERMINISTIC_KEEP: 'false',
    KLAURO_FORCE_AI_REFRESH: '1',
    KLAURO_BENCH_FORCE_ANALYSIS: '1',
  };
  if (!env.KLAURO_AUTHOR_ENDPOINT) throw new Error('KLAURO_AUTHOR_ENDPOINT is required');
  if (!/^https:\/\//.test(env.KLAURO_AUTHOR_ENDPOINT)) throw new Error('KLAURO_AUTHOR_ENDPOINT must be an https URL');
  if (!env.KLAURO_AUTHOR_KEY) throw new Error('KLAURO_AUTHOR_KEY is required');
  if (env.DEEPINFRA_API_KEY) throw new Error('DEEPINFRA_API_KEY must not be set: receipts are authored through the Klauro author endpoint');
  if (env.KLAURO_AI_INTERPRETATION === 'false') throw new Error('KLAURO_AI_INTERPRETATION must not be false');
  if (!env.KLAURO_AI_CACHE_PATH) throw new Error('KLAURO_AI_CACHE_PATH is required');
  for (const [name, expected] of Object.entries(exact)) {
    if (env[name] !== expected) throw new Error(`${name} must equal ${expected}`);
  }
}

export function resolveTerminalReceiptSourceIdentity(repoRoot: string): AnalyzerSourceIdentity {
  const analyzerCoreRoot = path.join(repoRoot, 'packages/analyzer-core');
  const identityPaths = [
    'apps/mcp-server/src/gauntlet/fixtures/terminality-public-corpus.json',
    'apps/mcp-server/src/gauntlet/fixtures/terminality-public-corpus',
  ];
  const changedIdentityFiles = execFileSync('git', ['diff-index', '--name-only', 'HEAD', '--', ...identityPaths], { cwd: repoRoot, encoding: 'utf8' });
  if (changedIdentityFiles.trim()) throw new Error('Terminal corpus identity paths must match HEAD');
  const untrackedIdentityFiles = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', ...identityPaths], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (untrackedIdentityFiles.trim()) throw new Error('Terminal corpus identity paths contain untracked files');
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('Terminal corpus receipt generation requires an exact 40-character commit');
  return {
    commit,
    parserFingerprint: computeParserFingerprintForRoot(analyzerCoreRoot),
    derivedFingerprint: computeDerivedFingerprintForRoot(analyzerCoreRoot),
  };
}

function answeredFolder(answerRoot: string): string {
  return path.join(answerRoot, 'model-answers');
}

export function readAuthorIdentity(env: NodeJS.ProcessEnv, answerRoot: string): AuthorIdentity {
  const endpoint = new URL(env.KLAURO_AUTHOR_ENDPOINT || '');
  const folder = answeredFolder(answerRoot);
  const models = new Set<string>();
  const files = fs.existsSync(folder) ? fs.readdirSync(folder) : [];
  for (const file of files) {
    const held = fs.readFileSync(path.join(folder, file), 'utf8');
    const answered = held.slice(held.indexOf('\0') + 1);
    try {
      const model = (JSON.parse(answered) as { model?: unknown }).model;
      if (typeof model === 'string' && model) models.add(model);
    } catch { continue; }
  }
  if (!models.size) throw new Error('The author endpoint answered nothing that names its model');
  return { endpoint: `${endpoint.origin}${endpoint.pathname}`, models: [...models].sort() };
}

function evidenceFor(capability: SystemCapability, nodes: Set<string>, flows: Set<string>) {
  const provenance = capability.composition_provenance || [];
  const source_node_ids = [...new Set([
    ...(capability.operations || []).map(operation => operation.entry_point_id),
    ...provenance.flatMap(item => item.source_node_ids || []),
  ].filter((id): id is string => typeof id === 'string' && nodes.has(id)))].sort();
  const source_flow_ids = [...new Set([
    ...(capability.related_flows || []).map(flow => flow.flow_id),
    ...provenance.flatMap(item => item.source_flow_ids || []),
  ].filter(id => flows.has(id)))].sort();
  if (source_node_ids.length + source_flow_ids.length === 0) {
    throw new Error(`Capability ${capability.id} has no source evidence in its produced CAS`);
  }
  return { source_node_ids, source_flow_ids };
}

function validateStaged(output: CASOutput, receipt: any, casBytes: Buffer): void {
  if (sha256(casBytes) !== receipt.analysis.production_cas_sha256) throw new Error('Production CAS digest mismatch');
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
  answerRoot: string, identity: AnalyzerSourceIdentity, env: NodeJS.ProcessEnv, analyze: ReceiptGeneratorDependencies['analyze']): Promise<void> {
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
  fs.rmSync(answeredFolder(answerRoot), { recursive: true, force: true });
  const output = await analyze(projectRoot);
  if (output.analysis_errors?.length) throw new Error(`Analysis failed for ${member.repoId}: ${output.analysis_errors.join('; ')}`);
  if (!output.capabilities?.length) throw new Error(`Analysis emitted no capabilities for ${member.repoId}`);
  if (!output.analysis_id || !output.analysis_timestamp) throw new Error(`Analysis identity is incomplete for ${member.repoId}`);
  const author = readAuthorIdentity(env, answerRoot);
  const nodes = new Set(output.nodes.map(node => node.id));
  const flows = new Set((output.flows || []).map(flow => flow.flow_id));
  const capabilities = output.capabilities.map(capability => ({ capability, ...evidenceFor(capability, nodes, flows) }));
  const casBytes = gzipSync(JSON.stringify(output), { level: 9 });
  const relativeReceipt = member.receipt.replace(/^terminality-public-corpus\//, '');
  const stem = path.basename(relativeReceipt, '-receipt.json');
  const casName = `${stem}-cas.json.gz`;
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
      analyzer_build: `parser:${identity.parserFingerprint};derived:${identity.derivedFingerprint}`, analyzer_source_base_commit: identity.commit,
      production_cas: casName, production_cas_sha256: sha256(casBytes), capabilities_sha256: sha256(JSON.stringify(capabilities.map(item => item.capability))),
      author_endpoint: author.endpoint, author_models: author.models, ai_cache: 'disabled',
      parser_fingerprint: identity.parserFingerprint, derived_fingerprint: identity.derivedFingerprint },
    repo_id: member.repoId, known_node_ids: [...nodes].sort(), known_flow_ids: [...flows].sort(), capabilities,
  };
  validateStaged(output, receipt, casBytes);
  fs.writeFileSync(path.join(stagedBundle, casName), casBytes);
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
  fs.rmSync(options.answerRoot, { recursive: true, force: true });
  fs.mkdirSync(options.answerRoot, { recursive: true });
  try {
    for (const member of members) await stageMember(member, fixtureDir, staged, extractionRoot, options.answerRoot, identity, env, options.dependencies.analyze);
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
    if (fs.existsSync(journalPath)) recoverTerminalReceiptPublication(journalPath);
    fs.rmSync(stagingParent, { recursive: true, force: true });
    fs.rmSync(extractionRoot, { recursive: true, force: true });
  }
}
