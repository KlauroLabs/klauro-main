import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { AccountHttpError, AccountStore } from './account-store';

/**
 * Test-only helper: the login-throttle backoff (see loginBackoffMs) is
 * intentionally applied even to the NEXT correct-password attempt right
 * after a failure — that's the point of a throttle. Several tests here
 * deliberately trigger one failed login to assert on it, then need to log
 * in for real immediately after; this clears the throttle on disk the same
 * way real wall-clock time would, without slowing the test suite down.
 */
function clearLoginThrottleOnDisk(root: string): void {
  const dbPath = path.join(root, 'accounts', 'accounts.json');
  const raw = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  raw.login_throttles = [];
  fs.writeFileSync(dbPath, JSON.stringify(raw, null, 2));
}

test('account store creates users, default workspaces, sessions, and projects', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-accounts-'));
  const store = new AccountStore(root);

  try {
    const created = await store.register({
      email: 'Owner@Example.com',
      name: 'Owner User',
      password: 'correct horse battery staple',
      workspaceName: 'Main Workspace',
    });

    assert.equal(created.user.email, 'owner@example.com');
    assert.ok(created.token.startsWith('ks_'));
    assert.equal((await store.authenticate(created.token))?.id, created.user.id);

    const workspaces = await store.listWorkspaces(created.user.id);
    assert.equal(workspaces.length, 1);
    assert.equal(workspaces[0].name, 'Main Workspace');
    assert.equal(workspaces[0].role, 'owner');

    const project = await store.createProject(created.user.id, workspaces[0].id, {
      name: 'API',
      repo_url: 'https://github.com/example/api',
      local_path: '/tmp/api',
    });

    assert.equal(project.workspace_id, workspaces[0].id);
    assert.equal((await store.listProjects(created.user.id, workspaces[0].id)).length, 1);
    assert.equal((await store.getProjectForUser(created.user.id, project.id))?.name, 'API');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('account store supports many users across many workspaces', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-accounts-members-'));
  const store = new AccountStore(root);

  try {
    const owner = await store.register({ email: 'owner@example.com', password: 'password-1234', workspaceName: 'Alpha' });
    const member = await store.register({ email: 'member@example.com', password: 'password-1234', workspaceName: 'Personal' });
    const alpha = (await store.listWorkspaces(owner.user.id))[0];
    const beta = await store.createWorkspace(owner.user.id, { name: 'Beta' });

    await store.addWorkspaceUser(owner.user.id, alpha.id, { email: member.user.email, role: 'member' });
    await store.addWorkspaceUser(owner.user.id, beta.id, { email: member.user.email, role: 'admin' });

    const memberWorkspaces = await store.listWorkspaces(member.user.id);
    assert.deepEqual(memberWorkspaces.map(workspace => workspace.name).sort(), ['Alpha', 'Beta', 'Personal']);
    assert.equal((await store.listWorkspaceUsers(member.user.id, alpha.id)).length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('account store rejects invalid login and cross-workspace project access', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-accounts-authz-'));
  const store = new AccountStore(root);

  try {
    const owner = await store.register({ email: 'owner@example.com', password: 'password-1234', workspaceName: 'Owned' });
    const outsider = await store.register({ email: 'outsider@example.com', password: 'password-1234', workspaceName: 'Other' });
    const workspace = (await store.listWorkspaces(owner.user.id))[0];
    const project = await store.createProject(owner.user.id, workspace.id, { name: 'Private Repo' });

    await assert.rejects(
      () => store.login({ email: owner.user.email, password: 'wrong-password' }),
      (error: unknown) => error instanceof AccountHttpError && error.statusCode === 401,
    );
    // task #127 defect 1: the cross-tenant 404 must name the CALLER's own
    // account (so an agent/customer never has to run a second command just
    // to learn who it's signed in as) and must NEVER name or otherwise leak
    // the owning account/workspace's identity — only that the project
    // belongs to someone else.
    await assert.rejects(
      () => store.getProjectForUser(outsider.user.id, project.id),
      (error: unknown) => {
        if (!(error instanceof AccountHttpError) || error.statusCode !== 404) return false;
        assert.match(error.message, /Signed in as outsider@example\.com/);
        assert.match(error.message, /no access/);
        assert.doesNotMatch(error.message, /owner@example\.com/, 'must never name the owning account');
        return true;
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('account store 404 distinguishes a truly nonexistent project id from one owned by another account', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-accounts-404-shapes-'));
  const store = new AccountStore(root);

  try {
    const outsider = await store.register({ email: 'outsider2@example.com', password: 'password-1234', workspaceName: 'Other' });

    // A project id that was never created anywhere on this server.
    await assert.rejects(
      () => store.getProjectForUser(outsider.user.id, 'prj_does_not_exist'),
      (error: unknown) => {
        if (!(error instanceof AccountHttpError) || error.statusCode !== 404) return false;
        assert.match(error.message, /was not found on this server/);
        assert.doesNotMatch(error.message, /Signed in as/, 'a genuinely-missing project must not claim a specific account lacks access to it');
        return true;
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// §COORD-AUTH-401 regression — TASK #68: a 10-agent fleet reported
// /v1/coordination/* flipping from working to 401 ~30-40 min into a session,
// with the same Bearer token freshly read from disk each time. Root cause:
// every AccountStore mutation used to be a bare `load()` ... `save(db)` pair
// with NO locking around the read-modify-write span — `save()`'s writeQueue
// only serialized the physical `fs.writeJson` calls, not the critical
// section. Two concurrent mutations (e.g. one lane's `/v1/analyze` push
// calling setProjectAnalysisId while another lane logs in) could both load()
// the same snapshot, mutate independently, then the second save() clobbers
// the first — silently dropping the first mutation's session/data (a lost
// update). This test fires a burst of concurrent session-creating (login)
// and non-session (setProjectAnalysisId) mutations at ONE store instance —
// the same shape a multi-lane fleet produces — and asserts every session
// survives and authenticates. Before the AccountStore.mutate() fix, this
// reliably lost sessions under concurrency; after the fix, none are lost.
test('concurrent account mutations never lose a session (lost-update regression)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-accounts-race-'));
  const store = new AccountStore(root);

  try {
    const owner = await store.register({ email: 'fleet-owner@example.com', password: 'password-1234', workspaceName: 'Fleet' });
    const workspace = (await store.listWorkspaces(owner.user.id))[0];
    const project = await store.createProject(owner.user.id, workspace.id, { name: 'Coordinated Repo' });

    const LANES = 25;
    // Every lane registers its own account (each register() call is itself
    // a multi-record mutation: user + workspace + membership + session) AND
    // concurrently the "owner" lane hammers setProjectAnalysisId — the
    // highest-frequency real-world write (fires on every /v1/analyze push) —
    // to maximize interleaving against the registrations.
    const registrations = Promise.all(
      Array.from({ length: LANES }, (_, i) =>
        store.register({ email: `lane-${i}@example.com`, password: 'password-1234' })),
    );
    const pushes = Promise.all(
      Array.from({ length: LANES }, (_, i) =>
        store.setProjectAnalysisId(owner.user.id, project.id, `analysis-${i}`)),
    );

    const [lanes] = await Promise.all([registrations, pushes]);

    // Every lane's session must still authenticate — none silently dropped
    // by an overwritten save().
    for (const lane of lanes) {
      const authed = await store.authenticate(lane.token);
      assert.ok(authed, `session for ${lane.user.email} was lost to a concurrent-write race`);
      assert.equal(authed?.id, lane.user.id);
    }

    // The owner's own original session (created by the very first register())
    // must ALSO have survived every subsequent concurrent mutation.
    assert.ok(await store.authenticate(owner.token), 'the pre-existing owner session was dropped by a concurrent mutation');

    // The project write itself must have landed (whichever push happened to
    // be last is fine — the point is the store is never left corrupt/blank).
    const finalProject = await store.getProjectForUser(owner.user.id, project.id);
    assert.ok(finalProject?.analysis_id?.startsWith('analysis-'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// §AUTH-LIFECYCLE — password reset: mint (operator-only) -> redeem (public,
// token-authorized) -> old password dead, new password works, ALL prior
// sessions for that user are gone (a reset that leaves old sessions alive is
// the security defect the task called out explicitly).
test('password reset token: mint, redeem, invalidates all sessions, single-use', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-accounts-reset-'));
  const store = new AccountStore(root);

  try {
    const owner = await store.register({ email: 'locked-out@example.com', password: 'original-password-1', workspaceName: 'Locked' });
    // A second session (e.g. a different device) for the same account — must also die on reset.
    const secondSession = await store.login({ email: owner.user.email, password: 'original-password-1' });

    const minted = await store.mintPasswordResetToken({ email: owner.user.email, mintedBy: 'operator:test' });
    assert.ok(minted.token.startsWith('krt_'));
    assert.equal(minted.userId, owner.user.id);

    const redeemed = await store.redeemPasswordResetToken({ token: minted.token, newPassword: 'brand-new-password-2' });
    assert.equal(redeemed.userId, owner.user.id);
    assert.equal(redeemed.email, owner.user.email);

    // Old sessions are dead.
    assert.equal(await store.authenticate(owner.token), null);
    assert.equal(await store.authenticate(secondSession.token), null);

    // Old password no longer works; new password does.
    await assert.rejects(
      () => store.login({ email: owner.user.email, password: 'original-password-1' }),
      (error: unknown) => error instanceof AccountHttpError && error.statusCode === 401,
    );
    clearLoginThrottleOnDisk(root); // the failure above just started a real backoff window — clear it to test the *credential* is what's checked next, not the throttle.
    const relogged = await store.login({ email: owner.user.email, password: 'brand-new-password-2' });
    assert.ok(await store.authenticate(relogged.token));

    // Single-use: redeeming the same token again fails.
    await assert.rejects(
      () => store.redeemPasswordResetToken({ token: minted.token, newPassword: 'another-password-3' }),
      (error: unknown) => error instanceof AccountHttpError && error.statusCode === 400,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('password reset token: unknown/garbage token and expired token are both rejected', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-accounts-reset-bad-'));
  const store = new AccountStore(root);

  try {
    await assert.rejects(
      () => store.redeemPasswordResetToken({ token: 'krt_not-a-real-token', newPassword: 'whatever-password-1' }),
      (error: unknown) => error instanceof AccountHttpError && error.statusCode === 400,
    );
    await assert.rejects(
      () => store.mintPasswordResetToken({ email: 'nobody-here@example.com', mintedBy: 'operator:test' }),
      (error: unknown) => error instanceof AccountHttpError && error.statusCode === 404,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('password reset: minting again invalidates the previous unused token (single live token per account)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-accounts-reset-remint-'));
  const store = new AccountStore(root);

  try {
    const owner = await store.register({ email: 'remint@example.com', password: 'original-password-1', workspaceName: 'Remint' });
    const first = await store.mintPasswordResetToken({ email: owner.user.email, mintedBy: 'operator:test' });
    const second = await store.mintPasswordResetToken({ email: owner.user.email, mintedBy: 'operator:test' });

    await assert.rejects(
      () => store.redeemPasswordResetToken({ token: first.token, newPassword: 'via-stale-token-2' }),
      (error: unknown) => error instanceof AccountHttpError && error.statusCode === 400,
    );
    const redeemed = await store.redeemPasswordResetToken({ token: second.token, newPassword: 'via-fresh-token-2' });
    assert.equal(redeemed.userId, owner.user.id);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// §AUTH-LIFECYCLE — signed-in password change: requires the current
// password, rotates the token, and kills every OTHER session.
test('password change requires current password and revokes other sessions', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-accounts-changepw-'));
  const store = new AccountStore(root);

  try {
    const owner = await store.register({ email: 'changer@example.com', password: 'first-password-1', workspaceName: 'Changer' });
    const otherDevice = await store.login({ email: owner.user.email, password: 'first-password-1' });

    await assert.rejects(
      () => store.changePassword(owner.user.id, owner.token, { currentPassword: 'wrong-current', newPassword: 'second-password-2' }),
      (error: unknown) => error instanceof AccountHttpError && error.statusCode === 401,
    );

    const changed = await store.changePassword(owner.user.id, owner.token, { currentPassword: 'first-password-1', newPassword: 'second-password-2' });
    assert.notEqual(changed.token, owner.token);
    assert.ok(await store.authenticate(changed.token));

    // The pre-change token and the other device's session are both dead.
    assert.equal(await store.authenticate(owner.token), null);
    assert.equal(await store.authenticate(otherDevice.token), null);

    // New password works, old one does not.
    await assert.rejects(() => store.login({ email: owner.user.email, password: 'first-password-1' }));
    clearLoginThrottleOnDisk(root);
    const relogged = await store.login({ email: owner.user.email, password: 'second-password-2' });
    assert.ok(await store.authenticate(relogged.token));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// §AUTH-LIFECYCLE — login throttling: repeated failures back off
// exponentially and reject with 429 while the backoff window is open, but a
// successful login always eventually works once creds are correct — no hard
// lockout state exists that only an operator could clear.
test('login throttling backs off after repeated failures without permanently locking the account', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-accounts-throttle-'));
  const store = new AccountStore(root);

  try {
    const owner = await store.register({ email: 'throttled@example.com', password: 'correct-password-1', workspaceName: 'Throttled' });

    await assert.rejects(
      () => store.login({ email: owner.user.email, password: 'wrong-1' }),
      (error: unknown) => error instanceof AccountHttpError && error.statusCode === 401,
    );
    // Immediately retrying (within the backoff window) is throttled, not
    // silently re-checked against the password — this is the account-level
    // rate limit, distinct from the per-IP limit enforced at the HTTP layer.
    await assert.rejects(
      () => store.login({ email: owner.user.email, password: 'correct-password-1' }),
      (error: unknown) => error instanceof AccountHttpError && error.statusCode === 429,
    );

    // A correct login eventually succeeds once the backoff window is
    // (synthetically) expired — proving there is no permanent lockout state.
    const dbPath = path.join(root, 'accounts', 'accounts.json');
    const raw = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    raw.login_throttles = raw.login_throttles.map((t: { next_attempt_at: string }) => ({ ...t, next_attempt_at: new Date(0).toISOString() }));
    fs.writeFileSync(dbPath, JSON.stringify(raw, null, 2));

    const result = await store.login({ email: owner.user.email, password: 'correct-password-1' });
    assert.ok(await store.authenticate(result.token));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// §AUTH-LIFECYCLE — sliding-window session refresh: a session used well
// past its original expires_at (but before the absolute ceiling) must have
// been extended by activity, never simply left to expire on a fixed clock.
test('authenticate slides a session forward on activity, bounded by the absolute ceiling', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-accounts-slide-'));
  const store = new AccountStore(root);

  try {
    const owner = await store.register({ email: 'slider@example.com', password: 'password-1234', workspaceName: 'Slider' });

    const dbPath = path.join(root, 'accounts', 'accounts.json');
    const raw = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    // Backdate created_at/expires_at as if this session were minted long ago
    // but is still (barely) unexpired — simulating an active, long-lived
    // session approaching its idle-window cliff.
    const longAgo = new Date(Date.now() - 1000 * 60 * 60 * 24 * 13).toISOString();
    const soon = new Date(Date.now() + 1000 * 60 * 5).toISOString();
    raw.sessions[0].created_at = longAgo;
    raw.sessions[0].expires_at = soon;
    raw.sessions[0].absolute_expires_at = new Date(Date.now() + 1000 * 60 * 60 * 24 * 60).toISOString();
    fs.writeFileSync(dbPath, JSON.stringify(raw, null, 2));

    const authed = await store.authenticate(owner.token);
    assert.ok(authed);
    // Give the fire-and-forget extension a tick to land.
    await new Promise(resolve => setTimeout(resolve, 50));

    const after = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    const newExpiry = Date.parse(after.sessions[0].expires_at);
    assert.ok(newExpiry > Date.parse(soon), 'session was not extended by activity');
    // The new expiry should be roughly now + the 14-day idle window (well
    // past the artificial 5-minute "soon" cliff), and still safely under the
    // 60-day absolute cap set above — i.e. a real sliding extension, not a
    // clamp straight to the absolute ceiling.
    assert.ok(newExpiry > Date.parse(soon) + 1000 * 60 * 60 * 24 * 13, 'extension did not move the idle window forward by roughly a full TTL');
    assert.ok(newExpiry < Date.parse(raw.sessions[0].absolute_expires_at), 'extension must never exceed the absolute ceiling');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a revoked session is never resurrected by a concurrent sliding-window extension', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-accounts-slide-revoke-'));
  const store = new AccountStore(root);

  try {
    const owner = await store.register({ email: 'revoke-race@example.com', password: 'password-1234', workspaceName: 'RevokeRace' });

    const dbPath = path.join(root, 'accounts', 'accounts.json');
    const raw = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    raw.sessions[0].created_at = new Date(Date.now() - 1000 * 60 * 60 * 24 * 13).toISOString();
    raw.sessions[0].expires_at = new Date(Date.now() + 1000 * 60 * 5).toISOString();
    fs.writeFileSync(dbPath, JSON.stringify(raw, null, 2));

    // authenticate() reads the still-valid session and (async, unawaited by
    // the caller) schedules an extension; revoke it before that extension's
    // own mutate() runs.
    const authed = await store.authenticate(owner.token);
    assert.ok(authed);
    await store.revokeAllSessions(owner.user.id, 'test-revoke');
    await new Promise(resolve => setTimeout(resolve, 50));

    assert.equal(await store.authenticate(owner.token), null, 'a revoked session must never come back via a racing extension');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// §AUTH-LIFECYCLE — backward compatibility: an accounts.json written before
// this feature (no password_reset_tokens/login_throttles arrays, sessions
// with no absolute_expires_at) must keep working with zero migration step.
test('legacy accounts.json shape (no reset tokens, no throttles, no absolute_expires_at) still authenticates', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-accounts-legacy-'));
  const accountsDir = path.join(root, 'accounts');
  fs.mkdirSync(accountsDir, { recursive: true });

  const legacyToken = 'ks_legacy-token-for-test-only';
  const tokenHash = crypto.createHash('sha256').update(legacyToken).digest('hex');
  const legacyDb = {
    version: 1,
    users: [{ id: 'usr_legacy1', email: 'legacy@example.com', name: 'Legacy User', password_hash: 'scrypt$abc$def', created_at: new Date().toISOString() }],
    workspaces: [{ id: 'wsp_legacy1', name: 'Legacy Workspace', created_by_user_id: 'usr_legacy1', created_at: new Date().toISOString() }],
    workspace_users: [{ workspace_id: 'wsp_legacy1', user_id: 'usr_legacy1', role: 'owner', created_at: new Date().toISOString() }],
    projects: [],
    sessions: [{ token_hash: tokenHash, user_id: 'usr_legacy1', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 1000 * 60 * 60).toISOString() }],
    // No password_reset_tokens, no login_throttles — exactly the pre-feature shape.
  };
  fs.writeFileSync(path.join(accountsDir, 'accounts.json'), JSON.stringify(legacyDb, null, 2));

  const store = new AccountStore(root);
  try {
    const authed = await store.authenticate(legacyToken);
    assert.ok(authed, 'a legacy session with no absolute_expires_at must still authenticate');
    assert.equal(authed?.id, 'usr_legacy1');

    const workspaces = await store.listWorkspaces('usr_legacy1');
    assert.equal(workspaces.length, 1);

    // A legacy account can mint/redeem a reset token with no migration step.
    const minted = await store.mintPasswordResetToken({ email: 'legacy@example.com', mintedBy: 'operator:test' });
    const redeemed = await store.redeemPasswordResetToken({ token: minted.token, newPassword: 'new-legacy-password-1' });
    assert.equal(redeemed.userId, 'usr_legacy1');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
