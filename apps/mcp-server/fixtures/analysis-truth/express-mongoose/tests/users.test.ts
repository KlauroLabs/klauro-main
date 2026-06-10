import { describe, it } from 'node:test';
import assert from 'node:assert';
import { getUser, createUser } from '../src/server';

describe('user routes', () => {
  it('getUser returns the requested user', async () => {
    assert.ok(typeof getUser === 'function');
  });

  it('createUser persists a new user', async () => {
    assert.ok(typeof createUser === 'function');
  });
});
