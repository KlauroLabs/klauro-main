import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { analyzeForBench } from './product-analysis';
import {
  runTerminalCapabilityGate,
  type RepoCapabilityFacts,
} from './terminal-capability-gate';
import type { CASCompositionRelation } from '../../../../packages/analyzer-core/src/analyzer/core/cas-composition';

const fixturePath = path.join(__dirname, 'fixtures/terminality-public-corpus.json');

function analyzerSourceDigest(repoRoot: string): { digest: string; fileCount: number } {
  const files: string[] = [];
  const visit = (absolutePath: string) => {
    const stat = fs.statSync(absolutePath);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolutePath).sort()) visit(path.join(absolutePath, name));
      return;
    }
    const relativePath = path.relative(repoRoot, absolutePath).split(path.sep).join('/');
    if (relativePath.includes('/__tests__/') || /\.(test|spec)\.ts$/.test(relativePath)) return;
    files.push(relativePath);
  };
  visit(path.join(repoRoot, 'packages/analyzer-core/src'));
  visit(path.join(repoRoot, 'apps/mcp-server/src/analyzer.ts'));
  const hash = createHash('sha256');
  for (const relativePath of files.sort()) {
    hash.update(relativePath);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(repoRoot, relativePath)));
    hash.update('\0');
  }
  return { digest: hash.digest('hex'), fileCount: files.length };
}

function repo(repoId: string, capabilityId: string): RepoCapabilityFacts {
  return {
    repoId,
    knownNodeIds: [`node:${repoId}`],
    knownFlowIds: [`flow:${repoId}`],
    capabilities: [{
      id: capabilityId,
      name: `Outcome ${repoId}`,
      sourceNodeIds: [`node:${repoId}`],
      sourceFlowIds: [`flow:${repoId}`],
    }],
  };
}

test('absorbs upstream child claims and preserves terminal claims using only structural relations', () => {
  const relations: CASCompositionRelation[] = [
    { id: 'relation:a-b', source_cas_id: 'a', target_cas_id: 'b', type: 'feeds', confidence: 0.8, evidence: ['edge:a-b'] },
  ];
  const result = runTerminalCapabilityGate([repo('a', 'capability:a'), repo('b', 'capability:b')], relations);
  assert.equal(result.pass, true);
  assert.deepEqual(result.substrateRepoIds, ['a']);
  assert.deepEqual(result.terminalRepoIds, ['b']);
  assert.deepEqual(result.composedCapabilities.map(item => item.id), ['capability:b']);
  assert.deepEqual(result.absorbedCapabilities.map(item => item.id), ['capability:a']);
  assert.equal(result.absorbedCapabilities[0].provenance.disposition, 'absorbed');
  assert.deepEqual(result.absorbedCapabilities[0].provenance.relation_path.map(item => item.relation_id), ['relation:a-b']);
  assert.equal(result.composedCapabilities[0].provenance.source_child_id, 'b');
  assert.deepEqual(result.composedCapabilities[0].provenance.relation_path.map(item => item.relation_id), ['relation:a-b']);
});

test('recomputes terminality recursively rather than copying a child verdict into its parent', () => {
  const leaf = runTerminalCapabilityGate(
    [repo('a', 'capability:a'), repo('b', 'capability:b')],
    [{ id: 'relation:a-b', source_cas_id: 'a', target_cas_id: 'b', type: 'feeds', evidence: ['edge:a-b'] }],
  );
  const middle: RepoCapabilityFacts = {
    repoId: 'middle',
    knownNodeIds: leaf.composedCapabilities.flatMap(item => item.provenance.source_node_ids),
    knownFlowIds: leaf.composedCapabilities.flatMap(item => item.provenance.source_flow_ids),
    capabilities: leaf.composedCapabilities.map(item => ({
      id: item.id,
      name: item.name,
      sourceNodeIds: item.provenance.source_node_ids,
      sourceFlowIds: item.provenance.source_flow_ids,
    })),
  };
  const parent = runTerminalCapabilityGate(
    [middle, repo('c', 'capability:c')],
    [{ id: 'relation:middle-c', source_cas_id: 'middle', target_cas_id: 'c', type: 'feeds', evidence: ['edge:middle-c'] }],
  );
  assert.deepEqual(parent.substrateRepoIds, ['middle']);
  assert.deepEqual(parent.composedCapabilities.map(item => item.id), ['capability:c']);
});

test('fails closed when a promoted claim cites a node or flow absent from its source child', () => {
  const invalid = repo('leaf', 'capability:leaf');
  invalid.capabilities[0].sourceNodeIds = ['node:fabricated'];
  const result = runTerminalCapabilityGate([invalid], []);
  assert.equal(result.pass, false);
  assert.match(result.violations[0], /outside its source CAS/);
  assert.equal(result.composedCapabilities.length, 0);
});

test('real public package and app corpus uses production-emitted capabilities with source-backed provenance', async () => {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
    corpus: Array<{
      repoId: string;
      packageName: string;
      source: string;
      license: string;
      archive: string;
      archiveSha256: string;
      root: string;
      sourceFile: string;
      sourceSha256: string;
      receipt?: string;
    }>;
    relations: CASCompositionRelation[];
  };
  const extractionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-terminal-corpus-'));
  const analyzedByRepo = new Map<string, {
    facts: RepoCapabilityFacts;
    nodeIds: Set<string>;
    flowIds: Set<string>;
    capabilityIds: Set<string>;
    packageManifest: Record<string, unknown>;
    packageLock?: Record<string, unknown>;
  }>();
  const previousAiEnabled = process.env.KLAURO_AI_ENABLED;
  process.env.KLAURO_AI_ENABLED = 'false';
  try {
    for (const item of fixture.corpus) {
      assert.match(item.source, /^https:\/\//);
      assert.ok(item.license === 'MIT' || item.license === 'BSD-3-Clause');
      const archivePath = path.join(path.dirname(fixturePath), item.archive);
      const archiveBytes = fs.readFileSync(archivePath);
      assert.equal(createHash('sha256').update(archiveBytes).digest('hex'), item.archiveSha256);
      const memberRoot = path.join(extractionRoot, item.repoId.replace(/[^a-z0-9]+/gi, '-'));
      fs.mkdirSync(memberRoot, { recursive: true });
      execFileSync('tar', ['-xzf', archivePath, '-C', memberRoot]);
      const packageRoot = path.join(memberRoot, item.root);
      const sourceBytes = fs.readFileSync(path.join(packageRoot, item.sourceFile));
      assert.equal(createHash('sha256').update(sourceBytes).digest('hex'), item.sourceSha256);
      const packageManifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
      const packageLockPath = path.join(packageRoot, 'package-lock.json');
      const packageLock = fs.existsSync(packageLockPath)
        ? JSON.parse(fs.readFileSync(packageLockPath, 'utf8'))
        : undefined;
      const analyzed = await analyzeForBench(packageRoot);
      const nodeIds = new Set(analyzed.nodes.map(node => node.id));
      const flowIds = new Set((analyzed.flows || []).map(flow => flow.flow_id));
      let capabilities: RepoCapabilityFacts['capabilities'] = [];
      let capabilityIds = new Set<string>();

      if (item.receipt) {
        const receiptPath = path.join(path.dirname(fixturePath), item.receipt);
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as {
          schema_version: string;
          source: {
            repository: string;
            commit: string;
            license: string;
            archive: string;
            archive_sha256: string;
            root: string;
            file_sha256: Record<string, string>;
          };
          analysis: {
            analysis_id: string;
            analysis_timestamp: string;
            analyzer_build: string;
            analyzer_source_base_commit: string;
            analyzer_source_sha256: string;
            analyzer_source_file_count: number;
            production_cas: string;
            production_cas_sha256: string;
            capabilities_sha256: string;
            provider: string;
            model: string;
            prompt_version: string;
            semantic_schema_version: string;
            semantic_trace: string;
            semantic_trace_sha256: string;
            ai_cache: string;
            parser_fingerprint: string;
            derived_fingerprint: string;
          };
          repo_id: string;
          known_node_ids: string[];
          known_flow_ids: string[];
          capabilities: Array<{
            capability: Record<string, unknown> & { id: string; name: string };
            source_node_ids: string[];
            source_flow_ids: string[];
          }>;
        };
        assert.equal(receipt.schema_version, 'terminality-public-corpus-receipt.v1');
        assert.equal(receipt.repo_id, item.repoId);
        assert.equal(receipt.source.archive, path.basename(item.archive));
        assert.equal(receipt.source.archive_sha256, item.archiveSha256);
        assert.equal(receipt.source.root, item.root);
        assert.equal(receipt.source.license, item.license);
        assert.ok(receipt.analysis.analysis_id);
        assert.ok(receipt.analysis.analysis_timestamp);
        assert.match(receipt.analysis.analyzer_source_base_commit, /^[0-9a-f]{40}$/);
        const repoRoot = path.resolve(__dirname, '../../../..');
        const sourceIdentity = analyzerSourceDigest(repoRoot);
        assert.equal(receipt.analysis.analyzer_source_sha256, sourceIdentity.digest);
        assert.equal(receipt.analysis.analyzer_source_file_count, sourceIdentity.fileCount);
        assert.equal(receipt.analysis.analyzer_build, `source-sha256:${sourceIdentity.digest}`);
        assert.equal(receipt.analysis.provider, 'deepinfra');
        assert.equal(receipt.analysis.model, 'Qwen/Qwen3-Next-80B-A3B-Instruct');
        assert.equal(receipt.analysis.prompt_version, 'capability_catalog.v2');
        assert.equal(receipt.analysis.semantic_schema_version, 'e1.1');
        assert.equal(receipt.analysis.ai_cache, 'disabled');
        assert.ok(receipt.analysis.parser_fingerprint);
        assert.ok(receipt.analysis.derived_fingerprint);
        const fixtureDirectory = path.dirname(receiptPath);
        const productionCasBytes = fs.readFileSync(path.join(fixtureDirectory, receipt.analysis.production_cas));
        assert.equal(createHash('sha256').update(productionCasBytes).digest('hex'), receipt.analysis.production_cas_sha256);
        const productionCas = JSON.parse(gunzipSync(productionCasBytes).toString('utf8')) as {
          nodes: Array<{ id: string }>;
          flows?: Array<{ flow_id: string }>;
          capabilities: Array<Record<string, unknown> & { id: string; name: string }>;
        };
        const receiptCapabilityPayload = receipt.capabilities.map(itemCapability => itemCapability.capability);
        assert.equal(
          createHash('sha256').update(JSON.stringify(receiptCapabilityPayload)).digest('hex'),
          receipt.analysis.capabilities_sha256,
        );
        assert.deepEqual(receiptCapabilityPayload, productionCas.capabilities);
        assert.deepEqual(receipt.known_node_ids, productionCas.nodes.map(node => node.id).sort());
        assert.deepEqual(receipt.known_flow_ids, (productionCas.flows || []).map(flow => flow.flow_id).sort());
        const semanticTraceBytes = fs.readFileSync(path.join(fixtureDirectory, receipt.analysis.semantic_trace));
        assert.equal(createHash('sha256').update(semanticTraceBytes).digest('hex'), receipt.analysis.semantic_trace_sha256);
        const semanticDecisions = semanticTraceBytes.toString('utf8').trim().split('\n').map(line => JSON.parse(line));
        assert.ok(semanticDecisions.some(decision => decision.schema_version === receipt.analysis.semantic_schema_version
          && decision.provider === receipt.analysis.provider
          && decision.model === receipt.analysis.model));
        assert.ok(semanticDecisions.some(decision => decision.prompt_version === receipt.analysis.prompt_version));
        for (const [relativeFile, expectedHash] of Object.entries(receipt.source.file_sha256)) {
          const bytes = fs.readFileSync(path.join(packageRoot, relativeFile));
          assert.equal(createHash('sha256').update(bytes).digest('hex'), expectedHash);
        }
        assert.ok(receipt.capabilities.length > 0, 'production analysis receipt must contain published analyzed.capabilities');
        const receiptNodeIds = new Set(receipt.known_node_ids);
        const receiptFlowIds = new Set(receipt.known_flow_ids);
        capabilities = receipt.capabilities.map(itemCapability => {
          assert.ok(itemCapability.capability.id);
          assert.ok(itemCapability.capability.name);
          assert.ok(itemCapability.source_node_ids.length + itemCapability.source_flow_ids.length > 0);
          for (const id of itemCapability.source_node_ids) {
            assert.ok(receiptNodeIds.has(id), `receipt capability node evidence ${id} must exist in its produced CAS`);
            assert.ok(nodeIds.has(id), `fresh structural analysis must reproduce node evidence ${id}`);
          }
          for (const id of itemCapability.source_flow_ids) {
            assert.ok(receiptFlowIds.has(id), `receipt capability flow evidence ${id} must exist in its produced CAS`);
            assert.ok(flowIds.has(id), `fresh structural analysis must reproduce flow evidence ${id}`);
          }
          return {
            id: itemCapability.capability.id,
            name: itemCapability.capability.name,
            sourceNodeIds: itemCapability.source_node_ids,
            sourceFlowIds: itemCapability.source_flow_ids,
          };
        });
        capabilityIds = new Set(receipt.capabilities.map(itemCapability => itemCapability.capability.id));
      }

      analyzedByRepo.set(item.repoId, {
        nodeIds,
        flowIds,
        capabilityIds,
        packageManifest,
        packageLock,
        facts: {
          repoId: item.repoId,
          knownNodeIds: [...nodeIds],
          knownFlowIds: [...flowIds],
          capabilities,
        },
      });
    }
  } finally {
    if (previousAiEnabled === undefined) delete process.env.KLAURO_AI_ENABLED;
    else process.env.KLAURO_AI_ENABLED = previousAiEnabled;
    fs.rmSync(extractionRoot, { recursive: true, force: true });
  }

  const bodyParser = analyzedByRepo.get('npm:body-parser@1.20.1')!;
  assert.equal((bodyParser.packageManifest.dependencies as Record<string, string>).qs, '6.11.0');
  const todoJobs = analyzedByRepo.get('github:Babadinho/todo-jobs@c7c139a966ee5eafa49066a89222b56ba8233c27')!;
  const lockedDependencies = (todoJobs.packageLock?.dependencies || {}) as Record<string, { version?: string }>;
  assert.equal(lockedDependencies['body-parser']?.version, '1.20.1');

  const facts = fixture.corpus.map(item => analyzedByRepo.get(item.repoId)!.facts);
  const result = runTerminalCapabilityGate(facts, fixture.relations);
  assert.equal(result.pass, true, result.violations.join('\n'));
  assert.ok(result.substrateRepoIds.length > 0);
  assert.ok(result.terminalRepoIds.length > 0);
  assert.ok(result.composedCapabilities.length > 0);
  for (const capability of [...result.composedCapabilities, ...result.absorbedCapabilities]) {
    const source = analyzedByRepo.get(capability.fromRepoId)!;
    assert.ok(source.capabilityIds.has(capability.provenance.source_capability_id));
    assert.ok(capability.provenance.source_node_ids.every(id => source.nodeIds.has(id)));
    assert.ok(capability.provenance.source_flow_ids.every(id => source.flowIds.has(id)));
  }
});
