import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'http';
import type { AddressInfo } from 'net';

import { relayAuthorAsk } from './author-relay';

async function serving(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

test('the relay hands the request to the backend and returns its answer unchanged', async () => {
  const seen: string[] = [];
  const backend = await serving((request, response) => {
    let body = '';
    request.on('data', part => { body += part; });
    request.on('end', () => {
      seen.push(body);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"message":{"content":"{\\"ok\\":true}"}}');
    });
  });
  const relay = await serving((request, response) => { void relayAuthorAsk(request, response, 'user:a', `${backend.url}/api/chat`); });
  const answered = await fetch(relay.url, { method: 'POST', body: '{"messages":[]}' });
  assert.equal(answered.status, 200);
  assert.equal(await answered.text(), '{"message":{"content":"{\\"ok\\":true}"}}');
  assert.deepEqual(seen, ['{"messages":[]}']);
  await relay.close();
  await backend.close();
});

test('the relay says so when no backend is configured', async () => {
  const relay = await serving((request, response) => { void relayAuthorAsk(request, response, 'user:a', undefined); });
  const answered = await fetch(relay.url, { method: 'POST', body: '{}' });
  assert.equal(answered.status, 503);
  await relay.close();
});

test('the relay refuses a request too large to hand on', async () => {
  const relay = await serving((request, response) => { void relayAuthorAsk(request, response, 'user:a', 'http://127.0.0.1:9/api/chat'); });
  const answered = await fetch(relay.url, { method: 'POST', body: 'x'.repeat(5 * 1024 * 1024) });
  assert.equal(answered.status, 413);
  await relay.close();
});

test('the relay reports a backend that cannot be reached', async () => {
  const relay = await serving((request, response) => { void relayAuthorAsk(request, response, 'user:a', 'http://127.0.0.1:9/api/chat'); });
  const answered = await fetch(relay.url, { method: 'POST', body: '{}' });
  assert.equal(answered.status, 502);
  await relay.close();
});
