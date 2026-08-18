import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';

const infrastructureRoot = path.resolve(__dirname, '../../..', 'infrastructure', 'vps');

function script(name: string): string {
  return fs.readFileSync(path.join(infrastructureRoot, name), 'utf8');
}

test('deployment selects source only after an optional release commit exists', () => {
  const source = script('deploy.sh');
  const release = source.indexOf('apps/mcp-server/scripts/release.sh');
  const selection = source.indexOf('DEPLOY_SHA_FULL=');
  assert.ok(release >= 0);
  assert.ok(selection > release);
  assert.match(source, /DEPLOY_SHA="\$DEPLOY_SHA_FULL"/);
  assert.match(source, /refusing to deploy from a dirty working tree/);
});

test('deployment verifies live server and client artifacts against the selected source', () => {
  const source = script('deploy.sh');
  assert.match(source, /LIVE_SHA=.*build\?\.git_sha/);
  assert.match(source, /\[ "\$LIVE_SHA" != "\$GIT_SHA" \]/);
  assert.match(source, /\[ "\$DIST_SHA" != "\$GIT_SHA" \]/);
});

test('candidate gates require candidate identity and preserve proof artifacts', () => {
  const gate = script('gate.sh');
  const sync = script('sync-gate-candidate.sh');
  assert.match(gate, /BUILD_STAMP="\$CANDIDATE_BUILD_STAMP"/);
  assert.match(gate, /gate source has no exact build identity/);
  assert.match(sync, /git archive --format=tar "\$CANDIDATE_SHA"/);
  assert.match(sync, /--exclude \.proof-output/);
  assert.match(sync, /chmod a\+rwx \/opt\/klauro\/devgate\/\.proof-output/);
});
