jest.unmock('fs-extra');
jest.unmock('fs');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { classifyCodebaseType, classifyCodebaseTypes } from '../../analyzer/core/codebase-type';
import type { CASEntryPoint } from '../../types/cas.types';

function tempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-codebase-type-'));
}

function writeJson(dir: string, file: string, content: unknown) {
  fs.writeFileSync(path.join(dir, file), JSON.stringify(content, null, 2));
}

describe('classifyCodebaseType', () => {
  let projectPath: string;

  afterEach(() => {
    if (projectPath) fs.removeSync(projectPath);
  });

  test('a library (publishable package.json, no bin, no server deps) classifies as library', () => {
    projectPath = tempProject();
    writeJson(projectPath, 'package.json', {
      name: 'my-utils',
      version: '1.0.0',
      main: 'dist/index.js',
      types: 'dist/index.d.ts',
      private: false,
      dependencies: { lodash: '^4.0.0' },
    });

    const result = classifyCodebaseType({ projectPath });
    expect(result.codebase_type).toBe('library');
    expect(result.signals.some(s => s.id === 'package.json#main-exports')).toBe(true);
  });

  test('an express backend (server deps + http entry points) classifies as web-backend', () => {
    projectPath = tempProject();
    writeJson(projectPath, 'package.json', {
      name: 'my-api',
      version: '1.0.0',
      private: true,
      dependencies: { express: '^4.0.0' },
    });
    const entryPoints: CASEntryPoint[] = [
      { id: 'ep1', source_node: 'n1', type: 'http', name: 'GET /users' },
      { id: 'ep2', source_node: 'n2', type: 'http', name: 'POST /users' },
    ] as CASEntryPoint[];

    const result = classifyCodebaseType({ projectPath, entryPoints });
    expect(result.codebase_type).toBe('web-backend');
  });

  test('a CLI (package.json#bin + commander dep + cli entry points) classifies as cli', () => {
    projectPath = tempProject();
    writeJson(projectPath, 'package.json', {
      name: 'my-cli',
      version: '1.0.0',
      private: false,
      bin: { 'my-cli': './bin/cli.js' },
      dependencies: { commander: '^11.0.0' },
    });
    const entryPoints: CASEntryPoint[] = [
      { id: 'ep1', source_node: 'n1', type: 'cli', name: 'my-cli build' },
    ] as CASEntryPoint[];

    const result = classifyCodebaseType({ projectPath, entryPoints });
    expect(result.codebase_type).toBe('cli');
  });

  test('no manifest and no evidence classifies as unknown with zero confidence', () => {
    projectPath = tempProject();
    const result = classifyCodebaseType({ projectPath });
    expect(result.codebase_type).toBe('unknown');
    expect(result.confidence).toBe(0);
  });

  test('a monorepo (npm workspaces) is included in the ranked types list', () => {
    projectPath = tempProject();
    writeJson(projectPath, 'package.json', {
      name: 'my-monorepo',
      private: true,
      workspaces: ['packages/*'],
    });
    const result = classifyCodebaseTypes({ projectPath });
    expect(result.types.some(t => t.type === 'monorepo')).toBe(true);
  });

  test('next.js dependency yields fullstack signal', () => {
    projectPath = tempProject();
    writeJson(projectPath, 'package.json', {
      name: 'my-next-app',
      private: true,
      dependencies: { next: '^14.0.0', react: '^18.0.0' },
    });
    const result = classifyCodebaseType({ projectPath });
    expect(result.codebase_type).toBe('fullstack');
  });
});
