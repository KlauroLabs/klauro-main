import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveContextRuntimeMode,
  resolveSectionFilter,
  resolveSectionFilterForProject,
  canonicalizeSection,
  normalizeContextRuntimeMode,
} from './context-filter';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

test('normalizeContextRuntimeMode accepts valid modes, rejects junk', () => {
  assert.equal(normalizeContextRuntimeMode('exclude'), 'exclude');
  assert.equal(normalizeContextRuntimeMode('INCLUDE'), 'include');
  assert.equal(normalizeContextRuntimeMode(' auto '), 'auto');
  assert.equal(normalizeContextRuntimeMode('nope'), undefined);
  assert.equal(normalizeContextRuntimeMode(42), undefined);
});

test('canonicalizeSection maps aliases to canonical keys', () => {
  assert.equal(canonicalizeSection('runtime'), 'runtime');
  assert.equal(canonicalizeSection('telemetry'), 'runtime');
  assert.equal(canonicalizeSection('runtime_observations'), 'runtime');
  assert.equal(canonicalizeSection('communication-seams'), 'seams');
  assert.equal(canonicalizeSection('Runtime Topology'), 'topology');
  assert.equal(canonicalizeSection('unknown'), null);
});

test('resolveContextRuntimeMode precedence: param > env > config > auto', () => {
  // param wins over everything
  assert.equal(resolveContextRuntimeMode({ param: 'include', env: 'exclude', config: 'exclude' }), 'include');
  // env wins over config
  assert.equal(resolveContextRuntimeMode({ env: 'exclude', config: 'include' }), 'exclude');
  // config used when no param/env
  assert.equal(resolveContextRuntimeMode({ config: 'exclude' }), 'exclude');
  // default is auto (backward compatible)
  assert.equal(resolveContextRuntimeMode({}), 'auto');
  // invalid param falls through to env
  assert.equal(resolveContextRuntimeMode({ param: 'bogus', env: 'exclude' }), 'exclude');
});

test('resolveSectionFilter: auto excludes nothing (backward compatible)', () => {
  const f = resolveSectionFilter({ param: 'auto' });
  assert.equal(f.runtime_mode, 'auto');
  assert.equal(f.isExcluded('runtime'), false);
  assert.equal(f.isExcluded('seams'), false);
  assert.equal(f.isExcluded('topology'), false);
  assert.equal(f.excluded.size, 0);
});

test('resolveSectionFilter: exclude drops all dynamic sections', () => {
  const f = resolveSectionFilter({ param: 'exclude' });
  assert.equal(f.isExcluded('runtime'), true);
  assert.equal(f.isExcluded('seams'), true);
  assert.equal(f.isExcluded('topology'), true);
});

test('resolveSectionFilter: exclude_sections drops individual sections under auto', () => {
  const f = resolveSectionFilter({ param: 'auto', exclude_sections: ['seams'] });
  assert.equal(f.isExcluded('runtime'), false);
  assert.equal(f.isExcluded('seams'), true);
  assert.equal(f.isExcluded('topology'), false);
});

test('resolveSectionFilter: exclude_sections accepts aliases and ignores junk', () => {
  const f = resolveSectionFilter({ param: 'auto', exclude_sections: ['telemetry', 'garbage', 42 as any] });
  assert.equal(f.isExcluded('runtime'), true);
  assert.equal(f.isExcluded('seams'), false);
});

test('resolveSectionFilterForProject: honors .klaurorc context.runtime', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-ctx-'));
  try {
    await fs.writeFile(path.join(dir, '.klaurorc'), JSON.stringify({ context: { runtime: 'exclude' } }), 'utf8');
    const f = await resolveSectionFilterForProject(dir);
    assert.equal(f.runtime_mode, 'exclude');
    assert.equal(f.isExcluded('runtime'), true);

    // explicit param still overrides the .klaurorc default
    const overridden = await resolveSectionFilterForProject(dir, { runtime: 'include' });
    assert.equal(overridden.runtime_mode, 'include');
    assert.equal(overridden.isExcluded('runtime'), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('resolveSectionFilterForProject: no .klaurorc => auto', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-ctx-'));
  try {
    const f = await resolveSectionFilterForProject(dir);
    assert.equal(f.runtime_mode, 'auto');
    assert.equal(f.excluded.size, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('resolveSectionFilterForProject: KLAURO_CONTEXT_RUNTIME env applies when no param/config', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-ctx-'));
  const prev = process.env.KLAURO_CONTEXT_RUNTIME;
  try {
    process.env.KLAURO_CONTEXT_RUNTIME = 'exclude';
    const f = await resolveSectionFilterForProject(dir);
    assert.equal(f.runtime_mode, 'exclude');
    assert.equal(f.isExcluded('runtime'), true);
  } finally {
    if (prev === undefined) delete process.env.KLAURO_CONTEXT_RUNTIME;
    else process.env.KLAURO_CONTEXT_RUNTIME = prev;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
