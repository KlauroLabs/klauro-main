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

test('deployment stages and validates the exact commit without local build workloads', () => {
  const source = script('deploy.sh');
  assert.match(source, /sync-gate-candidate\.sh" --commit "\$DEPLOY_SHA_FULL"/);
  assert.match(source, /\$SSH "\$DEST" .*spec-purity-gate-cli\.ts/);
  assert.match(source, /\$SSH "\$DEST" .*file-size-ratchet-gate-cli\.ts/);
  assert.match(source, /\$SSH "\$DEST" .*--run-as-root .*VITE_KLAURO_API_URL=.*npm run app:build/);
  assert.doesNotMatch(source, /\( cd "\$APP_DIR\/apps\/mcp-server" && npx tsx/);
  assert.doesNotMatch(source, /\n  VITE_KLAURO_API_URL="\$KLAURO_URL" npm run app:build/);
  assert.doesNotMatch(source, /rsync .*apps\/app\/dist\/.*\$DEST/);
  assert.match(source, /rsync -a --delete \/opt\/klauro\/devgate\/apps\/app\/dist\/ \/opt\/klauro\/app-dist\//);
  assert.match(source, /--exclude \.proof-output/);
});

test('candidate gates require candidate identity and preserve proof artifacts', () => {
  const gate = script('gate.sh');
  const sync = script('sync-gate-candidate.sh');
  assert.match(gate, /BUILD_STAMP="\$CANDIDATE_BUILD_STAMP"/);
  assert.match(gate, /gate source has no exact build identity/);
  assert.match(sync, /git archive --format=tar "\$CANDIDATE_SHA"/);
  assert.match(sync, /CANDIDATE_REF="\$\{2:-\}"/);
  assert.match(sync, /git rev-parse "\$\{CANDIDATE_REF\}\^\{commit\}"/);
  assert.match(sync, /sha256sum \/opt\/klauro\/devgate\/package-lock\.json/);
  assert.match(sync, /docker run --rm .*npm ci --include=dev --legacy-peer-deps/s);
  assert.match(sync, /--exclude \.proof-output/);
  assert.match(sync, /chmod a\+rwx \/opt\/klauro\/devgate\/\.proof-output/);
});
