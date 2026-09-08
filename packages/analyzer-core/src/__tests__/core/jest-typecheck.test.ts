import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

describe('complete Jest typecheck preflight', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-jest-types-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(root, 'tests'));
    fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, target: 'ES2020', module: 'CommonJS', types: [], skipLibCheck: true },
      include: ['src/**/*.ts'],
      exclude: ['tests'],
    }));
    fs.writeFileSync(path.join(root, 'src/value.ts'), 'export const value: string = "value";');
    fs.writeFileSync(path.join(root, 'tests/value.test.ts'),
      'import { value } from "../src/value"; export const checked: string = value;');
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function check(overrides: Record<string, unknown> = {}) {
    return spawnSync(process.execPath, [require.resolve('../../../scripts/check-jest-types.cjs')], {
      cwd: root,
      input: JSON.stringify({
        rootDir: root,
        roots: [root],
        testMatch: ['**/tests/**/*.test.ts'],
        moduleFileExtensions: ['ts', 'js', 'json'],
        transform: [['^.+\\\\.ts$', require.resolve('ts-jest'), { tsconfig: { isolatedModules: true } }]],
        ...overrides,
      }),
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
  }

  function summary(stdout: string) {
    return JSON.parse(stdout.split('\n').find(line => line.startsWith('[jest-typecheck] '))!.slice(17));
  }

  it('checks production, test files excluded from production, and every configured TypeScript setup', () => {
    const setupPaths = ['setup.ts', 'after.ts', 'global.ts', 'teardown.ts'].map(name => path.join(root, name));
    for (const file of setupPaths) fs.writeFileSync(file, 'export const ready: boolean = true;');
    const result = check({
      setupFiles: [setupPaths[0]], setupFilesAfterEnv: [setupPaths[1]],
      globalSetup: setupPaths[2], globalTeardown: setupPaths[3],
    });
    expect(result.status).toBe(0);
    expect(summary(result.stdout)).toMatchObject({ tests: 1, roots: 6, diagnostics: 0, isolated_modules: true });
  });

  it('rejects semantic errors in a test excluded by the production tsconfig', () => {
    fs.writeFileSync(path.join(root, 'tests/value.test.ts'), 'export const checked: string = 42;');
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('TS2322');
    expect(summary(result.stdout).diagnostics).toBeGreaterThan(0);
  });

  it('rejects semantic errors in setup files', () => {
    const setup = path.join(root, 'configured-setup.ts');
    fs.writeFileSync(setup, 'export const ready: boolean = 42;');
    const result = check({ setupFilesAfterEnv: [setup] });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('TS2322');
    expect(result.stderr).toContain('configured-setup.ts');
  });

  it('uses the active alternate Jest discovery instead of a hardcoded test pattern', () => {
    fs.mkdirSync(path.join(root, 'parity'));
    fs.writeFileSync(path.join(root, 'parity/value.spec.ts'), 'export const checked: boolean = true;');
    fs.writeFileSync(path.join(root, 'tests/value.test.ts'), 'export const excluded: string = 42;');
    const result = check({ testMatch: ['**/parity/**/*.spec.ts'] });
    expect(result.status).toBe(0);
    expect(summary(result.stdout)).toMatchObject({ tests: 1, roots: 2, diagnostics: 0 });
  });

  it('fails closed when Jest discovery is invalid or empty', () => {
    const empty = check({ testMatch: ['**/missing/**/*.test.ts'] });
    expect(empty.status).not.toBe(0);
    expect(empty.stderr).toContain('no test files');
    const invalid = check({ testMatch: ['**/*.test.ts'], testRegex: '.*' });
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).toContain('discovery failed');
  });

  it('retains isolated-module safety diagnostics instead of suppressing type re-exports', () => {
    fs.writeFileSync(path.join(root, 'src/types.ts'), 'export interface Contract { value: string; }');
    fs.writeFileSync(path.join(root, 'src/index.ts'), 'export { Contract } from "./types";');
    const result = check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('TS1205');
  });
});
