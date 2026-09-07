import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { verifyAgentSourceInputs } from './agent-source-input-verification';
import { compactCasSourceInputIdentities } from '../../../packages/analyzer-core/src/analyzer/core/cas-source-input-identities';

function fixture(t: TestContext, content: string | Buffer = 'export const value = 1;\n') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-input-identity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'target.ts'), content);
  return root;
}

function contribution(content: string | Buffer, file = 'target.ts') {
  return {
    source_inputs: {
      version: 1, coverage: 'observed-reads', digest_algorithm: 'sha256', outside_root_reads: 0,
      files: [{ path: file, status: 'captured', representation: Buffer.isBuffer(content) ? 'bytes' : 'utf8-text',
        sha256: createHash('sha256').update(content).digest('hex'),
        bytes: typeof content === 'string' ? Buffer.byteLength(content) : content.length }],
    },
  };
}

test('referenced identities preserve raw comparison results without expanding every observation', t => {
  const root = fixture(t, 'current');
  const catalog = { analyzer_contributions: [contribution('current'), contribution('current')] } as unknown as Parameters<typeof compactCasSourceInputIdentities>[0];
  const raw = verifyAgentSourceInputs(root, ['target.ts'], catalog.analyzer_contributions);
  compactCasSourceInputIdentities(catalog);
  const referenced = verifyAgentSourceInputs(root, ['target.ts'], catalog.analyzer_contributions, {}, catalog.source_input_identities);
  assert.deepEqual(referenced.results, raw.results);
  assert.equal(referenced.summary.scan.bytes_read, raw.summary.scan.bytes_read);
  assert.equal(referenced.summary.scan.input_records_scanned, 2);
  fs.writeFileSync(path.join(root, 'target.ts'), 'changed');
  assert.equal(verifyAgentSourceInputs(root, ['target.ts'], catalog.analyzer_contributions, {}, catalog.source_input_identities).results[0].status, 'mismatched');
});

test('absent or invalid reference tables cannot look matched', t => {
  const root = fixture(t, 'current');
  const catalog = { analyzer_contributions: [contribution('current')] } as unknown as Parameters<typeof compactCasSourceInputIdentities>[0];
  compactCasSourceInputIdentities(catalog);
  assert.equal(verifyAgentSourceInputs(root, ['target.ts'], catalog.analyzer_contributions).results[0].reason, 'source-input-table-unavailable');
  const inputs = catalog.analyzer_contributions[0].source_inputs;
  assert.ok(inputs?.version === 2);
  for (const index of [-1, 100, 0.5, '0']) {
    inputs.identity_indices = [index as number];
    const result = verifyAgentSourceInputs(root, ['target.ts'], catalog.analyzer_contributions, {}, catalog.source_input_identities);
    assert.equal(result.results[0].reason, 'invalid-input-reference');
    assert.equal(result.summary.scan.bytes_read, 0);
  }
});

test('referenced input observations remain subject to the same scan budget', t => {
  const root = fixture(t, 'current');
  const catalog = { analyzer_contributions: [contribution('current'), contribution('current')] } as unknown as Parameters<typeof compactCasSourceInputIdentities>[0];
  compactCasSourceInputIdentities(catalog);
  const result = verifyAgentSourceInputs(root, ['target.ts'], catalog.analyzer_contributions, { max_input_records: 1 }, catalog.source_input_identities);
  assert.equal(result.results[0].reason, 'input-record-budget');
  assert.equal(result.summary.scan.bytes_read, 0);
});

test('outside-workspace citations are labeled before unavailable-identity lookup', t => {
  const result = verifyAgentSourceInputs(fixture(t), ['../outside.ts', 'C:\\outside\\file.ts']);
  assert.ok(result.results.every(item => item.reason === 'outside-workspace'));
  assert.equal(result.summary.scan.bytes_read, 0);
});

test('valid observed identities match without claiming complete analysis coverage', t => {
  const root = fixture(t);
  const baseline = contribution(fs.readFileSync(path.join(root, 'target.ts'), 'utf8'));
  const result = verifyAgentSourceInputs(root, ['target.ts'], [baseline, { analyzer_name: 'legacy' }]);
  assert.equal(result.results[0].status, 'matched');
  assert.equal(result.summary.certifies_complete_analysis, false);
  assert.equal(result.summary.scan.files_compared, 1);
  assert.equal(result.summary.scan.bytes_read, 48);
});

test('comparison preserves raw bytes and decoded UTF8 semantics across chunk boundaries', t => {
  const content = Buffer.concat([Buffer.alloc(65535, 65), Buffer.from([0xe2, 0x82, 0xac, 0xff, 0xe2])]);
  const root = fixture(t, content);
  const result = verifyAgentSourceInputs(root, ['target.ts'], [contribution(content), contribution(content.toString('utf8'))]);
  assert.equal(result.results[0].status, 'matched');
  assert.equal(result.summary.scan.bytes_read, content.length * 2);
});

test('empty input identities are valid evidence', t => {
  const result = verifyAgentSourceInputs(fixture(t, ''), ['target.ts'], [contribution('')]);
  assert.equal(result.results[0].status, 'matched');
  assert.equal(result.summary.scan.bytes_read, 0);
});

test('changing content with preserved timestamps is a captured-input mismatch', t => {
  const root = fixture(t, 'before');
  const file = path.join(root, 'target.ts');
  fs.writeFileSync(file, 'after!');
  fs.utimesSync(file, 1, 1);
  const result = verifyAgentSourceInputs(root, ['target.ts'], [contribution('before')]);
  assert.equal(result.results[0].status, 'mismatched');
});

test('conflicting analyzers cannot produce a matched verdict', t => {
  const root = fixture(t, 'current');
  const result = verifyAgentSourceInputs(root, ['target.ts'], [contribution('current'), contribution('old')]);
  assert.equal(result.results[0].reason, 'conflicting-input-identities');
  assert.equal(result.summary.scan.bytes_read, 0);
});

test('explicit conflicts and unavailable identities remain unknown', t => {
  const root = fixture(t, 'current');
  for (const status of ['conflicting', 'unavailable']) {
    const unavailable = contribution('current');
    unavailable.source_inputs.files[0].status = status;
    const result = verifyAgentSourceInputs(root, ['target.ts'], [contribution('current'), unavailable]);
    assert.equal(result.results[0].status, 'unverified');
    assert.equal(result.summary.scan.bytes_read, 0);
  }
});

test('legacy and invalidated incremental metadata never acquire current-source identities', t => {
  const root = fixture(t);
  t.mock.method(fs, 'openSync', () => { throw new Error('must not read without a baseline'); });
  for (const contributions of [[], [{}], [{ source_inputs: { coverage: 'unavailable', files: [] } }]]) {
    const result = verifyAgentSourceInputs(root, ['target.ts'], contributions);
    assert.equal(result.results[0].reason, 'analyzed-content-identity-unavailable');
    assert.equal(result.summary.scan.bytes_read, 0);
  }
});

test('malformed identity values and unsupported metadata are explicit gaps', t => {
  const root = fixture(t, 'current');
  const malformed = contribution('current');
  malformed.source_inputs.files[0].sha256 = 'abc';
  assert.equal(verifyAgentSourceInputs(root, ['target.ts'], [malformed]).results[0].reason, 'invalid-input-identity');
  const unsupported = contribution('current');
  unsupported.source_inputs.version = 2;
  assert.equal(verifyAgentSourceInputs(root, ['target.ts'], [unsupported]).results[0].reason, 'unsupported-input-metadata');
  const invalidPath = contribution('current', '../target.ts');
  assert.equal(verifyAgentSourceInputs(root, ['target.ts'], [invalidPath]).results[0].reason, 'invalid-input-path');
});

test('byte and record budgets disclose unverified evidence without reading outside budget', t => {
  const root = fixture(t, '123456789');
  const baseline = contribution('123456789');
  const bytes = verifyAgentSourceInputs(root, ['target.ts'], [baseline], { max_bytes: 8 });
  assert.equal(bytes.results[0].reason, 'source-byte-budget');
  assert.equal(bytes.summary.scan.bytes_read, 0);
  const records = verifyAgentSourceInputs(root, ['target.ts'], [baseline, baseline], { max_input_records: 1 });
  assert.equal(records.results[0].reason, 'input-record-budget');
  assert.equal(records.summary.scan.bytes_read, 0);
  const time = verifyAgentSourceInputs(root, ['target.ts'], [baseline], { max_duration_ms: 0 });
  assert.equal(time.results[0].reason, 'verification-time-budget');
});

test('a shared byte budget bounds multiple file comparisons', t => {
  const root = fixture(t, '1234');
  fs.writeFileSync(path.join(root, 'second.ts'), '5678');
  const result = verifyAgentSourceInputs(root, ['target.ts', 'second.ts'],
    [contribution('1234'), contribution('5678', 'second.ts')], { max_bytes: 10 });
  assert.equal(result.results[0].status, 'matched');
  assert.equal(result.results[1].reason, 'source-byte-budget');
  assert.equal(result.summary.scan.bytes_read, 8);
});

test('symlinks outside the root and nonregular files are never read', t => {
  const root = fixture(t, 'inside');
  const outside = fixture(t, 'outside');
  fs.symlinkSync(path.join(outside, 'target.ts'), path.join(root, 'external.ts'));
  fs.mkdirSync(path.join(root, 'directory'));
  const result = verifyAgentSourceInputs(root, ['external.ts', 'directory'],
    [contribution('outside', 'external.ts'), contribution('', 'directory')]);
  assert.equal(result.results[0].reason, 'outside-workspace');
  assert.equal(result.results[1].reason, 'not-a-regular-file');
  assert.equal(result.summary.scan.bytes_read, 0);
});

test('source access errors retain the actual code and do not count as differences', t => {
  const root = fixture(t, 'current');
  t.mock.method(fs, 'openSync', () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); });
  const result = verifyAgentSourceInputs(root, ['target.ts'], [contribution('current')]);
  assert.equal(result.results[0].status, 'unverified');
  assert.equal(result.results[0].error_code, 'EACCES');
  assert.equal(result.summary.mismatched.count, 0);
});

test('mutating a file during the read cannot yield a content match', t => {
  const root = fixture(t, 'before');
  const originalRead = fs.readSync;
  t.mock.method(fs, 'readSync', (...args: Parameters<typeof fs.readSync>) => {
    const result = originalRead(...args);
    fs.writeFileSync(path.join(root, 'target.ts'), 'after!');
    return result;
  });
  const result = verifyAgentSourceInputs(root, ['target.ts'], [contribution('before')]);
  assert.equal(result.results[0].reason, 'source-changed-during-verification');
});

test('replacing a path with identical bytes during a read remains unverifiable', t => {
  const root = fixture(t, 'same');
  const originalRead = fs.readSync;
  let replaced = false;
  t.mock.method(fs, 'readSync', (...args: Parameters<typeof fs.readSync>) => {
    const result = originalRead(...args);
    if (replaced) return result;
    replaced = true;
    fs.renameSync(path.join(root, 'target.ts'), path.join(root, 'previous.ts'));
    fs.writeFileSync(path.join(root, 'target.ts'), 'same');
    return result;
  });
  assert.equal(verifyAgentSourceInputs(root, ['target.ts'], [contribution('same')]).results[0].reason,
    'source-changed-during-verification');
});

test('read failures close file descriptors and retain explicit uncertainty', t => {
  const root = fixture(t, 'same');
  const actualClose = fs.closeSync;
  let closed = 0;
  t.mock.method(fs, 'readSync', () => { throw Object.assign(new Error('io'), { code: 'EIO' }); });
  t.mock.method(fs, 'closeSync', (descriptor: number) => { closed++; return actualClose(descriptor); });
  const result = verifyAgentSourceInputs(root, ['target.ts'], [contribution('same')]);
  assert.equal(result.results[0].error_code, 'EIO');
  assert.equal(closed, 1);
});
