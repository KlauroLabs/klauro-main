import { relativizeProjectPaths } from '../../analyzer/core/relativize-project-paths';
import type { CASOutput } from '../../types/cas.types';

const ROOT = '/Users/example/dev/clients/acme/portal';

function buildOutput(): CASOutput {
  return {
    system: {
      root_path: ROOT,
      name: 'portal',
    },
    nodes: [
      {
        id: 'node_a',
        source: {
          file: `${ROOT}/src/App.tsx`,
          line: 1,
          raw: `// helper for ${ROOT}/src/App.tsx\nexport const a = 1;\n`,
        },
        metadata: {
          comments: [{ file: `${ROOT}/vite.config.ts`, text: 'TODO: tighten types' }],
        },
      },
      {
        id: 'node_b',
        source: { file: 'src/relative/Already.tsx', line: 3 },
      },
    ],
    intents: [
      {
        architectural_decision: {
          evidence: [{ source: `${ROOT}/src/components/Search.tsx` }],
        },
      },
    ],
    codebase_idioms: [
      {
        affected_scopes: { files: [`${ROOT}/src/utils/displayRole.ts`, 'src/utils/other.ts'] },
      },
    ],
    cross_repository_links: [
      { source_repository: { path: '/Users/example/dev/clients/acme/other-repo' } },
    ],
  } as unknown as CASOutput;
}

describe('relativizeProjectPaths', () => {
  it('rewrites absolute project paths to project-relative paths everywhere except system.root_path', async () => {
    const output = buildOutput();
    await relativizeProjectPaths(output, ROOT);

    expect(output.system.root_path).toBe(ROOT);
    expect((output.nodes[0].source as any).file).toBe('src/App.tsx');
    expect((output.nodes[0] as any).metadata.comments[0].file).toBe('vite.config.ts');
    expect((output as any).intents[0].architectural_decision.evidence[0].source).toBe('src/components/Search.tsx');
    expect((output as any).codebase_idioms[0].affected_scopes.files).toEqual([
      'src/utils/displayRole.ts',
      'src/utils/other.ts',
    ]);
  });

  it('leaves relative paths, foreign absolute paths, and multi-line code text untouched', async () => {
    const output = buildOutput();
    await relativizeProjectPaths(output, ROOT);

    expect((output.nodes[1].source as any).file).toBe('src/relative/Already.tsx');
    expect((output as any).cross_repository_links[0].source_repository.path).toBe(
      '/Users/example/dev/clients/acme/other-repo',
    );
    expect((output.nodes[0].source as any).raw).toContain(`${ROOT}/src/App.tsx`);
  });

  it('is idempotent and safe for a root of the filesystem separator', async () => {
    const output = buildOutput();
    await relativizeProjectPaths(output, ROOT);
    await relativizeProjectPaths(output, ROOT);
    expect((output.nodes[0].source as any).file).toBe('src/App.tsx');

    const untouched = buildOutput();
    await relativizeProjectPaths(untouched, '/');
    expect((untouched.nodes[0].source as any).file).toBe(`${ROOT}/src/App.tsx`);
  });
});
