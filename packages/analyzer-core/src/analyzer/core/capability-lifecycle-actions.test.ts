import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalCapabilityLifecycleAction, capabilityDescriptionExpressesDestructiveLifecycle } from './capability-lifecycle-actions';

describe('capability lifecycle actions', () => {
  test('distinguishes authentication from account registration on POST routes', () => {
    assert.equal(canonicalCapabilityLifecycleAction({ action: 'Create', trigger: { method: 'POST', path: '/login' } }), 'authenticate');
    assert.equal(canonicalCapabilityLifecycleAction({ action: 'Create', trigger: { method: 'POST', path: '/users/sign-in' } }), 'authenticate');
    assert.equal(canonicalCapabilityLifecycleAction({ action: 'Create', trigger: { method: 'POST', path: '/register' } }), 'create');
    assert.equal(canonicalCapabilityLifecycleAction({ action: 'Create', trigger: { method: 'POST', path: '/users/sign-up' } }), 'create');
  });

  test('normalizes destructive route lifecycles and their customer-visible wording', () => {
    assert.equal(canonicalCapabilityLifecycleAction({ action: 'Delete', trigger: { method: 'DELETE', path: '/articles/:slug/favorite' } }), 'unfavorite');
    assert.equal(canonicalCapabilityLifecycleAction({ action: 'Delete', trigger: { method: 'DELETE', path: '/profiles/:username/follow' } }), 'unfollow');
    assert.equal(capabilityDescriptionExpressesDestructiveLifecycle('Users can unfavorite an article later.'), true);
    assert.equal(capabilityDescriptionExpressesDestructiveLifecycle('Articles can be unfavored later.'), true);
    assert.equal(capabilityDescriptionExpressesDestructiveLifecycle('Users can view favorite articles.'), false);
  });
});
