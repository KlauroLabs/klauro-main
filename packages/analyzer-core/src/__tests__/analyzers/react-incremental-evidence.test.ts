jest.unmock('fs-extra');
jest.unmock('fs');
jest.unmock('glob');

import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { ReactAnalyzer } from '../../analyzer/frameworks/web/react-analyzer';
import { CASContribution } from '../../types/cas.types';
import { isRefreshableContribution, retainedContributionFieldsMatch } from '../../analyzer/core/incremental-contribution-refresh';

describe('React incremental evidence', () => {
  it('publishes the declarations referenced by full and incremental React evidence', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'react-perspective-evidence-'));
    try {
      await fs.writeJson(path.join(root, 'package.json'), { name: 'component-library', dependencies: { react: '^19.0.0' } });
      await fs.outputFile(path.join(root, 'src/Child.tsx'), 'export function Child() { return <span>Child</span>; }');
      const parentFile = path.join(root, 'src/Parent.tsx');
      await fs.outputFile(parentFile, "import { Child } from './Child';\nexport function Parent() { return <Child />; }");
      const analyzer = new ReactAnalyzer();
      const contribution = await analyzer.analyze({ projectPath: root });
      const declared = new Set(contribution.perspectives?.map(perspective => perspective.id));
      const assertReferencesResolve = (graph: Pick<CASContribution, 'nodes' | 'edges'>) => {
        const references = new Set([
          ...(graph.nodes || []).flatMap(node => Object.keys(node.perspectives || {})),
          ...(graph.edges || []).flatMap(edge => edge.perspectives || []),
        ]);
        expect(references.size).toBeGreaterThan(0);
        for (const id of references) expect(declared.has(id)).toBe(true);
      };
      assertReferencesResolve(contribution);
      expect([...declared].sort()).toEqual(['react-components', 'react-data', 'react-routing']);
      expect(contribution.provided_perspectives?.slice().sort()).toEqual([...declared].sort());
      await fs.writeFile(parentFile, "import { Child } from './Child';\nexport function Parent() { return <section><Child /></section>; }");
      const incremental = await analyzer.analyzeFileSingle({
        projectPath: root, filePath: parentFile, relativePath: 'src/Parent.tsx', existingAnalysis: [contribution],
      });
      assertReferencesResolve(incremental);
      expect(incremental.edges.some(edge => edge.type === 'renders')).toBe(true);
      const fresh = await analyzer.analyze({ projectPath: root });
      const fields = new Set(analyzer.incrementalSourceInvariantContributionFields());
      expect(isRefreshableContribution(fresh, fields)).toBe(true);
      expect(retainedContributionFieldsMatch(fresh, contribution, fields)).toBe(true);
      const changed = structuredClone(contribution);
      changed.perspectives![0].name += ' changed';
      expect(retainedContributionFieldsMatch(fresh, changed, fields)).toBe(false);
      expect(retainedContributionFieldsMatch(fresh, {}, fields)).toBe(false);
    } finally {
      await fs.remove(root);
    }
  });
  it('recomputes file extraction instead of hashing the upstream graph for cache lookup', () => {
    expect(new ReactAnalyzer().incrementalFileCachePolicy()).toBe('recompute');
  });

  it('preserves cross-file rendering evidence and observes in-place upstream source changes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'react-incremental-evidence-'));
    try {
      await fs.writeJson(path.join(root, 'package.json'), { name: 'component-library', dependencies: { react: '^19.0.0' } });
      await fs.ensureDir(path.join(root, 'src'));
      await fs.writeFile(path.join(root, 'src', 'Child.tsx'), "export function Child() { return <span>Child</span>; }");
      await fs.writeFile(path.join(root, 'src', 'Parent.tsx'), "import { Child } from './Child';\nexport function Parent() { return <Child />; }");
      const analyzer = new ReactAnalyzer();
      const contribution = await analyzer.analyze({ projectPath: root });
      const child = contribution.nodes!.find(node => node.name === 'Child' && node.type === 'functional_component')!;
      expect(child?.source?.file).toBeTruthy();
      const context = {
        projectPath: root,
        filePath: path.join(root, 'src', 'Parent.tsx'),
        relativePath: 'src/Parent.tsx',
        existingAnalysis: [contribution],
      };
      const initial = await analyzer.analyzeFileSingle(context);
      const parent = initial.nodes.find(node => node.name === 'Parent' && node.type === 'functional_component')!;
      expect(parent).toBeDefined();
      expect(initial.edges).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: parent.id, target: child.id, type: 'renders' }),
      ]));
      const originalFile = child.source!.file;
      child.source!.file = 'src/MovedChild.tsx';
      const changed = await analyzer.analyzeFileSingle(context);
      expect(changed.edges.some(edge => edge.source === parent.id && edge.target === child.id && edge.type === 'renders')).toBe(false);
      child.source!.file = originalFile;
      expect(await analyzer.analyzeFileSingle(context)).toEqual(initial);
    } finally {
      await fs.remove(root);
    }
  });
});
