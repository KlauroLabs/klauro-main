import test from 'node:test';
import assert from 'node:assert/strict';
import { selectRepresentativeRepos } from './analysis-output-cold-review';

test('cold output review samples large apps, infra, libraries, small repos, and Klauro itself', () => {
  const repos: any[] = [
    repo('api-a', '/dev/api-a', 'backend-service', 500),
    repo('ui-a', '/dev/ui-a', 'frontend-app', 400),
    repo('desktop-a', '/dev/desktop-a', 'desktop-app', 300),
    repo('infra-a', '/dev/infra-a', 'infrastructure', 90),
    repo('infra-b', '/dev/infra-b', 'infrastructure', 80),
    repo('infra-c', '/dev/infra-c', 'infrastructure', 70),
    repo('lib-a', '/dev/lib-a', 'library-package', 120),
    repo('lib-b', '/dev/lib-b', 'library-package', 110),
    repo('lib-c', '/dev/lib-c', 'library-package', 100),
    repo('tiny-a', '/dev/tiny-a', 'cli-tool', 5),
    repo('tiny-b', '/dev/tiny-b', 'worker-service', 10),
    repo('tiny-c', '/dev/tiny-c', 'backend-service', 20),
    repo('proof-of-concept', '/Users/michaelshattuck/dev/unravl/proof-of-concept', 'backend-service', 250),
  ];

  const selected = selectRepresentativeRepos(repos);
  const paths = selected.map(item => item.path);

  assert.ok(paths.includes('/dev/api-a'));
  assert.ok(paths.includes('/dev/infra-a'));
  assert.ok(paths.includes('/dev/lib-a'));
  assert.ok(paths.includes('/dev/tiny-a'));
  assert.ok(paths.includes('/Users/michaelshattuck/dev/unravl/proof-of-concept'));
});

function repo(name: string, repoPath: string, kind: string, sourceFiles: number) {
  return {
    name,
    path: repoPath,
    status: 'eligible',
    source_files: sourceFiles,
    proof_status: 'pass',
    cas: {
      nodes: sourceFiles * 3,
      capabilities: 3,
      codebase_idioms: 2,
      behavioral_invariants: 1,
      primary_domain: 'example-domain',
      description_source: 'ai',
      description_generation: { attempted: true, status: 'ai_applied' },
    },
    usefulness_review: {
      status: 'pass',
      score: 96,
      profile: { kind },
      gates: [
        { id: 'description-quality', status: 'pass', score: 95, detail: 'good' },
        { id: 'architecture-agent-context', status: 'pass', score: 95, detail: 'good' },
      ],
      summary: {
        agent_context_tokens: 1200,
        agent_context_files: 2,
      },
    },
  };
}
