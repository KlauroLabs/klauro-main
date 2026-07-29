import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as net from 'node:net';
import {
  HostedTransportError,
  describeHttpFailure,
  describeTransportFailure,
  findErrorCode,
  hostedFetch,
  isRetriableTransportError,
  redactUrl,
  unwrapCauseChain,
} from './hosted-transport';
import { isOpaqueErrorMessage, withTransparentErrors } from './installed-client-server';

// The defect these cover: Node wraps every network-level failure in
// `TypeError: fetch failed`, whose real content lives in `cause` (recursively).
// Reporting the wrapper alone discards the diagnosis and leaves the caller —
// an agent — with no next step.

function wrapped(): Error {
  const inner = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' });
  const outer = new TypeError('fetch failed');
  (outer as { cause?: unknown }).cause = inner;
  return outer;
}

test('unwrapCauseChain reaches the frame that names the condition', () => {
  const chain = unwrapCauseChain(wrapped());
  assert.equal(chain[0], 'fetch failed');
  assert.ok(chain.some(frame => frame.includes('ECONNREFUSED')), `chain lost the cause: ${JSON.stringify(chain)}`);
});

test('unwrapCauseChain descends into AggregateError.errors', () => {
  // Happy Eyeballs reports every failed candidate address in `errors`, not in
  // `cause`; a chain that only follows `cause` dead-ends at the aggregate.
  const aggregate = new AggregateError(
    [Object.assign(new Error('connect EHOSTUNREACH 2001:db8::1:443'), { code: 'EHOSTUNREACH' })],
    'all attempts failed',
  );
  const outer = new TypeError('fetch failed');
  (outer as { cause?: unknown }).cause = aggregate;
  assert.ok(unwrapCauseChain(outer).some(frame => frame.includes('EHOSTUNREACH')));
});

test('unwrapCauseChain terminates on a cyclic cause', () => {
  const a = new Error('a');
  const b = new Error('b');
  (a as { cause?: unknown }).cause = b;
  (b as { cause?: unknown }).cause = a;
  assert.deepEqual(unwrapCauseChain(a), ['a', 'b']);
});

test('findErrorCode reads through the wrapper', () => {
  assert.equal(findErrorCode(wrapped()), 'ECONNREFUSED');
  assert.equal(findErrorCode(new Error('plain')), undefined);
});

test('transport faults are retriable and definitive failures are not', () => {
  assert.ok(isRetriableTransportError(wrapped()));
  assert.ok(isRetriableTransportError(new TypeError('fetch failed')), 'the bare envelope is still a transport fault');
  assert.ok(isRetriableTransportError(Object.assign(new Error('abort'), { name: 'AbortError' })));
  assert.ok(
    isRetriableTransportError(new TypeError('fetch failed', { cause: new Error('ssl3_read_bytes:ssl/tls alert bad record mac') })),
    'a corrupted TLS record on one connection says nothing about the next one',
  );
  assert.equal(
    isRetriableTransportError(Object.assign(new Error('bad cert'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' })),
    false,
    'a rejected certificate is not cleared by retrying — retrying only delays an honest report',
  );
});

test('a transport failure description names the cause, the target, and a remediation', () => {
  const message = describeTransportFailure(wrapped(), {
    url: 'https://example.invalid/api/projects/prj_x/analysis',
    operation: 'GET analysis',
    attempts: 4,
  });
  assert.ok(message.includes('ECONNREFUSED'), message);
  assert.ok(message.includes('example.invalid'), message);
  assert.ok(message.includes('4 attempts'), message);
  assert.ok(/`klauro [a-z-]+`/.test(message), `no remediation command: ${message}`);
  assert.notEqual(message.trim(), 'fetch failed');
});

test('remediation is specific to the cause rather than generic', () => {
  const context = { url: 'https://example.invalid/x', operation: 'GET analysis', attempts: 1 };
  const dns = describeTransportFailure(Object.assign(new Error('getaddrinfo ENOTFOUND example.invalid'), { code: 'ENOTFOUND' }), context);
  assert.ok(/did not resolve/i.test(dns), dns);
  const tls = describeTransportFailure(new TypeError('fetch failed', { cause: new Error('ssl3_read_bytes:ssl/tls alert bad record mac') }), context);
  assert.ok(/TLS/i.test(tls), tls);
  assert.ok(/proxy|middlebox|network path/i.test(tls), tls);
});

test('credentials never reach an error message an agent will echo', () => {
  assert.equal(redactUrl('https://user:secret@example.invalid/a'), 'https://example.invalid/a');
  assert.ok(redactUrl('https://example.invalid/a?token=abc123').includes('REDACTED'));
  assert.ok(!redactUrl('https://example.invalid/a?token=abc123').includes('abc123'));
});

test('hostedFetch retries a transport fault and then reports the unwrapped cause', async () => {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));

  process.env.KLAURO_HOSTED_RETRY_DELAY_MS = '0';
  try {
    await hostedFetch(`http://127.0.0.1:${port}/api`, {}, { operation: 'GET analysis' });
    assert.fail('a closed port must not resolve');
  } catch (error) {
    assert.ok(error instanceof HostedTransportError, `expected HostedTransportError, got ${error}`);
    assert.equal(error.code, 'ECONNREFUSED');
    assert.equal(error.attempts, 4, 'a transport fault must be retried before it is reported');
    assert.ok(error.message.includes(`127.0.0.1:${port}`), error.message);
    assert.ok(error.message.includes('ECONNREFUSED'), error.message);
    assert.ok(/`klauro [a-z-]+`/.test(error.message), error.message);
  } finally {
    delete process.env.KLAURO_HOSTED_RETRY_DELAY_MS;
  }
});

test('hostedFetch resolves any completed exchange and leaves status to the caller', async () => {
  const server = http.createServer((_request, response) => { response.writeHead(503).end('busy'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  try {
    const response = await hostedFetch(`http://127.0.0.1:${port}/api`, {}, { operation: 'GET analysis' });
    assert.equal(response.status, 503);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('an HTTP failure names the status, the target, and what to do about it', async () => {
  const cases: Array<[number, string, string, RegExp]> = [
    [401, 'application/json', JSON.stringify({ error: 'no token' }), /klauro auth-status|klauro login/],
    [404, 'application/json', JSON.stringify({ error: 'no project' }), /klauro status/],
    [426, 'application/json', JSON.stringify({ error: 'upgrade' }), /klauro update/],
    [502, 'text/html', '<html>edge error</html>', /Retry/],
  ];
  for (const [status, contentType, body, remediation] of cases) {
    const response = new Response(body, { status, headers: { 'content-type': contentType } });
    const message = await describeHttpFailure(response, { url: 'https://example.invalid/api/x', operation: 'GET analysis' });
    assert.ok(message.includes(String(status)), message);
    assert.ok(message.includes('example.invalid'), message);
    assert.ok(remediation.test(message), `HTTP ${status}: ${message}`);
  }
});

test('the tool wrapper refuses to let an opaque message leave the process', async () => {
  assert.ok(isOpaqueErrorMessage('fetch failed'));
  assert.ok(isOpaqueErrorMessage('  Fetch Failed '));
  assert.equal(isOpaqueErrorMessage('Klauro could not reach the hosted server'), false);

  const registered: Array<(args: unknown) => Promise<unknown>> = [];
  const register = withTransparentErrors(((_name: string, _config: unknown, handler: any) => {
    registered.push(handler);
  }) as any);

  register('get_summary', {}, async () => { throw wrapped(); });
  await assert.rejects(registered[0]({}), (error: Error) => {
    assert.notEqual(error.message.trim(), 'fetch failed');
    assert.ok(error.message.includes('get_summary'), error.message);
    assert.ok(error.message.includes('ECONNREFUSED'), error.message);
    assert.ok(/`klauro [a-z-]+`/.test(error.message), error.message);
    return true;
  });

  // An error that already explains itself passes through untouched — the
  // wrapper is a floor, not a rewriter.
  register('get_summary', {}, async () => { throw new Error('No hosted Klauro project is bound to /x.'); });
  await assert.rejects(registered[1]({}), /No hosted Klauro project is bound/);
});
