import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

type BuildSourceIdentity = {
  resolveBuildGitSha(cwd: string, environment?: NodeJS.ProcessEnv): string;
  resolveBuildTime(environment?: NodeJS.ProcessEnv, now?: Date): string;
};

const buildSourceIdentity = createRequire(__filename)('../scripts/build-source-identity.cjs') as BuildSourceIdentity;

test('uses source identity supplied by a source-mirror or CI build', () => {
  assert.equal(buildSourceIdentity.resolveBuildGitSha('/unused', { KLAURO_GIT_SHA: '0a2fe599fd2f' }), '0a2fe599fd2f');
  assert.equal(buildSourceIdentity.resolveBuildGitSha('/unused', { KLAURO_GIT_SHA: '0a2fe599fd2f-dirty' }), '0a2fe599fd2f-dirty');
});

test('rejects build identities that cannot name a source revision', () => {
  for (const value of ['unknown', 'abc123', '0a2fe599fd2f-modified', '0a2fe599fd2f dirty']) {
    assert.throws(
      () => buildSourceIdentity.resolveBuildGitSha('/unused', { KLAURO_GIT_SHA: value }),
      /KLAURO_GIT_SHA/,
    );
  }
});

test('normalizes supplied build times and uses the provided clock otherwise', () => {
  assert.equal(
    buildSourceIdentity.resolveBuildTime({ KLAURO_BUILD_TIME: '2026-08-13T12:34:56-06:00' }),
    '2026-08-13T18:34:56.000Z',
  );
  assert.equal(
    buildSourceIdentity.resolveBuildTime({}, new Date('2026-08-13T18:34:56.789Z')),
    '2026-08-13T18:34:56.789Z',
  );
});

test('rejects invalid supplied build times', () => {
  assert.throws(
    () => buildSourceIdentity.resolveBuildTime({ KLAURO_BUILD_TIME: 'not-a-time' }),
    /KLAURO_BUILD_TIME/,
  );
});
