jest.unmock('fs');
jest.unmock('fs-extra');
jest.unmock('glob');

import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { ReactAnalyzer } from '../../analyzer/frameworks/web/react-analyzer';

describe('React application identity', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => fs.remove(root)));
  });

  it('does not embed the hosted upload workspace path in the application node', async () => {
    const analyze = async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-react-identity-'));
      roots.push(root);
      await fs.writeJson(path.join(root, 'package.json'), {
        name: '@example/product',
        dependencies: { react: '19.0.0' },
      });
      await fs.ensureDir(path.join(root, 'src'));
      await fs.writeFile(path.join(root, 'src', 'App.tsx'), 'export function App() { return <main>Hello</main>; }');
      const result = await new ReactAnalyzer().analyze({ projectPath: root });
      return (result.nodes || []).find(node => node.type === 'react_app');
    };

    const first = await analyze();
    const second = await analyze();
    expect(first?.id).toBe(second?.id);
    expect(first?.source?.file).toBe('package.json');
  });
});
