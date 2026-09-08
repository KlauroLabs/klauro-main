jest.unmock('fs-extra');
jest.unmock('fs');
jest.unmock('glob');

import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { ReactAnalyzer } from '../../analyzer/frameworks/web/react-analyzer';

describe('React incremental evidence', () => {
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
