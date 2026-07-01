import test from 'node:test';
import assert from 'node:assert/strict';
import { detectRemoteProvider } from './remote-provider';

test('detectRemoteProvider parses GitHub HTTPS remotes and suggests GitHub App connection', () => {
  const provider = detectRemoteProvider('https://github.com/acme/api.git');
  assert.equal(provider?.provider, 'github');
  assert.equal(provider?.owner, 'acme');
  assert.equal(provider?.repository, 'api');
  assert.equal(provider?.repository_url, 'https://github.com/acme/api');
  assert.equal(provider?.connectable, true);
  assert.equal(provider?.suggested_connection?.type, 'github_app');
});

test('detectRemoteProvider parses SSH remotes for common hosted providers', () => {
  const provider = detectRemoteProvider('git@gitlab.com:acme/worker.git');
  assert.equal(provider?.provider, 'gitlab');
  assert.equal(provider?.owner, 'acme');
  assert.equal(provider?.repository, 'worker');
  assert.equal(provider?.connectable, true);
});

test('detectRemoteProvider marks unknown hosts as custom instead of pretending they are connectable', () => {
  const provider = detectRemoteProvider('ssh://git@git.internal/acme/api.git');
  assert.equal(provider?.provider, 'custom');
  assert.equal(provider?.connectable, false);
});
