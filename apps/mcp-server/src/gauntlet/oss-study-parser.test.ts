import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCallableCtags } from './oss-study';

test('parseCallableCtags keeps callable tags and rejects non-callable tags', () => {
  const output = [
    JSON.stringify({ _type: 'tag', name: 'serve', path: 'app.ts', kind: 'function' }),
    JSON.stringify({ _type: 'tag', name: 'save', path: 'account.ts', kind: 'method' }),
    JSON.stringify({ _type: 'tag', name: 'Account', path: 'account.ts', kind: 'class' }),
    JSON.stringify({ _type: 'tag', name: 'port', path: 'config.ts', kind: 'variable' }),
    JSON.stringify({ _type: 'tag', name: 'heading', path: 'README.md', kind: 'function' }),
    'not-json',
  ].join('\n');

  assert.deepEqual(parseCallableCtags(output).sort(), ['save', 'serve']);
});
