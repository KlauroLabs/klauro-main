import test from 'node:test';
import assert from 'node:assert/strict';
import type { CASOutput } from '../../../../packages/analyzer-core/src/types/cas.types';
import {
  ENTERPRISE_SURFACES,
  assertEnterpriseHostedProofUrl,
  collectionOmissions,
  enterpriseAppFiles,
  enterpriseInfraFiles,
  logicalCasHash,
  runEnterpriseHostedParityProof,
  unrelatedNodeOmissions,
  workspaceNarrativeWithoutMemberNames,
} from './enterprise-hosted-parity';

test('enterprise corpus explicitly covers every requested language/framework/library surface', () => {
  assert.deepEqual(ENTERPRISE_SURFACES.map(surface => surface.name), [
    'typescript-express-react-prisma',
    'python-fastapi-sqlalchemy',
    'java-spring',
    'csharp-aspnet',
    'go-gin',
    'rust-axum',
    'php-laravel',
    'dart-flutter',
    'shell-terraform-containers-kubernetes',
  ]);
  const files = { ...enterpriseAppFiles(), ...enterpriseInfraFiles() };
  for (const required of [
    'src/server.ts', 'python/api.py', 'java/src/main/java/proof/EnterpriseController.java',
    'dotnet/Controllers/EnterpriseOrdersController.cs', 'go/main.go', 'rust/src/main.rs',
    'php/routes/web.php', 'dart/lib/main.dart', 'deploy.sh', 'main.tf', 'Dockerfile',
    'docker-compose.yml', 'k8s/deployment.yaml',
  ]) assert.ok(required in files, `missing generated fixture ${required}`);
});

test('logical CAS hash ignores process metadata and collection ordering, but detects omissions', () => {
  const base = {
    cas_version: 'proof', analysis_id: 'one', analysis_timestamp: '2026-01-01T00:00:00Z',
    system: { id: 'system-proof', name: 'proof', type: 'application', root_path: '/tmp/one', technologies: { languages: [{ name: 'TypeScript' }] }, quality: {} },
    nodes: [
      { id: 'b', name: 'beta', type: 'function', source: { file: 'src/b.ts', line: 1 } },
      { id: 'a', name: 'alpha', type: 'function', source: { file: 'src/a.ts', line: 1 } },
    ],
    edges: [{ id: 'edge', source: 'a', target: 'b', type: 'calls' }],
    entry_points: [], exit_points: [], analyzer_contributions: [],
  } as unknown as CASOutput;
  const reordered = {
    ...base,
    analysis_id: 'two',
    analysis_timestamp: '2026-02-02T00:00:00Z',
    nodes: [...base.nodes].reverse(),
  } as CASOutput;
  assert.equal(logicalCasHash(base), logicalCasHash(reordered));
  assert.deepEqual(unrelatedNodeOmissions(base, reordered, []), []);
  const omitted = { ...reordered, nodes: reordered.nodes.filter(node => node.id !== 'b') } as CASOutput;
  assert.equal(unrelatedNodeOmissions(base, omitted, []).length, 1);
  assert.equal(unrelatedNodeOmissions(base, omitted, ['src/b.ts']).length, 0);
  assert.deepEqual(collectionOmissions(base, omitted), ['nodes:2->1']);
});

test('enterprise proof refuses local or insecure analysis endpoints', () => {
  const previous = process.env.KLAURO_ENTERPRISE_HOSTED_PROOF;
  process.env.KLAURO_ENTERPRISE_HOSTED_PROOF = '1';
  try {
    assert.throws(() => assertEnterpriseHostedProofUrl('http://mcp.example.com'), /HTTPS hosted analyzer/);
    assert.throws(() => assertEnterpriseHostedProofUrl('https://localhost:3000'), /refuses loopback\/local analyzers/);
    assert.equal(assertEnterpriseHostedProofUrl('https://mcp.klauro.com/'), 'https://mcp.klauro.com');
  } finally {
    if (previous === undefined) delete process.env.KLAURO_ENTERPRISE_HOSTED_PROOF;
    else process.env.KLAURO_ENTERPRISE_HOSTED_PROOF = previous;
  }
});

test('workspace semantic lint ignores stack words inside proper member names only', () => {
  const workspace = {
    name: 'Enterprise Hosted Proof',
    workspace_narrative: { title: 'Enterprise Hosted Proof workspace analysis' },
    codebases: [{ name: 'enterprise-polyglot-app' }],
    applications: [],
  };
  const properNameOnly = workspaceNarrativeWithoutMemberNames(
    workspace,
    'The Enterprise Polyglot App retrieves and presents enterprise orders for review.',
  );
  assert.doesNotMatch(properNameOnly, /polyglot/i);
  const implementationFrame = workspaceNarrativeWithoutMemberNames(
    workspace,
    'The Enterprise Polyglot App uses a polyglot technology stack to support development needs.',
  );
  assert.match(implementationFrame, /polyglot technology stack/i);
});

test('LIVE VPS: hosted enterprise parity, incrementality, completeness, and performance', {
  skip: process.env.KLAURO_ENTERPRISE_HOSTED_PROOF !== '1',
  timeout: 40 * 60_000,
}, async () => {
  const report = await runEnterpriseHostedParityProof();
  assert.equal(report.status, 'pass');
  assert.equal(report.surfaces_proven.length, ENTERPRISE_SURFACES.length);
  assert.equal(report.phases.length, 7);
});
