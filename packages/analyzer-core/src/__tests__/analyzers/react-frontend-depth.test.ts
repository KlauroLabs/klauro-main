jest.unmock('fs-extra');
jest.unmock('fs');
jest.unmock('glob');

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ReactAnalyzer } from '../../analyzer/frameworks/web/react-analyzer';
import { TypeScriptJavaScriptAnalyzer } from '../../analyzer/languages/typescript-javascript-analyzer';
import { classifyCapabilityOperationEffect } from '../../analyzer/core/capability-operation-coverage';

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
      `export function handleSave() {\n  return fetch('/api/save');\n}\n`
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
        "  const [count, setCount] = useState(0);\n  const [recordDetails, setRecordDetails] = useState({});\n  const handleFetchRecord = async () => { const response = await fetch('/record'); setRecordDetails(await response.json()); };\n  const { isOpen, onOpen, onClose } = useDisclosure();\n  const dialog = useDisclosure();\n  const handleChange = (_field: string) => (_event: unknown) => setCount(count + 1);",
        '  return (',
        '    <div>',
        '      <ChildA label="hello" count={count} />',
        '      <ChildB onSave={handleSave} setValue={setCount} onClose={onClose} dialog={dialog} />',
        '      <button onClick={handleSave}>Save</button>\n      <button onClick={handleFetchRecord}>Fetch record</button>\n      <input onChange={handleChange(\'title\')} />\n      <button onClick={() => setCount(count + 1)}>Increment</button>\n      <button onClick={onOpen}>Open</button>\n      <button onClick={dialog.onClose}>Close dialog</button>',
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

    write('src/utils/callbacks.ts', 'export function onSave() { return false; }\n');

    write(
      'src/ChildB.tsx',
      [
        "import React from 'react';",
        'export function ChildB({ onSave, setValue, onClose, dialog }: { onSave: () => void; setValue: (value: number) => void; onClose: () => void; dialog: { onClose: () => void } }) {',
        '  return <form onSubmit={(event: { preventDefault: () => void }) => { event.preventDefault(); onSave(); }}><button onClick={onSave}>Save from child</button><input onChange={() => setValue(2)} /><button onClick={onClose}>Close</button><button onClick={() => { dialog.onClose(); setValue(3); }}>Close local dialog</button></form>;',
        '}',
      ].join('\n')
    );

    const languageAnalyzer = new TypeScriptJavaScriptAnalyzer();
    const languageCas: any = await languageAnalyzer.analyze({ projectPath: root } as any);
    const analyzer = new ReactAnalyzer();
    const cas: any = await analyzer.analyze({ projectPath: root, existingAnalysis: [languageCas] } as any);
    const completeCas = {
      nodes: [...languageCas.nodes, ...cas.nodes],
      edges: [...languageCas.edges, ...cas.edges],
      entryPoints: cas.entry_points,
      exitPoints: languageCas.exit_points
    };

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
    expect(parentClickEntry?.metadata?.handler_binding_node_ids).toHaveLength(1);
    const fetchRecordEntry = clickEntries.find((ep: any) => ep.metadata?.handler_name === 'handleFetchRecord');
    expect(fetchRecordEntry?.metadata?.interaction_label).toBe('Fetch record');
    expect(fetchRecordEntry?.metadata?.handler_state_target_names).toEqual(['recordDetails']);
    expect(fetchRecordEntry?.metadata?.handler_state_target_binding_node_ids).toHaveLength(1);
    expect(completeCas.edges.some((edge: any) => edge.type === 'calls' &&
      edge.source === fetchRecordEntry.metadata.handler_binding_node_ids[0] &&
      edge.target === fetchRecordEntry.metadata.handler_state_target_binding_node_ids[0] &&
      edge.metadata?.resolution === 'exact-handler-state-write')).toBe(true);

    const inlineStateEntry = clickEntries.find((ep: any) => ep.metadata?.handler_references?.some((reference: any) => reference.name === 'setCount'));
    expect(inlineStateEntry?.metadata?.local_handler_kind).toBe('state-setter');
    expect(inlineStateEntry?.metadata?.handler_name).toBeUndefined();
    expect(inlineStateEntry?.metadata?.handler_binding_node_ids).toHaveLength(1);
    expect(completeCas.nodes.find((node: any) => node.id === inlineStateEntry?.metadata?.handler_binding_node_ids?.[0])?.name).toContain('setCount');
    const disclosureEntry = clickEntries.find((ep: any) => ep.metadata?.handler_name === 'onOpen');
    expect(disclosureEntry?.metadata?.local_handler_kind).toBe('disclosure-controller');
    expect(disclosureEntry?.metadata?.handler_file).toBe('src/Parent.tsx');
    expect(disclosureEntry?.metadata?.handler_binding_node_ids).toHaveLength(1);
    const memberDisclosureEntry = clickEntries.find((ep: any) =>
      ep.metadata?.component === 'Parent' && ep.metadata?.handler_references?.some((reference: any) => reference.name === 'dialog.onClose'));
    expect(memberDisclosureEntry?.metadata?.local_handler_kind).toBe('disclosure-controller');
    expect(memberDisclosureEntry?.metadata?.handler_binding_node_ids).toHaveLength(1);
    expect((cas.edges || []).filter((edge: any) =>
      edge.source === memberDisclosureEntry?.id && edge.type === 'triggers'
    ).map((edge: any) => edge.target)).toEqual(memberDisclosureEntry?.metadata?.handler_binding_node_ids);

    const factoryEntry = (cas.entry_points || []).find((ep: any) => ep.metadata?.component === 'Parent' && ep.trigger?.pattern === 'change');
    expect(factoryEntry?.metadata?.handler_references).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'handleChange' })]));
    expect(factoryEntry?.metadata?.handler_binding_node_ids).toHaveLength(1);
    expect(factoryEntry?.metadata?.local_support_binding_node_ids).toHaveLength(1);
    expect((cas.edges || []).some((edge: any) =>
      edge.type === 'calls' &&
      edge.source === factoryEntry.metadata.handler_binding_node_ids[0] &&
      edge.target === factoryEntry.metadata.local_support_binding_node_ids[0]
    )).toBe(true);
    const factoryCapability: any = { id: 'factory', name: 'Edit local draft', operations: [{ entry_point_id: factoryEntry.id }], related_entities: [] };
    expect(classifyCapabilityOperationEffect(factoryCapability, factoryCapability.operations[0], completeCas).kind).toBe('support');

    // The Parent's onClick={handleSave} resolves a `triggers` edge to the
    // handleSave util (imported from ./handlers) since it's a bare identifier
    // matching a known util export.
    const handleSaveUtil = completeCas.nodes.find((n: any) => n.name === 'handleSave' && n.source?.file === 'src/utils/handlers.ts');
    expect(handleSaveUtil).toBeTruthy();
    const triggersEdge = (cas.edges || []).find((e: any) => e.type === 'triggers' && e.target === handleSaveUtil!.id);
    expect(triggersEdge).toBeTruthy();

    const stateCapability: any = { id: 'state', name: 'Toggle local count', description: 'Users adjust local display state.', operations: [{ entry_point_id: inlineStateEntry.id, action: 'mouseLeave', path_or_command: '' }], related_entities: [] };
    expect(classifyCapabilityOperationEffect(stateCapability, stateCapability.operations[0], completeCas).kind).toBe('support');
    const disclosureCapability: any = { id: 'open', name: 'Open local modal', description: 'Users open a local modal.', operations: [{ entry_point_id: disclosureEntry.id, action: 'click', path_or_command: '' }], related_entities: [] };
    expect(classifyCapabilityOperationEffect(disclosureCapability, disclosureCapability.operations[0], completeCas).kind).toBe('support');

    const callbackPassEntry = (cas.entry_points || []).find((ep: any) => ep.metadata?.component === 'Parent' && ep.metadata?.jsx_element === 'ChildB');
    expect(callbackPassEntry?.metadata?.binding_kind).toBe('event-handler');
    expect((cas.edges || []).some((edge: any) => edge.type === 'renders' && edge.source === parent!.id && edge.target === childB!.id)).toBe(true);

    const childBClickEntry = clickEntries.find((ep: any) => ep.metadata?.component === 'ChildB');
    expect(childBClickEntry).toBeTruthy();
    expect(childBClickEntry?.metadata?.binding_kind).toBe('component-callback-prop');
    expect(childBClickEntry?.metadata?.callback_origin_component_id).toBe(parent!.id);
    expect(childBClickEntry?.metadata?.handler_binding_node_ids).toHaveLength(1);
    const childTriggerTargets = (cas.edges || []).filter((edge: any) => edge.type === 'triggers' && edge.source === childBClickEntry.id).map((edge: any) => edge.target).sort();
    expect(childTriggerTargets).toEqual([...childBClickEntry.metadata.handler_binding_node_ids].sort());
    expect(classifyCapabilityOperationEffect({ id: 'save', name: 'Save records', operations: [{ entry_point_id: childBClickEntry.id }], related_entities: [] } as any, { entry_point_id: childBClickEntry.id } as any, completeCas).kind).toBe('required');
    const childChangeEntry = (cas.entry_points || []).find((entry: any) => entry.metadata?.component === 'ChildB' && entry.trigger?.pattern === 'change');
    const childCloseEntry = clickEntries.find((entry: any) => entry.metadata?.component === 'ChildB' && entry.metadata?.handler_name === 'onClose');
    const childSubmitEntry = (cas.entry_points || []).find((entry: any) => entry.metadata?.component === 'ChildB' && entry.trigger?.pattern === 'submit');
    expect(childChangeEntry?.metadata?.callback_origin_component_id).toBe(parent!.id);
    expect(classifyCapabilityOperationEffect({ id: 'change', name: 'Change local value', operations: [{ entry_point_id: childChangeEntry.id }], related_entities: [] } as any, { entry_point_id: childChangeEntry.id } as any, completeCas).kind).toBe('support');
    expect(childCloseEntry?.metadata?.callback_origin_component_id).toBe(parent!.id);
    expect(classifyCapabilityOperationEffect({ id: 'close', name: 'Close local dialog', operations: [{ entry_point_id: childCloseEntry.id }], related_entities: [] } as any, { entry_point_id: childCloseEntry.id } as any, completeCas).kind).toBe('support');
    const childMemberCloseEntry = clickEntries.find((entry: any) => entry.metadata?.component === 'ChildB' && entry.metadata?.handler_references?.some((reference: any) => reference.name === 'dialog.onClose'));
    expect(childMemberCloseEntry?.metadata?.handler_binding_node_ids).toHaveLength(2);
    expect(childMemberCloseEntry?.metadata?.handler_references).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'dialog.onClose', binding_reference_name: 'dialog' })]));
    expect(classifyCapabilityOperationEffect({ id: 'member-close', name: 'Close local dialog', operations: [{ entry_point_id: childMemberCloseEntry.id }], related_entities: [] } as any, { entry_point_id: childMemberCloseEntry.id } as any, completeCas).kind).toBe('support');
    expect(childSubmitEntry?.metadata?.handler_references).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'onSave' })]));
    expect(childSubmitEntry?.metadata?.handler_binding_node_ids).toHaveLength(1);
    expect(classifyCapabilityOperationEffect({ id: 'submit', name: 'Submit record', operations: [{ entry_point_id: childSubmitEntry.id }], related_entities: [] } as any, { entry_point_id: childSubmitEntry.id } as any, completeCas).kind).toBe('required');

    for (const entry of cas.entry_points.filter((item: any) => item.metadata?.source_analyzer === 'react')) {
      const targets = (cas.edges || []).filter((edge: any) => edge.type === 'triggers' && edge.source === entry.id).map((edge: any) => edge.target).sort();
      expect(targets).toEqual([...(entry.metadata?.handler_binding_node_ids || [])].sort());
    expect(new Set(cas.edges.map((edge: any) => edge.id)).size).toBe(cas.edges.length);
    }
    expect(new Set(cas.entry_points.filter((item: any) => item.metadata?.source_analyzer === 'react').map((item: any) => item.id)).size)
      .toBe(cas.entry_points.filter((item: any) => item.metadata?.source_analyzer === 'react').length);
  });

  it('keeps ambiguous parent callback bindings unresolved and required', async () => {
    write('src/Child.tsx', "import React from 'react'; export function Child({ onSave }: { onSave: () => void }) { return <button onClick={onSave}>Save</button>; }");
    write('src/ParentA.tsx', "import React from 'react'; import { Child } from './Child'; export function ParentA() { const onSave = () => true; return <Child onSave={onSave} />; }");
    write('src/ParentB.tsx', "import React from 'react'; import { Child } from './Child'; export function ParentB() { const onSave = () => false; return <Child onSave={onSave} />; }");
    const languageAnalyzer = new TypeScriptJavaScriptAnalyzer();
    const languageCas: any = await languageAnalyzer.analyze({ projectPath: root } as any);
    const analyzer = new ReactAnalyzer();
    const cas: any = await analyzer.analyze({ projectPath: root, existingAnalysis: [languageCas] } as any);
    const entry = cas.entry_points.find((item: any) => item.metadata?.component === 'Child' && item.trigger?.pattern === 'click');
    expect(entry?.metadata?.handler_references).toEqual([expect.objectContaining({ name: 'onSave', binding_node_id: undefined })]);
    expect(entry?.metadata?.handler_binding_node_ids).toEqual([]);
    expect(classifyCapabilityOperationEffect({ id: 'save', name: 'Save records', operations: [{ entry_point_id: entry.id }], related_entities: [] } as any,
      { entry_point_id: entry.id } as any,
      { nodes: [...languageCas.nodes, ...cas.nodes], edges: [...languageCas.edges, ...cas.edges], entryPoints: cas.entry_points, exitPoints: languageCas.exit_points }).kind).toBe('required');
  });


  it('resolves exact multi-hop callback props while preserving terminal reachability', async () => {
    write('src/Leaf.tsx', "import React from 'react'; export function Leaf({ setValue, submit }: any) { return <form onSubmit={(event: { preventDefault: () => void }) => { event.preventDefault(); submit(); }}><input onChange={() => setValue('next')} /></form>; }");
    write('src/Middle.tsx', "import React from 'react'; import { Leaf } from './Leaf'; export function Middle({ setValue, submit }: any) { return <Leaf setValue={setValue} submit={submit} />; }");
    write('src/Root.tsx', "import React from 'react'; import { Middle } from './Middle'; export function Root() { const [value, setValue] = useState(''); const submit = () => fetch('/api/items'); return <Middle setValue={setValue} submit={submit} />; }");
    const languageAnalyzer = new TypeScriptJavaScriptAnalyzer();
    const languageCas: any = await languageAnalyzer.analyze({ projectPath: root } as any);
    const analyzer = new ReactAnalyzer();
    const cas: any = await analyzer.analyze({ projectPath: root, existingAnalysis: [languageCas] } as any);
    const context = { nodes: [...languageCas.nodes, ...cas.nodes], edges: [...languageCas.edges, ...cas.edges], entryPoints: cas.entry_points, exitPoints: languageCas.exit_points };
    const change = cas.entry_points.find((entry: any) => entry.metadata?.component === 'Leaf' && entry.trigger?.pattern === 'change');
    const submit = cas.entry_points.find((entry: any) => entry.metadata?.component === 'Leaf' && entry.trigger?.pattern === 'submit');
    expect(change?.metadata?.callback_component_path).toHaveLength(3);
    expect(change?.metadata?.handler_binding_node_ids).toHaveLength(1);
    expect(classifyCapabilityOperationEffect({ id: 'change', name: 'Change local value', operations: [{ entry_point_id: change.id }], related_entities: [] } as any, { entry_point_id: change.id } as any, context).kind).toBe('support');
    expect(submit?.metadata?.callback_component_path).toHaveLength(3);
    expect(submit?.metadata?.handler_binding_node_ids).toHaveLength(1);
    expect(classifyCapabilityOperationEffect({ id: 'submit', name: 'Submit items', operations: [{ entry_point_id: submit.id }], related_entities: [] } as any, { entry_point_id: submit.id } as any, context).kind).toBe('required');
  });


  it('resolves named and default component aliases only through their exact exports', async () => {
    write('src/Named.tsx', "import React from 'react'; export function Child({ setValue }: any) { return <input onChange={() => setValue('named')} />; }");
    write('src/Default.tsx', "import React from 'react'; export default function Actual({ setValue }: any) { return <input onChange={() => setValue('default')} />; }");
    write('src/Other.tsx', "import React from 'react'; export function Other({ setValue }: any) { return <input onChange={() => setValue('other')} />; }");
    write('src/Parent.tsx', "import React from 'react'; import { Child as NamedPanel } from './Named'; import DefaultPanel from './Default'; export function Parent() { const [value, setValue] = useState(''); return <><NamedPanel setValue={setValue} /><DefaultPanel setValue={setValue} /><Other setValue={setValue} /></>; }");
    const languageAnalyzer = new TypeScriptJavaScriptAnalyzer();
    const languageCas: any = await languageAnalyzer.analyze({ projectPath: root } as any);
    const analyzer = new ReactAnalyzer();
    const cas: any = await analyzer.analyze({ projectPath: root, existingAnalysis: [languageCas] } as any);
    const parent = cas.nodes.find((node: any) => node.name === 'Parent' && node.type === 'functional_component');
    const child = cas.nodes.find((node: any) => node.name === 'Child' && node.type === 'functional_component');
    const actual = cas.nodes.find((node: any) => node.name === 'Actual' && node.type === 'functional_component');
    const other = cas.nodes.find((node: any) => node.name === 'Other' && node.type === 'functional_component');
    expect(cas.edges.some((edge: any) => edge.type === 'renders' && edge.source === parent.id && edge.target === child.id)).toBe(true);
    expect(cas.edges.some((edge: any) => edge.type === 'renders' && edge.source === parent.id && edge.target === actual.id)).toBe(true);
    expect(cas.edges.some((edge: any) => edge.type === 'renders' && edge.source === parent.id && edge.target === other.id)).toBe(false);
  });

  it('resolves duplicate component names only through exact imports', async () => {
    write('src/a/Panel.tsx', "import React from 'react'; export function Panel({ setValue }: any) { return <input onChange={() => setValue('a')} />; }");
    write('src/b/Panel.tsx', "import React from 'react'; export function Panel({ setValue }: any) { return <input onChange={() => setValue('b')} />; }");
    write('src/ParentA.tsx', "import React from 'react'; import { Panel } from './a/Panel'; export function ParentA() { const [value, setValue] = useState(''); return <Panel setValue={setValue} />; }");
    write('src/ParentB.tsx', "import React from 'react'; import { Panel } from './b/Panel'; export function ParentB() { const [value, setValue] = useState(''); return <Panel setValue={setValue} />; }");
    write('src/Ambiguous.tsx', "import React from 'react'; export function Ambiguous() { const [value, setValue] = useState(''); return <Panel setValue={setValue} />; }");
    const languageAnalyzer = new TypeScriptJavaScriptAnalyzer();
    const languageCas: any = await languageAnalyzer.analyze({ projectPath: root } as any);
    const analyzer = new ReactAnalyzer();
    const cas: any = await analyzer.analyze({ projectPath: root, existingAnalysis: [languageCas] } as any);
    const panels = cas.nodes.filter((node: any) => node.name === 'Panel' && node.type === 'functional_component');
    expect(panels).toHaveLength(2);
    const panelEntries = cas.entry_points.filter((entry: any) => entry.metadata?.component === 'Panel' && entry.trigger?.pattern === 'change');
    expect(panelEntries).toHaveLength(2);
    for (const entry of panelEntries) {
      expect(entry.metadata.handler_binding_node_ids).toHaveLength(1);
      expect(entry.metadata.callback_component_path).toHaveLength(2);
    }
    const ambiguous = cas.nodes.find((node: any) => node.name === 'Ambiguous' && node.type === 'functional_component');
    expect(cas.edges.some((edge: any) => edge.type === 'renders' && edge.source === ambiguous.id && panels.some((panel: any) => panel.id === edge.target))).toBe(false);
  });

});
