// The ratchet's whole value is that it FAILS on growth. A gate nobody proved
// red is a gate that passes everything — the lesson from the native-parser
// precheck and from #121's five weeks of green-while-growing.
import { checkRatchet, countLines } from './file-size-ratchet-gate';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('file-size ratchet', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const write = (name: string, lines: number): void => {
    fs.writeFileSync(path.join(root, name), `${'x\n'.repeat(lines)}`);
  };

  it('counts lines the way wc -l does, including a final unterminated line', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a\n')).toBe(1);
    expect(countLines('a\nb\n')).toBe(2);
    expect(countLines('a\nb')).toBe(2);
  });

  it('fails when a file grows past its ceiling', () => {
    write('big.ts', 101);
    const result = checkRatchet(root, [{ file: 'big.ts', ceiling: 100 }]);
    expect(result.violations).toEqual([{ file: 'big.ts', ceiling: 100, actual: 101 }]);
  });

  it('passes a file exactly at its ceiling', () => {
    write('exact.ts', 100);
    expect(checkRatchet(root, [{ file: 'exact.ts', ceiling: 100 }]).violations).toEqual([]);
  });

  it('reports slack so a shrunk file gets its ceiling lowered', () => {
    // Otherwise an extraction's win silently evaporates the next time someone
    // adds code back up to the old ceiling — which is exactly what happened.
    write('shrunk.ts', 50);
    const result = checkRatchet(root, [{ file: 'shrunk.ts', ceiling: 100 }]);
    expect(result.violations).toEqual([]);
    expect(result.slack).toEqual([{ file: 'shrunk.ts', ceiling: 100, actual: 50 }]);
  });

  it('reports a vanished baseline file instead of counting it as a pass', () => {
    const result = checkRatchet(root, [{ file: 'gone.ts', ceiling: 100 }]);
    expect(result.missing).toEqual(['gone.ts']);
    expect(result.checked).toBe(0);
    expect(result.violations).toEqual([]);
  });

  it('never rewrites the files it inspects', () => {
    write('stable.ts', 10);
    const before = fs.readFileSync(path.join(root, 'stable.ts'), 'utf8');
    checkRatchet(root, [{ file: 'stable.ts', ceiling: 10 }]);
    expect(fs.readFileSync(path.join(root, 'stable.ts'), 'utf8')).toBe(before);
  });
});
