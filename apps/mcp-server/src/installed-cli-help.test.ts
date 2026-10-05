import test from 'node:test';
import assert from 'node:assert/strict';
import { usageText } from './installed-cli-help';

test('a subcommand prints only its own usage, including every alias', () => {
  const init = usageText('init');
  assert.match(init, /^Usage: klauro init/);
  assert.match(init, /Configure a project for hosted Klauro analysis/);
  assert.doesNotMatch(init, /install {21}/);
  assert.doesNotMatch(init, /upload-manifest/);
  assert.match(usageText('install'), /Register the lightweight MCP/);
  assert.doesNotMatch(usageText('install'), /Configure a project/);
  assert.match(usageText('sync'), /remote-sync/);
});

test('the global usage lists every command and an unknown command falls back to it', () => {
  const global = usageText();
  assert.match(global, /^Usage: klauro <command> \[path\] \[options\]/);
  for (const name of ['init', 'install', 'analyze', 'status', 'doctor', 'login']) assert.match(global, new RegExp(`\\b${name}\\b`));
  assert.equal(usageText('no-such-command'), global);
});
