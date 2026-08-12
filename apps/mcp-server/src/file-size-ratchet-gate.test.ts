import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkRatchet, countLines } from './file-size-ratchet-gate';

// The ratchet's whole value is that it FAILS on growth. A gate nobody proved red
// is a gate that passes everything — the lesson from the native-parser precheck,
// and from #121 staying green through five weeks of a file growing 45%.

function withTree(run: (root: string, write: (name: string, lines: number) => void) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-'));
  try {
    run(root, (name, lines) => fs.writeFileSync(path.join(root, name), 'x\n'.repeat(lines)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('counts lines the way wc -l does, including a final unterminated line', () => {
  assert.equal(countLines(''), 0);
  assert.equal(countLines('a\n'), 1);
  assert.equal(countLines('a\nb\n'), 2);
  assert.equal(countLines('a\nb'), 2);
});

test('fails when a file grows past its ceiling', () => {
  withTree((root, write) => {
    write('big.ts', 101);
    const result = checkRatchet(root, [{ file: 'big.ts', ceiling: 100 }]);
    assert.deepEqual(result.violations, [{ file: 'big.ts', ceiling: 100, actual: 101 }]);
  });
});

test('passes a file exactly at its ceiling', () => {
  withTree((root, write) => {
    write('exact.ts', 100);
    assert.deepEqual(checkRatchet(root, [{ file: 'exact.ts', ceiling: 100 }]).violations, []);
  });
});

test('reports slack so a shrunk file gets its ceiling lowered', () => {
  // Otherwise an extraction's win silently evaporates the next time someone adds
  // code back up to the old ceiling — which is exactly what already happened.
  withTree((root, write) => {
    write('shrunk.ts', 50);
    const result = checkRatchet(root, [{ file: 'shrunk.ts', ceiling: 100 }]);
    assert.deepEqual(result.violations, []);
    assert.deepEqual(result.slack, [{ file: 'shrunk.ts', ceiling: 100, actual: 50 }]);
  });
});

test('reports a vanished baseline file instead of counting it as a pass', () => {
  withTree(root => {
    const result = checkRatchet(root, [{ file: 'gone.ts', ceiling: 100 }]);
    assert.deepEqual(result.missing, ['gone.ts']);
    assert.equal(result.checked, 0);
    assert.deepEqual(result.violations, []);
  });
});

test('never rewrites the files it inspects', () => {
  withTree((root, write) => {
    write('stable.ts', 10);
    const before = fs.readFileSync(path.join(root, 'stable.ts'), 'utf8');
    checkRatchet(root, [{ file: 'stable.ts', ceiling: 10 }]);
    assert.equal(fs.readFileSync(path.join(root, 'stable.ts'), 'utf8'), before);
  });
});
