import test from 'node:test';
import assert from 'node:assert/strict';
import { DeviceAuthStore } from './device-auth';

function user(id = 'usr_1') {
  return { id, email: 'dev@example.com', name: 'Dev', created_at: new Date().toISOString() };
}

test('issue produces a device_code and an 8-char dashed user_code', () => {
  const store = new DeviceAuthStore();
  const issued = store.issue('agent-desktop');
  assert.match(issued.device_code, /^[0-9a-f]{64}$/);
  assert.match(issued.user_code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.equal(issued.interval, 5);
  assert.ok(issued.expires_in > 0);
});

test('poll is pending before approval', () => {
  const store = new DeviceAuthStore();
  const issued = store.issue('agent-desktop');
  const pending = store.poll(issued.device_code, 'agent-desktop');
  assert.equal(pending.kind, 'pending');
});

test('the first poll after approval returns the token exactly once', () => {
  const store = new DeviceAuthStore();
  const issued = store.issue('agent-desktop');
  // Approved before this device's first-ever poll, so the interval throttle
  // (which only compares against a prior poll) cannot have anything to compare to.
  assert.equal(store.approve(issued.user_code, 'tok-abc', user()), true);

  const result = store.poll(issued.device_code, 'agent-desktop');
  assert.equal(result.kind, 'approved');
  if (result.kind === 'approved') {
    assert.equal(result.token, 'tok-abc');
    assert.equal(result.user.email, 'dev@example.com');
  }

  const again = store.poll(issued.device_code, 'agent-desktop');
  assert.equal(again.kind, 'not_found');
});

test('deny marks the code denied and consumes it on the next poll', () => {
  const store = new DeviceAuthStore();
  const issued = store.issue('agent-desktop');
  assert.equal(store.deny(issued.user_code), true);
  const denied = store.poll(issued.device_code, 'agent-desktop');
  assert.equal(denied.kind, 'denied');
  assert.equal(store.poll(issued.device_code, 'agent-desktop').kind, 'not_found');
});

test('a poll from the wrong client_id is rejected as not_found', () => {
  const store = new DeviceAuthStore();
  const issued = store.issue('agent-desktop');
  const result = store.poll(issued.device_code, 'some-other-client');
  assert.equal(result.kind, 'not_found');
});

test('approving an already-approved or unknown user_code fails', () => {
  const store = new DeviceAuthStore();
  const issued = store.issue('agent-desktop');
  assert.equal(store.approve(issued.user_code, 'tok-1', user()), true);
  assert.equal(store.approve(issued.user_code, 'tok-2', user()), false);
  assert.equal(store.approve('ZZZZ-ZZZZ', 'tok-3', user()), false);
});

test('user codes tolerate lowercase, stray spaces, and a missing dash', () => {
  const store = new DeviceAuthStore();
  const issued = store.issue('agent-desktop');
  const compact = issued.user_code.replace('-', '').toLowerCase();
  const found = store.findByUserCode(`  ${compact}  `);
  assert.equal(found?.deviceCode, issued.device_code);
});

test('polling faster than the interval returns slow_down without consuming the code', () => {
  const store = new DeviceAuthStore();
  const issued = store.issue('agent-desktop');
  store.approve(issued.user_code, 'tok-abc', user());
  const first = store.poll(issued.device_code, 'agent-desktop');
  assert.equal(first.kind, 'approved');
  // A fresh store/code pair to isolate the slow_down path from the one-shot approved path.
  const store2 = new DeviceAuthStore();
  const issued2 = store2.issue('agent-desktop');
  store2.poll(issued2.device_code, 'agent-desktop');
  const second = store2.poll(issued2.device_code, 'agent-desktop');
  assert.equal(second.kind, 'slow_down');
});
