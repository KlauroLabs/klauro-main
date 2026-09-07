import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import * as zlib from 'node:zlib';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { writeCompressedChunksAtomic, writeCompressedJsonAtomic, writeJsonAtomic } from './json-storage-writer';

const brotliDecompress = promisify(zlib.brotliDecompress);
const execFileAsync = promisify(execFile);
const hasZstd = spawnSync('zstd', ['--version'], { stdio: 'ignore' }).status === 0;

test('streamed atomic JSON writes preserve large graph-shaped values', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-json-writer-'));
  const file = path.join(directory, 'analysis.json');
  const value = {
    nodes: Array.from({ length: 12_000 }, (_, index) => ({ id: `node-${index}`, metadata: { index, active: index % 2 === 0 } })),
    edges: Array.from({ length: 12_000 }, (_, index) => ({ source: `node-${index}`, target: `node-${(index + 1) % 12_000}` })),
  };
  try {
    await writeJsonAtomic(file, value, { spaces: 0 });
    assert.deepEqual(await fs.readJson(file), value);
  } finally {
    await fs.remove(directory);
  }
});

test('compressed JSON streams nested graph objects without changing their JSON representation', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-compressed-json-writer-'));
  const file = path.join(directory, 'analysis.json.br');
  const child = {
    id: 'child',
    nodes: Array.from({ length: 12_000 }, (_, index) => ({ id: `nested-${index}`, metadata: { index } })),
  };
  const value = { children: [child], retained: child };
  try {
    await writeCompressedJsonAtomic(file, value, { spaces: 2 });
    const bytes = (await brotliDecompress(await fs.readFile(file))).toString('utf8');
    assert.equal(bytes, `${JSON.stringify(value, null, 2)}\n`);
    const decoded = JSON.parse(bytes);
    assert.deepEqual(decoded, value);
    assert.deepEqual(decoded.children[0], decoded.retained);
  } finally {
    await fs.remove(directory);
  }
});

test('streaming JSON rejects cycles and removes its atomic temp file', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-circular-json-writer-'));
  const file = path.join(directory, 'analysis.json.br');
  const value: { nodes: unknown[]; self?: unknown } = { nodes: Array.from({ length: 10_001 }, () => null) };
  value.self = value;
  try {
    await fs.writeFile(file, 'existing');
    await assert.rejects(writeCompressedJsonAtomic(file, value, { spaces: 0 }), /circular structure/i);
    assert.equal(await fs.readFile(file, 'utf8'), 'existing');
    assert.deepEqual(await fs.readdir(directory), ['analysis.json.br']);
  } finally {
    await fs.remove(directory);
  }
});

test('chunk-stream failure preserves the destination and removes temporary output', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-chunk-writer-'));
  const file = path.join(directory, 'analysis.json.br');
  async function* failedChunks() {
    yield '{"partial":';
    throw new Error('source failed');
  }
  try {
    await fs.writeFile(file, 'existing');
    await assert.rejects(writeCompressedChunksAtomic(file, failedChunks()), /source failed/);
    assert.equal(await fs.readFile(file, 'utf8'), 'existing');
    assert.deepEqual(await fs.readdir(directory), ['analysis.json.br']);
  } finally {
    await fs.remove(directory);
  }
});

test('streaming JSON matches JSON.stringify semantics for toJSON, undefined values, holes, and property order', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-json-semantics-'));
  const file = path.join(directory, 'analysis.json.br');
  const value = {
    z: undefined,
    a: { toJSON(key: string) { return { key, kept: true, omitted: undefined }; } },
    omittedByToJSON: { toJSON() { return undefined; } },
    array: [undefined, , Number.NaN],
    boxed: new Number(7),
    numericKeys: { 2: 'two', 1: 'one', x: 'x' },
  };
  try {
    await writeCompressedJsonAtomic(file, value, { spaces: 0 });
    const bytes = (await brotliDecompress(await fs.readFile(file))).toString('utf8');
    assert.equal(bytes, `${JSON.stringify(value)}\n`);
  } finally {
    await fs.remove(directory);
  }
});

test('bounded atomic serialization reads accessors once and streams oversized children', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-json-bounded-'));
  const file = path.join(directory, 'analysis.json.br');
  let reads = 0;
  const small = Object.defineProperty({ id: 'small' }, 'derived', {
    enumerable: true,
    get() { reads += 1; return 'value'; },
  });
  const value = {
    nodes: [small, { id: 'large', documentation: 'x'.repeat(300_000), boxed: new String('y'.repeat(300_000)) }],
  };
  try {
    const expected = JSON.stringify(value);
    reads = 0;
    await writeCompressedJsonAtomic(file, value, { spaces: 0 });
    const bytes = (await brotliDecompress(await fs.readFile(file))).toString('utf8');
    assert.equal(bytes, `${expected}\n`);
    assert.equal(reads, 1);
  } finally {
    await fs.remove(directory);
  }
});

test('zstd streaming preserves exact bytes and cleans up after serializer failure', { skip: !hasZstd }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-zstd-json-writer-'));
  const file = path.join(directory, 'analysis.json.zst');
  const value: { children: unknown[]; self?: unknown } = {
    children: [{ nodes: Array.from({ length: 12_000 }, (_, index) => ({ id: `node-${index}` })) }],
  };
  try {
    await writeCompressedJsonAtomic(file, value, { spaces: 2 });
    const decoded = await execFileAsync('zstd', ['-q', '-d', '-c', file], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    assert.equal(decoded.stdout, `${JSON.stringify(value, null, 2)}\n`);
    const prior = await fs.readFile(file);
    value.self = value;
    await assert.rejects(writeCompressedJsonAtomic(file, value, { spaces: 0 }), /circular structure/i);
    assert.deepEqual(await fs.readFile(file), prior);
    assert.deepEqual(await fs.readdir(directory), ['analysis.json.zst']);
  } finally {
    await fs.remove(directory);
  }
});

test('field-wise compressed writer emits exactly the native JSON bytes and measures each field', async () => {
  const { writeCompressedJsonFieldsAtomic } = await import('./json-storage-writer');
  const { readZstdJson } = await import('./zstd-json');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-fields-writer-'));
  try {
    const value: Record<string, unknown> = {
      identity: { id: 'a', when: new Date('2026-09-07T00:00:00.000Z'), nested: { toJSON: () => ({ custom: true }) } },
      nodes: [{ id: 'n1', name: 'héllo ☃', tags: ['a', 'b'] }, { id: 'n2', empty: null }],
      skipped: undefined,
      fn: () => 1,
      count: 3,
      text: 'plain "quoted" \\ text',
      hidden: { inner: undefined, kept: false },
    };
    const target = path.join(dir, 'section.json.zst');
    const bytes = await writeCompressedJsonFieldsAtomic(target, value);
    const expected = JSON.stringify(value);
    const decoded = await readZstdJson(target);
    assert.equal(JSON.stringify(decoded), expected);
    assert.deepEqual(Object.keys(bytes), ['identity', 'nodes', 'count', 'text', 'hidden']);
    for (const key of Object.keys(bytes)) assert.equal(bytes[key], Buffer.byteLength(JSON.stringify(value[key]), 'utf8'), key);
    const plain = path.join(dir, 'section.json');
    await writeCompressedJsonFieldsAtomic(plain, value);
    assert.equal(fs.readFileSync(plain, 'utf8'), expected);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
