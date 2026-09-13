import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { glob as realGlob } from 'glob';
import { cachedGlob, beginGlobRun, endGlobRun } from './glob-cache';

// Locks the shared-ignore enhancement in glob-cache.ts: within a run, cache
// MISSES are served by a real glob walk that receives a run-shared, memoized
// Ignore object instead of the raw ignore string array. Each analyzer must
// receive EXACTLY the file set a direct glob(pattern, options) call returns,
// in SORTED order.
//
// Order contract: direct async glob() emission order is NOT deterministic
// (measured on real repos: back-to-back direct calls with identical
// arguments return the same set in different orders), so within a run
// cachedGlob sorts every result — order is a pure function of the set
// (docs/cas/DETERMINISM-BOUNDARY.md: "glob results are sorted before
// emission"). Set equality vs direct glob is asserted byte-for-byte on
// every combo; order is asserted to be the sorted order, identical across
// cache hit/miss and across runs in the same process.

function write(p: string, content = 'x'): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function makeFixtureTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glob-cache-fixture-'));
  const f = (rel: string) => write(path.join(root, rel));
  f('package.json');
  f('a.gemspec');
  f('src/a.ts');
  f('src/b.tsx');
  f('src/c.min.js');
  f('src/util/d.js');
  f('src/util/e.spec.ts');
  f('src/deep/nested/dir/f.ts');
  f('src/assets/logo.css');
  f('node_modules/pkg/index.js');
  f('node_modules/pkg/dist/x.min.js');
  f('dist/bundle.js');
  f('build/out.js');
  f('lib/jquery/jquery.js');
  f('.hidden/g.ts');
  f('.venv-x/h.py');
  f('env2/i.py');
  f('examples/j.ts');
  f('fixtures/k.ts');
  f('coverage/l.json');
  f('legacy/m.ts');
  f('services/api/handler.py');
  f('services/api/model.rb');
  return root;
}

// Representative slice of base-analyzer getIgnorePatterns(), including the
// pattern shapes that exercise Ignore's relative/absolute/children buckets
// and magic classes.
const DEFAULT_IGNORE = [
  'node_modules/**', '**/node_modules/**',
  'dist/**', '**/dist/**',
  'build/**', '**/build/**',
  '**/*.min.js', '**/*.min.css',
  '**/lib/jquery/**',
  'examples/**', '**/examples/**',
  'fixtures/**', '**/fixtures/**',
  '.venv*/**', '**/.venv*/**',
  'env[0-9]*/**', '**/env[0-9]*/**',
  'coverage/**', '**/coverage/**',
  '**/src/assets/**'
];

const PATTERNS = [
  '**/*.ts',
  '**/*.{ts,tsx,js,jsx}',
  '**/*.{ts,js,mts,mjs}',
  '**/*.py',
  '**/*.{py,rb}',
  '**/*.js',
  '**/*',
  '*.gemspec',
  'src/**/*.ts',
  '**/prisma/schema.prisma'
];

test('cachedGlob run misses return exactly the direct-glob file set for every pattern/ignore/option combo', async () => {
  const root = makeFixtureTree();
  try {
    const optionVariants: Array<Record<string, unknown>> = [
      { cwd: root, ignore: DEFAULT_IGNORE, nodir: true },
      { cwd: root, ignore: [...DEFAULT_IGNORE, '**/legacy/**', '**/*.spec.ts'], nodir: true },
      { cwd: root, ignore: DEFAULT_IGNORE, nodir: true, absolute: true },
      { cwd: root, ignore: DEFAULT_IGNORE, nodir: true, dot: true },
      { cwd: root, ignore: DEFAULT_IGNORE }, // no nodir: dirs included, childrenIgnored pruning visible
      { cwd: root, ignore: 'node_modules/**', nodir: true }, // string ignore
      { cwd: root, nodir: true } // no ignore: enhancement skipped, plain path
    ];

    const token = beginGlobRun();
    try {
      for (const pattern of PATTERNS) {
        for (const opts of optionVariants) {
          const direct = (await realGlob(pattern, opts as never)) as string[];
          const first = await cachedGlob(pattern, opts as never); // miss: enhanced walk
          const second = await cachedGlob(pattern, opts as never); // hit: memoized result
          const label = `pattern=${pattern} opts=${JSON.stringify(Object.keys(opts))}`;
          assert.deepEqual(first, [...direct].sort(), `must equal the sorted direct-glob set: ${label}`);
          assert.deepEqual(second, first, `cache hit must replay the miss result exactly: ${label}`);
          // Sanity: the fixture must actually produce matches for most combos,
          // otherwise this test proves nothing.
          if (pattern === '**/*' ) {
            assert.ok(direct.length > 0, `expected matches: ${label}`);
          }
        }
      }
    } finally {
      endGlobRun(token);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ignore semantics: memoized shared Ignore excludes exactly what direct glob excludes', async () => {
  const root = makeFixtureTree();
  try {
    const opts = { cwd: root, ignore: DEFAULT_IGNORE, nodir: true };
    const direct = ((await realGlob('**/*', opts as never)) as string[]).sort();
    const token = beginGlobRun();
    let cached: string[];
    try {
      // Warm the shared ignore memo with a different pattern first so the
      // '**/*' call runs against memoized verdicts (the cross-call reuse path).
      await cachedGlob('**/*.ts', opts as never);
      cached = (await cachedGlob('**/*', opts as never)).sort();
    } finally {
      endGlobRun(token);
    }
    assert.deepEqual(cached, direct);
    // Spot-check the ignore actually bit: ignored families absent, kept files present.
    assert.ok(!cached.some(f => f.includes('node_modules')), 'node_modules must be ignored');
    assert.ok(!cached.some(f => f.endsWith('.min.js')), '*.min.js must be ignored');
    assert.ok(!cached.some(f => f.startsWith('env2/')), 'env[0-9]*/** must be ignored');
    assert.ok(cached.includes('src/a.ts'), 'non-ignored files must be present');
    assert.ok(cached.includes('legacy/m.ts'), 'legacy kept when not filtered');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('warm reuse: two runs in one process return deep-equal file lists, order included', async () => {
  const root = makeFixtureTree();
  try {
    const combos: Array<[string, Record<string, unknown>]> = [
      ['**/*.{ts,tsx,js,jsx}', { cwd: root, ignore: DEFAULT_IGNORE, nodir: true }],
      ['**/*', { cwd: root, ignore: DEFAULT_IGNORE, nodir: true }],
      ['**/*.py', { cwd: root, ignore: DEFAULT_IGNORE, nodir: true, absolute: true }],
      ['src/**/*.ts', { cwd: root, ignore: DEFAULT_IGNORE, nodir: true }]
    ];
    const runLists = async (): Promise<string[][]> => {
      const token = beginGlobRun();
      try {
        const lists: string[][] = [];
        for (const [pattern, opts] of combos) {
          lists.push(await cachedGlob(pattern, opts as never));
        }
        return lists;
      } finally {
        endGlobRun(token);
      }
    };
    const run1 = await runLists();
    const run2 = await runLists();
    assert.deepEqual(run2, run1, 'per-(pattern, ignore, cwd) file lists must be identical across runs, order included');
    // And the order is the deterministic sorted order, not an I/O-race order.
    for (const list of run1) {
      assert.deepEqual(list, [...list].sort(), 'run-scoped results must be sorted');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('outside a run, cachedGlob is a pass-through to direct glob', async () => {
  const root = makeFixtureTree();
  try {
    const opts = { cwd: root, ignore: DEFAULT_IGNORE, nodir: true };
    const direct = ((await realGlob('**/*.ts', opts as never)) as string[]).sort();
    const uncached = (await cachedGlob('**/*.ts', opts as never)).sort();
    assert.deepEqual(uncached, direct);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The run-shared Ignore compiles directory-subtree patterns ("**/name/**") into
// a segment test instead of handing them to the pattern engine. 132 of the 181
// distinct ignore patterns a real analysis uses have that shape. These tests
// pin the semantics the compilation has to preserve exactly:
//   - "**/name/**" ignores the directory itself as well as its contents,
//     because glob probes the path with a trailing slash
//   - "**/name/**/*" does NOT ignore the directory itself, only descendants
//   - "name/**" applies at the root only
//   - matching is on the path RELATIVE to cwd, so a cwd that itself contains a
//     segment called "build" must not ignore the entire repository

const FAST_IGNORE_PATTERNS = [
  '**/node_modules/**', 'node_modules/**',
  '**/build/**', 'build/**',
  '**/.venv*/**', '.venv*/**',
  '**/env[0-9]*/**', 'env[0-9]*/**',
  '**/dist-*/**',
  '**/coverage/**/*',
  '**/lib/jquery/**',
  '**/*.min.js'
];

function makeSegmentTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glob-cache-segments-'));
  const f = (rel: string) => write(path.join(root, rel));
  f('src/a.ts');
  f('src/a.min.js');
  f('node_modules/pkg/index.js');
  f('deep/node_modules/pkg/index.js');
  f('build/out.js');
  f('src/build/out.js');
  f('.venv-x/h.py');
  f('env2/i.py');
  f('env/keep.py');
  f('dist-esm/x.js');
  f('dist/x.js');
  f('coverage/report.json');
  f('lib/jquery/jquery.js');
  f('lib/keep/keep.js');
  return root;
}

test('compiled directory-subtree ignores match the pattern engine exactly', async () => {
  const root = makeSegmentTree();
  try {
    const variants: Array<Record<string, unknown>> = [
      { cwd: root, ignore: FAST_IGNORE_PATTERNS, nodir: true },
      { cwd: root, ignore: FAST_IGNORE_PATTERNS, nodir: true, dot: true },
      { cwd: root, ignore: FAST_IGNORE_PATTERNS },
      { cwd: root, ignore: FAST_IGNORE_PATTERNS, absolute: true, nodir: true }
    ];
    for (const pattern of ['**/*', '**/*.js', '**/*.py', 'src/**/*']) {
      for (const opts of variants) {
        const direct = ((await realGlob(pattern, opts as never)) as string[]).sort();
        const token = beginGlobRun();
        let cached: string[];
        try {
          cached = await cachedGlob(pattern, opts as never);
        } finally {
          endGlobRun(token);
        }
        assert.deepEqual(cached, direct, `pattern=${pattern} opts=${JSON.stringify(Object.keys(opts))}`);
      }
    }
    const token = beginGlobRun();
    try {
      const all = await cachedGlob('**/*', { cwd: root, ignore: FAST_IGNORE_PATTERNS, nodir: true, dot: true } as never);
      assert.ok(!all.some(f => f.includes('node_modules')), 'nested and root node_modules both pruned');
      assert.ok(!all.some(f => f.startsWith('build/') || f.includes('/build/')), 'build pruned at any depth');
      assert.ok(!all.some(f => f.startsWith('.venv-x/')), 'wildcard directory name pruned');
      assert.ok(!all.some(f => f.startsWith('env2/')), 'character-class directory name pruned');
      assert.ok(!all.some(f => f.startsWith('dist-esm/')), 'dist-* pruned');
      assert.ok(!all.includes('lib/jquery/jquery.js'), 'path-shaped residue still applied');
      assert.ok(!all.includes('src/a.min.js'), 'suffix residue still applied');
      assert.ok(all.includes('env/keep.py'), 'env without a digit is not env[0-9]*');
      assert.ok(all.includes('dist/x.js'), 'dist is not dist-*');
      assert.ok(all.includes('lib/keep/keep.js'), 'only the named lib subtree is excluded');
      assert.ok(all.includes('src/a.ts'), 'ordinary sources survive');
    } finally {
      endGlobRun(token);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ignores match on the path relative to cwd, not the absolute path', async () => {
  // A repository that itself lives under a directory called "build" must not
  // have every one of its files ignored by "**/build/**".
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'glob-cache-outer-'));
  try {
    const root = path.join(outer, 'build', 'node_modules', 'repo');
    write(path.join(root, 'src/a.ts'));
    write(path.join(root, 'src/b.ts'));
    const opts = { cwd: root, ignore: FAST_IGNORE_PATTERNS, nodir: true };
    const direct = ((await realGlob('**/*', opts as never)) as string[]).sort();
    const token = beginGlobRun();
    let cached: string[];
    try {
      cached = await cachedGlob('**/*', opts as never);
    } finally {
      endGlobRun(token);
    }
    assert.deepEqual(cached, direct);
    assert.deepEqual(cached, ['src/a.ts', 'src/b.ts'], 'cwd segments must not be treated as repository paths');
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

test('KLAURO_GLOB_FAST_IGNORE=off falls back to the pattern engine with identical results', async () => {
  const root = makeSegmentTree();
  const prior = process.env.KLAURO_GLOB_FAST_IGNORE;
  try {
    const opts = { cwd: root, ignore: FAST_IGNORE_PATTERNS, nodir: true, dot: true };
    const direct = ((await realGlob('**/*', opts as never)) as string[]).sort();
    process.env.KLAURO_GLOB_FAST_IGNORE = 'off';
    const token = beginGlobRun();
    try {
      assert.deepEqual(await cachedGlob('**/*', opts as never), direct, 'escape hatch must not change results');
    } finally {
      endGlobRun(token);
    }
  } finally {
    if (prior === undefined) delete process.env.KLAURO_GLOB_FAST_IGNORE;
    else process.env.KLAURO_GLOB_FAST_IGNORE = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
