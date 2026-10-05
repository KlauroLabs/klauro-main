import test from 'node:test';
import assert from 'node:assert/strict';
import { localizeHostedWorkspacePath } from './hosted-path-localization';

test('a hosted workspace path in a query result becomes the client repo path everywhere it appears', () => {
  const result = {
    path: '/data/workspaces/prj_abc',
    readiness: { workspace: '/data/workspaces/prj_abc/src' },
    list: ['/data/workspaces/prj_abc', 'unrelated'],
  };
  assert.deepEqual(localizeHostedWorkspacePath(result, '/Users/dev/repo'), {
    path: '/Users/dev/repo',
    readiness: { workspace: '/Users/dev/repo/src' },
    list: ['/Users/dev/repo', 'unrelated'],
  });
});

test('results without an absolute hosted path, or already local, pass through untouched', () => {
  const local = { path: '/Users/dev/repo' };
  assert.equal(localizeHostedWorkspacePath(local, '/Users/dev/repo'), local);
  const relative = { path: 'src' };
  assert.equal(localizeHostedWorkspacePath(relative, '/Users/dev/repo'), relative);
  assert.equal(localizeHostedWorkspacePath(null, '/Users/dev/repo'), null);
  assert.deepEqual(localizeHostedWorkspacePath([1], '/Users/dev/repo'), [1]);
});
