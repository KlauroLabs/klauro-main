const { spawnSync } = require('node:child_process');

const SHA_PATTERN = /^[0-9a-f]{7,40}(?:-dirty)?$/i;

function resolveBuildGitSha(cwd, environment = process.env) {
  const injected = String(environment.KLAURO_GIT_SHA || '').trim();
  if (injected) {
    if (!SHA_PATTERN.test(injected)) throw new Error(`KLAURO_GIT_SHA must be a 7-40 character hexadecimal commit id with an optional -dirty suffix, received ${JSON.stringify(injected)}`);
    return injected;
  }
  const result = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd, encoding: 'utf8' });
  if (result.status !== 0) return 'unknown';
  const sha = String(result.stdout || '').trim();
  const status = spawnSync('git', ['status', '--porcelain', '-uall'], { cwd, encoding: 'utf8' });
  return status.status === 0 && String(status.stdout || '').trim() ? `${sha}-dirty` : sha;
}

function resolveBuildTime(environment = process.env, now = new Date()) {
  const injected = String(environment.KLAURO_BUILD_TIME || '').trim();
  if (!injected) return now.toISOString();
  const parsed = new Date(injected);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`KLAURO_BUILD_TIME must be a valid timestamp, received ${JSON.stringify(injected)}`);
  return parsed.toISOString();
}

module.exports = { resolveBuildGitSha, resolveBuildTime };
