jest.unmock('fs-extra');
jest.unmock('fs');
jest.unmock('glob');

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ReactAnalyzer } from '../../analyzer/frameworks/web/react-analyzer';

/**
 * Frontend-depth coverage: a parent component rendering two children with
 * props, plus an onClick binding, must surface as:
 *  - `renders` edges for the composition graph (parent -> each child)
 *  - `props_passed` on those edges (prop pass-down / data flow)
 *  - an `event` entry point for the onClick binding (a real flow root)
 *  - a `triggers` edge when the handler name resolves to a declared util
 */
describe('ReactAnalyzer: component-tree depth (render edges, props, event entry points)', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'react-frontend-depth-'));
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'fixture', dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' } })
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const write = (relative: string, content: string) => {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };

  it('emits render-tree edges with prop pass-down and an onClick event entry point', async () => {
    write(
      'src/utils/handlers.ts',
      `export function handleSave() {\n  return true;\n}\n`
    );

    write(
      'src/Parent.tsx',
      [
        "import React from 'react';",
        "import { ChildA } from './ChildA';",
        "import { ChildB } from './ChildB';",
        "import { handleSave } from './utils/handlers';",
        '',
        'export function Parent() {',
        "  const [count, setCount] = useState(0);",
        '  return (',
        '    <div>',
        '      <ChildA label="hello" count={count} />',
        '      <ChildB onSave={handleSave} />',
        '      <button onClick={handleSave}>Save</button>',
        '    </div>',
        '  );',
        '}',
      ].join('\n')
    );

    write(
      'src/ChildA.tsx',
      [
        "import React from 'react';",
        'export function ChildA({ label, count }: { label: string; count: number }) {',
        '  return <span>{label}: {count}</span>;',
        '}',
      ].join('\n')
    );

    write(
      'src/ChildB.tsx',
      [
        "import React from 'react';",
        'export function ChildB({ onSave }: { onSave: () => void }) {',
        '  return <button onClick={onSave}>Save from child</button>;',
        '}',
      ].join('\n')
    );

    const analyzer = new ReactAnalyzer();
    const cas: any = await analyzer.analyze({ projectPath: root } as any);

    const componentNode = (name: string) => cas.nodes.find((n: any) => n.name === name && (n.type === 'functional_component' || n.type === 'class_component'));
    const parent = componentNode('Parent');
    const childA = componentNode('ChildA');
    const childB = componentNode('ChildB');
    expect(parent).toBeTruthy();
    expect(childA).toBeTruthy();
    expect(childB).toBeTruthy();

    // Render-tree edges: Parent renders both children.
    const rendersFromParent = (cas.edges || []).filter((e: any) => e.type === 'renders' && e.source === parent!.id);
    const renderedTargets = rendersFromParent.map((e: any) => e.target);
    expect(renderedTargets).toEqual(expect.arrayContaining([childA!.id, childB!.id]));

    // Prop pass-down captured on the renders edge to ChildA.
    const edgeToChildA = rendersFromParent.find((e: any) => e.target === childA!.id);
    expect(edgeToChildA?.metadata?.props_passed).toEqual(expect.arrayContaining(['label', 'count']));

    // Event entry points: the button's onClick in Parent AND ChildB's onClick.
    const clickEntries = (cas.entry_points || []).filter((ep: any) => ep.type === 'event' && ep.trigger?.pattern === 'click');
    expect(clickEntries.length).toBeGreaterThanOrEqual(2);

    const parentClickEntry = clickEntries.find((ep: any) => ep.metadata?.component === 'Parent');
    expect(parentClickEntry).toBeTruthy();
    expect(parentClickEntry?.metadata?.handler_name).toBe('handleSave');

    // The Parent's onClick={handleSave} resolves a `triggers` edge to the
    // handleSave util (imported from ./handlers) since it's a bare identifier
    // matching a known util export.
    const handleSaveUtil = cas.nodes.find((n: any) => n.name === 'handleSave');
    expect(handleSaveUtil).toBeTruthy();
    const triggersEdge = (cas.edges || []).find((e: any) => e.type === 'triggers' && e.target === handleSaveUtil!.id);
    expect(triggersEdge).toBeTruthy();

    // ChildB's onClick={onSave} is a prop-forwarded callback, not a bare
    // resolvable name in this file's own declarations — still captured as an
    // event entry point, without a fabricated handler target.
    const childBClickEntry = clickEntries.find((ep: any) => ep.metadata?.component === 'ChildB');
    expect(childBClickEntry).toBeTruthy();
  });
});
