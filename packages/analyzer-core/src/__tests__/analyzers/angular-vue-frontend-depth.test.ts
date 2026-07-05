jest.unmock('fs-extra');
jest.unmock('fs');
jest.unmock('glob');

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AngularAnalyzer } from '../../analyzer/frameworks/web/angular-analyzer';
import { VueAnalyzer } from '../../analyzer/frameworks/web/vue-analyzer';

describe('AngularAnalyzer: event bindings as event entry points', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'angular-frontend-depth-'));
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'fixture', dependencies: { '@angular/core': '^17.0.0' } })
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

  it('emits an event entry point + triggers edge for a (click) binding calling a declared method', async () => {
    write(
      'src/app/save-button.component.ts',
      [
        "import { Component } from '@angular/core';",
        '',
        '@Component({',
        "  selector: 'app-save-button',",
        '  standalone: true,',
        "  template: `<button (click)=\"onSave()\">Save</button>`",
        '})',
        'export class SaveButtonComponent {',
        '  onSave() {',
        '    console.log(\'saved\');',
        '  }',
        '}',
      ].join('\n')
    );

    const analyzer = new AngularAnalyzer();
    const cas: any = await analyzer.analyze({ projectPath: root } as any);

    const clickEntries = (cas.entry_points || []).filter((ep: any) => ep.type === 'event' && ep.trigger?.pattern === 'click');
    expect(clickEntries.length).toBeGreaterThanOrEqual(1);
    expect(clickEntries[0].metadata?.handler_name).toBe('onSave');

    const methodNode = (cas.nodes || []).find((n: any) => n.type === 'method' && n.name === 'onSave');
    expect(methodNode).toBeTruthy();

    const triggersEdge = (cas.edges || []).find((e: any) => e.type === 'triggers' && e.target === methodNode!.id);
    expect(triggersEdge).toBeTruthy();
  });
});

describe('VueAnalyzer: event bindings as event entry points', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-frontend-depth-'));
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'fixture', dependencies: { vue: '^3.0.0' } })
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

  it('emits an event entry point + triggers edge for an @click binding calling a declared method', async () => {
    write(
      'src/SaveButton.vue',
      [
        '<template>',
        '  <button @click="onSave">Save</button>',
        '</template>',
        '<script>',
        'export default {',
        '  methods: {',
        '    onSave() {',
        "      console.log('saved');",
        '    }',
        '  }',
        '}',
        '</script>',
      ].join('\n')
    );

    const analyzer = new VueAnalyzer();
    const cas: any = await analyzer.analyze({ projectPath: root } as any);

    const clickEntries = (cas.entry_points || []).filter((ep: any) => ep.type === 'event' && ep.trigger?.pattern === 'click');
    expect(clickEntries.length).toBeGreaterThanOrEqual(1);
    expect(clickEntries[0].metadata?.handler_name).toBe('onSave');

    const methodNode = (cas.nodes || []).find((n: any) => n.type === 'method' && n.name === 'onSave');
    expect(methodNode).toBeTruthy();

    const triggersEdge = (cas.edges || []).find((e: any) => e.type === 'triggers' && e.target === methodNode!.id);
    expect(triggersEdge).toBeTruthy();
  });
});
