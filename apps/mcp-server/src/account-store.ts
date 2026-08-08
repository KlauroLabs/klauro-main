import * as crypto from 'node:crypto';
import * as fs from 'fs-extra';
import * as path from 'node:path';
import { detectRemoteProvider } from './remote-provider';
import type { RepoFacts } from './remote-source';

export type WorkspaceRole = 'owner' | 'admin' | 'member';

export interface AccountUser {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  created_at: string;
}

export interface AccountWorkspace {
  id: string;
  name: string;
  created_by_user_id: string;
  created_at: string;
}

export interface AccountWorkspaceUser {
  workspace_id: string;
  user_id: string;
  role: WorkspaceRole;
  created_at: string;
}

export interface AccountProject {
  id: string;
  workspace_id: string;
  name: string;
  repo_url?: string;
  local_path?: string;
  analysis_id?: string;
  created_at: string;
  /** Additive, last-move-only (mirrors the ReanalyzeAttemptRecord "last
   *  attempt, not full history" pattern): set by attachProjectToWorkspace
   *  whenever a project MOVES into a different workspace (never on the
   *  initial createProject, which already has created_at for that). Absent
   *  on a project that has never moved — old records simply have no event,
   *  never a fabricated one. Feeds the Change Activity 'project_moved' event
   *  (GET /api/account/activity, /api/workspaces/:id/activity). */
  moved_at?: string;
  moved_from_workspace_id?: string;
  /**
   * Last-known client-derived repo facts (contributor_count/first_commit_at/
   * last_commit_at — see remote-source.ts deriveRepoFacts), persisted from
   * whichever push actually carried a manifest.repo_facts (an `/v1/analyze`
   * or `/v1/sync` from a client with real `.git` access). A server-side
   * re-run against the STORED snapshot (`/api/projects/:id/reanalyze`,
   * `/api/workspaces/:id/reanalyze`) has no client working tree to derive
   * git facts from, so it falls back to re-stamping the CAS from THIS
   * last-known value rather than silently dropping the keys. Absent when no
   * push has ever carried repo_facts (never a fabricated zero).
   */
  repo_facts?: RepoFacts;
}

export interface AccountSession {
  token_hash: string;
  user_id: string;
  created_at: string;
  expires_at: string;
  /**
   * Absolute (non-sliding) ceiling for this session, computed once at
   * creation as created_at + ABSOLUTE_SESSION_MAX_MS. `authenticate()`
   * slides `expires_at` forward on activity (§AUTH-LIFECYCLE sliding
   * window) but NEVER past this value — an idle-window extension alone
   * would let a session that is used at least once every 14 days live
   * forever, which is exactly the unbounded-lifetime shape enterprise
   * review flags. Optional for backward compatibility: sessions written
   * before this field existed simply have it back-filled (from their
   * `created_at`) the first time `authenticate()` touches them.
   */
  absolute_expires_at?: string;
}

/**
 * §AUTH-LIFECYCLE — single-use, hashed password reset token (same
 * hash-at-rest pattern as AccountSession.token_hash / hashToken). Minted
 * ONLY by an operator (see AccountStore.mintPasswordResetToken — there is
 * no self-service email-based reset because this product has no mail
 * infrastructure), redeemed once via AccountStore.redeemPasswordResetToken.
 * `used_at` marks single-use; a token is also implicitly dead once
 * `expires_at` passes. Never stores the raw token.
 */
export interface AccountPasswordResetToken {
  token_hash: string;
  user_id: string;
  created_at: string;
  expires_at: string;
  used_at?: string;
  /** Free-text provenance for the audit trail ("operator:ms2474@gmail.com", a script name, etc). Never a secret. */
  minted_by: string;
}

/**
 * §AUTH-LIFECYCLE — per-email exponential-backoff state for failed logins.
 * Keyed by normalized email (not user id) so a throttle can exist even for
 * an email with no account, closing the timing side-channel that would
 * otherwise let an attacker distinguish "wrong password" from "no such
 * user" by response latency alone. Never a hard lockout: `next_attempt_at`
 * always eventually passes on its own, so a legitimate caller (including an
 * automated agent retrying on a timer) is never permanently blocked — see
 * loginBackoffMs's doc comment for the schedule and cap.
 */
interface AccountLoginThrottle {
  email: string;
  failed_count: number;
  next_attempt_at: string;
  updated_at: string;
}

interface AccountDatabase {
  version: 1;
  users: AccountUser[];
  workspaces: AccountWorkspace[];
  workspace_users: AccountWorkspaceUser[];
  projects: AccountProject[];
  sessions: AccountSession[];
  /** Additive (see load()'s Array.isArray guard) — absent on every accounts.json written before §AUTH-LIFECYCLE. */
  password_reset_tokens: AccountPasswordResetToken[];
  /** Additive, same back-compat shape as password_reset_tokens. */
  login_throttles: AccountLoginThrottle[];
}

export interface PublicAccountUser {
  id: string;
  email: string;
  name: string;
  created_at: string;
}

export interface AccountSessionResult {
  token: string;
  user: PublicAccountUser;
}

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;

/**
 * §AUTH-LIFECYCLE — absolute ceiling on a session's lifetime, independent of
 * how often it is used. Chosen at 90 days (≈6.4x the 14-day idle window):
 * long enough that a healthy, regularly-used agent or CI credential never
 * hits it in normal operation (the idle window is what protects those —
 * this is a *second*, coarser backstop), short enough to bound how long a
 * leaked-but-still-active token stays useful without a forced re-login.
 * This is a recommendation, not a re-derivation of the 14-day base TTL —
 * the base TTL is unchanged per the task's instruction not to alter it
 * unilaterally.
 */
const ABSOLUTE_SESSION_MAX_MS = 1000 * 60 * 60 * 24 * 90;

/**
 * Minimum forward movement (in ms) before a sliding-window extension is
 * actually written to disk. `authenticate()` is the hottest read path in
 * this store (every MCP tool call, every CLI command); extending
 * `expires_at` on literally every call would turn every authenticated
 * request into a disk write. An hour of slack means an actively-used
 * session is durably extended at most once per hour of wall-clock use,
 * while a session idle for the full 14-day window still expires on time.
 */
const SESSION_SLIDING_WRITE_THRESHOLD_MS = 1000 * 60 * 60;

/**
 * §AUTH-LIFECYCLE — single-use password reset token TTL. 30 minutes:
 * long enough for an operator to relay a token to the account owner
 * out-of-band (there is no email delivery — see mintPasswordResetToken)
 * and for them to redeem it in one sitting; short enough that a leaked or
 * intercepted relay channel (chat, screen share) is only a live exposure
 * for half an hour, and that an operator who mints a token and doesn't
 * hand if off immediately is forced to re-mint rather than leaving a
 * long-lived bearer-equivalent secret lying around.
 */
const RESET_TOKEN_TTL_MS = 1000 * 60 * 30;

/**
 * §AUTH-LIFECYCLE — exponential backoff schedule for failed logins, per
 * normalized email. Base 1s, doubling per consecutive failure, capped at
 * 15 minutes. Deliberately NOT a hard lockout (task constraint: this
 * product's callers include agents that retry automatically on a timer —
 * a hard lockout that only an operator can clear is a self-inflicted
 * denial-of-service the moment such an agent's retry loop crosses the
 * threshold). The schedule is soft enough that a human re-typing a
 * mistyped password barely notices (1s, 2s, 4s...) but expensive enough
 * that sustained credential stuffing against one account tops out at 4
 * attempts/hour once the 15-minute cap is reached — and the cap always
 * expires on its own, so nothing here can be permanent.
 */
function loginBackoffMs(failedCount: number): number {
  const BASE_MS = 1000;
  const CAP_MS = 1000 * 60 * 15;
  return Math.min(CAP_MS, BASE_MS * Math.pow(2, Math.max(0, failedCount - 1)));
}

/** A throttle whose last failure is old enough is treated as stale and reset, rather than accumulating forever in a store with no TTL/eviction of its own. */
const LOGIN_THROTTLE_DECAY_MS = 1000 * 60 * 60;

export class AccountStore {
  private readonly filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'accounts', 'accounts.json');
  }

  async register(input: { email: string; name?: string; password: string; workspaceName?: string }): Promise<AccountSessionResult> {
    const email = normalizeEmail(input.email);
    const name = cleanName(input.name || email.split('@')[0]);
    assertPassword(input.password);
    // Hash BEFORE entering the mutate() critical section: bcrypt is
    // deliberately slow, and holding the store's write queue for it would
    // serialize every concurrent account mutation (register/login/analyze
    // pushes) behind however long hashing takes.
    const passwordHash = await hashPassword(input.password);
    return this.mutate(db => {
      // Uniqueness check now runs against the freshest snapshot INSIDE the
      // atomic section — closes a pre-existing TOCTOU where two concurrent
      // registrations for the same email could both pass this check before
      // either had saved.
      if (db.users.some(user => user.email === email)) {
        throw httpError(409, 'A user with that email already exists');
      }

      const now = new Date().toISOString();
      const user: AccountUser = {
        id: id('usr'),
        email,
        name,
        password_hash: passwordHash,
        created_at: now,
      };
      db.users.push(user);

      const workspaceName = cleanName(input.workspaceName || `${name}'s Workspace`);
      const workspace: AccountWorkspace = {
        id: id('wsp'),
        name: workspaceName,
        created_by_user_id: user.id,
        created_at: now,
      };
      db.workspaces.push(workspace);
      db.workspace_users.push({
        workspace_id: workspace.id,
        user_id: user.id,
        role: 'owner',
        created_at: now,
      });

      const session = createSession(user.id);
      db.sessions.push(session.record);
      return { token: session.token, user: publicUser(user) };
    });
  }

  async login(input: { email: string; password: string; source?: string }): Promise<AccountSessionResult> {
    const email = normalizeEmail(input.email);
    // Throttle check is a read against the current snapshot — same
    // outside-the-write-queue rationale as the password verify below (we
    // don't want to hold the store's serialized write section for however
    // long a rejected/slow attempt takes).
    const preDb = await this.load();
    const throttle = preDb.login_throttles.find(candidate => candidate.email === email);
    if (throttle && !throttleIsStale(throttle) && Date.parse(throttle.next_attempt_at) > Date.now()) {
      const retryAfterMs = Date.parse(throttle.next_attempt_at) - Date.now();
      await this.appendAudit({ event: 'auth_login_throttled', email, retry_after_ms: retryAfterMs, source: input.source });
      throw httpError(429, `Too many failed login attempts for this account. Retry in ${Math.max(1, Math.ceil(retryAfterMs / 1000))}s.`);
    }
    // Password verify is a read against the current snapshot, outside the
    // write queue for the same reason as register() (bcrypt is slow).
    const user = preDb.users.find(candidate => candidate.email === email);
    const passwordOk = user ? await verifyPassword(input.password, user.password_hash) : false;
    if (!user || !passwordOk) {
      await this.mutate(freshDb => {
        recordLoginFailure(freshDb, email);
      });
      await this.appendAudit({ event: 'auth_login_failed', email, source: input.source });
      throw httpError(401, 'Invalid email or password');
    }
    const result = await this.mutate(freshDb => {
      clearLoginThrottle(freshDb, email);
      const session = createSession(user.id);
      freshDb.sessions = pruneSessions(freshDb.sessions);
      freshDb.sessions.push(session.record);
      return { token: session.token, user: publicUser(user) };
    });
    await this.appendAudit({ event: 'auth_login_success', user_id: user.id, email, source: input.source });
    return result;
  }

  async authenticate(token: string | undefined): Promise<PublicAccountUser | null> {
    if (!token) return null;
    const db = await this.load();
    const tokenHash = hashToken(token);
    const session = db.sessions.find(candidate => candidate.token_hash === tokenHash);
    if (!session || new Date(session.expires_at).getTime() <= Date.now()) return null;
    const user = db.users.find(candidate => candidate.id === session.user_id);
    if (!user) return null;
    // Sliding-window extension (§AUTH-LIFECYCLE, see SESSION_SLIDING_WRITE_THRESHOLD_MS
    // for why this is throttled rather than unconditional). Never allowed to
    // fail authentication itself — a disk hiccup here must not turn into a
    // spurious 401 for an otherwise-valid session.
    this.maybeExtendSession(session, tokenHash).catch(() => undefined);
    return publicUser(user);
  }

  /**
   * Extend a still-valid session's idle window on activity, capped at
   * `absolute_expires_at` (back-filled from `created_at` for sessions
   * written before that field existed). Only actually writes to disk when
   * the extension is material (see SESSION_SLIDING_WRITE_THRESHOLD_MS).
   * Re-checks the session still exists inside the mutate: if it was
   * revoked (password reset/change, explicit revoke) between the read
   * above and this write, `db.sessions.find` returns undefined and this is
   * a no-op — a revoked session must never be silently resurrected by a
   * request that raced the revocation.
   */
  private async maybeExtendSession(session: AccountSession, tokenHash: string): Promise<void> {
    const now = Date.now();
    const absoluteExpiresAt = session.absolute_expires_at
      ? Date.parse(session.absolute_expires_at)
      : Date.parse(session.created_at) + ABSOLUTE_SESSION_MAX_MS;
    const proposedExpiry = Math.min(now + SESSION_TTL_MS, absoluteExpiresAt);
    const currentExpiry = Date.parse(session.expires_at);
    if (proposedExpiry - currentExpiry < SESSION_SLIDING_WRITE_THRESHOLD_MS) return;
    await this.mutate(db => {
      const record = db.sessions.find(candidate => candidate.token_hash === tokenHash);
      if (!record) return; // revoked concurrently — never resurrect.
      const absolute = record.absolute_expires_at || new Date(Date.parse(record.created_at) + ABSOLUTE_SESSION_MAX_MS).toISOString();
      record.absolute_expires_at = absolute;
      const newExpiry = Math.min(Date.now() + SESSION_TTL_MS, Date.parse(absolute));
      if (newExpiry > Date.parse(record.expires_at)) {
        record.expires_at = new Date(newExpiry).toISOString();
      }
    });
  }

  /**
   * Change the signed-in user's password. Requires the CURRENT password
   * (defense against a hijacked-but-not-yet-expired session being used to
   * lock the real owner out permanently). Invalidates every OTHER session
   * for this user and rotates the calling session's own token too (token
   * rotation on credential change is standard practice — never leave the
   * pre-change token usable) so the caller must persist the newly-returned
   * token. Same hashing path as register/login (hashPassword/scrypt).
   */
  async changePassword(userId: string, currentToken: string | undefined, input: { currentPassword: string; newPassword: string }): Promise<AccountSessionResult> {
    const db = await this.load();
    const user = db.users.find(candidate => candidate.id === userId);
    if (!user) throw httpError(404, 'Account not found');
    if (!(await verifyPassword(input.currentPassword, user.password_hash))) {
      throw httpError(401, 'Current password is incorrect');
    }
    assertPassword(input.newPassword);
    const newHash = await hashPassword(input.newPassword);
    const result = await this.mutate(freshDb => {
      const freshUser = freshDb.users.find(candidate => candidate.id === userId);
      if (!freshUser) throw httpError(404, 'Account not found');
      freshUser.password_hash = newHash;
      // Kill every session for this user — including, momentarily, the
      // caller's own — then mint one fresh replacement so the caller isn't
      // logged out by their own password change.
      freshDb.sessions = freshDb.sessions.filter(candidate => candidate.user_id !== userId);
      const session = createSession(userId);
      freshDb.sessions.push(session.record);
      return { token: session.token, user: publicUser(freshUser) };
    });
    await this.appendAudit({ event: 'auth_password_changed', user_id: userId, revoked_prior_session: Boolean(currentToken) });
    return result;
  }

  /**
   * §AUTH-LIFECYCLE — operator-only. Mints a single-use, hashed, expiring
   * password reset token for the given email. There is no self-service
   * email-based reset (no mail infrastructure exists — see the module doc
   * on AccountPasswordResetToken); this is called from server-side/CLI
   * context by an operator who has already verified out-of-band that the
   * request is legitimate. `mintedBy` is a free-text provenance string for
   * the audit trail (e.g. an operator's own email, or a script name) — it
   * is never treated as an authorization check by this method itself; the
   * caller (CLI command / internal script) IS the authorization boundary.
   * Minting invalidates any still-unused, unexpired token already minted
   * for this user, so at most one reset token is ever live per account.
   */
  async mintPasswordResetToken(input: { email: string; mintedBy: string }): Promise<{ token: string; userId: string; expiresAt: string }> {
    const email = normalizeEmail(input.email);
    return this.mutate(db => {
      const user = db.users.find(candidate => candidate.email === email);
      if (!user) throw httpError(404, 'No account exists with that email');
      const now = new Date();
      const expiresAt = new Date(now.getTime() + RESET_TOKEN_TTL_MS);
      // Invalidate prior live tokens for this user (single active token invariant).
      db.password_reset_tokens = db.password_reset_tokens.filter(candidate => candidate.user_id !== user.id);
      const token = `krt_${crypto.randomBytes(32).toString('base64url')}`;
      db.password_reset_tokens.push({
        token_hash: hashToken(token),
        user_id: user.id,
        created_at: now.toISOString(),
        expires_at: expiresAt.toISOString(),
        minted_by: input.mintedBy,
      });
      return { token, userId: user.id, expiresAt: expiresAt.toISOString() };
    }).then(async result => {
      await this.appendAudit({ event: 'auth_reset_token_minted', user_id: result.userId, minted_by: input.mintedBy, expires_at: result.expiresAt });
      return result;
    });
  }

  /**
   * Redeem a password reset token: verify hash + not expired + not already
   * used, set the new password, mark the token used (single-use), and
   * INVALIDATE EVERY SESSION for the user (a reset that leaves old
   * sessions alive defeats the point of a reset — see task requirement).
   * Never reveals WHY a token was rejected beyond "invalid or expired" —
   * distinguishing "wrong token" from "expired" from "already used" to the
   * caller would leak state about accounts to anyone who obtains a stale
   * token.
   */
  async redeemPasswordResetToken(input: { token: string; newPassword: string }): Promise<{ userId: string; email: string }> {
    assertPassword(input.newPassword);
    const newHash = await hashPassword(input.newPassword);
    const tokenHash = hashToken(input.token);
    const result = await this.mutate(db => {
      const record = db.password_reset_tokens.find(candidate => candidate.token_hash === tokenHash);
      const now = Date.now();
      if (!record || record.used_at || Date.parse(record.expires_at) <= now) {
        throw httpError(400, 'Reset token is invalid or expired');
      }
      const user = db.users.find(candidate => candidate.id === record.user_id);
      if (!user) throw httpError(400, 'Reset token is invalid or expired');
      record.used_at = new Date().toISOString();
      user.password_hash = newHash;
      const revokedSessions = db.sessions.filter(candidate => candidate.user_id === user.id).length;
      db.sessions = db.sessions.filter(candidate => candidate.user_id !== user.id);
      // Failed-login throttle no longer applies once the password has changed underneath it.
      clearLoginThrottle(db, user.email);
      return { userId: user.id, email: user.email, revokedSessions };
    });
    await this.appendAudit({ event: 'auth_reset_token_redeemed', user_id: result.userId, revoked_sessions: result.revokedSessions });
    return { userId: result.userId, email: result.email };
  }

  /** Revoke every session for a user (used internally by password change/reset; exposed for future admin tooling). */
  async revokeAllSessions(userId: string, reason: string): Promise<number> {
    const count = await this.mutate(db => {
      const before = db.sessions.length;
      db.sessions = db.sessions.filter(candidate => candidate.user_id !== userId);
      return before - db.sessions.length;
    });
    if (count > 0) await this.appendAudit({ event: 'auth_session_revoked', user_id: userId, count, reason });
    return count;
  }

  async requireUser(token: string | undefined): Promise<PublicAccountUser> {
    const user = await this.authenticate(token);
    if (!user) throw httpError(401, 'Sign in required');
    return user;
  }

  async listWorkspaces(userId: string): Promise<Array<AccountWorkspace & { role: WorkspaceRole; project_count: number; user_count: number }>> {
    const db = await this.load();
    const memberships = db.workspace_users.filter(member => member.user_id === userId);
    return memberships
      .map(member => {
        const workspace = db.workspaces.find(candidate => candidate.id === member.workspace_id);
        if (!workspace) return null;
        return {
          ...workspace,
          role: member.role,
          project_count: db.projects.filter(project => project.workspace_id === workspace.id).length,
          user_count: db.workspace_users.filter(candidate => candidate.workspace_id === workspace.id).length,
        };
      })
      .filter((workspace): workspace is AccountWorkspace & { role: WorkspaceRole; project_count: number; user_count: number } => !!workspace)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async createWorkspace(userId: string, input: { name: string }): Promise<AccountWorkspace & { role: WorkspaceRole }> {
    const name = cleanName(input.name);
    const now = new Date().toISOString();
    return this.mutate(db => {
      const workspace: AccountWorkspace = {
        id: id('wsp'),
        name,
        created_by_user_id: userId,
        created_at: now,
      };
      db.workspaces.push(workspace);
      db.workspace_users.push({ workspace_id: workspace.id, user_id: userId, role: 'owner', created_at: now });
      return { ...workspace, role: 'owner' };
    });
  }

  async listWorkspaceUsers(userId: string, workspaceId: string): Promise<Array<PublicAccountUser & { role: WorkspaceRole }>> {
    const db = await this.load();
    requireMembership(db, userId, workspaceId);
    return db.workspace_users
      .filter(member => member.workspace_id === workspaceId)
      .map(member => {
        const user = db.users.find(candidate => candidate.id === member.user_id);
        return user ? { ...publicUser(user), role: member.role } : null;
      })
      .filter((user): user is PublicAccountUser & { role: WorkspaceRole } => !!user)
      .sort((left, right) => left.email.localeCompare(right.email));
  }

  async addWorkspaceUser(actorUserId: string, workspaceId: string, input: { email: string; role?: WorkspaceRole }): Promise<AccountWorkspaceUser> {
    const email = normalizeEmail(input.email);
    const role = normalizeRole(input.role || 'member');
    return this.mutate(db => {
      requireMembership(db, actorUserId, workspaceId, ['owner', 'admin']);
      const user = db.users.find(candidate => candidate.email === email);
      if (!user) throw httpError(404, 'No user exists with that email yet');
      const existing = db.workspace_users.find(member => member.workspace_id === workspaceId && member.user_id === user.id);
      if (existing) {
        existing.role = role;
        return existing;
      }
      const membership: AccountWorkspaceUser = {
        workspace_id: workspaceId,
        user_id: user.id,
        role,
        created_at: new Date().toISOString(),
      };
      db.workspace_users.push(membership);
      return membership;
    });
  }

  async listProjects(userId: string, workspaceId: string): Promise<AccountProject[]> {
    const db = await this.load();
    requireMembership(db, userId, workspaceId);
    return db.projects
      .filter(project => project.workspace_id === workspaceId)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  /**
   * Internal accessor for server-side background jobs (e.g. the auto-refreshed
   * workspace-analysis scheduler) that need a workspace's project membership
   * WITHOUT a specific acting user — there is no human request in flight when
   * a debounced rebuild fires. Deliberately bypasses requireMembership: the
   * caller is trusted server code, not a request handler exposing this to a
   * client. Never wire this to an HTTP route directly.
   */
  async listProjectsForWorkspace(workspaceId: string): Promise<AccountProject[]> {
    const db = await this.load();
    return db.projects
      .filter(project => project.workspace_id === workspaceId)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  /** Internal accessor mirroring listProjectsForWorkspace, for the same background-job use case. */
  async getWorkspaceById(workspaceId: string): Promise<AccountWorkspace | null> {
    const db = await this.load();
    return db.workspaces.find(candidate => candidate.id === workspaceId) || null;
  }

  /**
   * Internal accessor for the auto-refresh trigger: `/v1/analyze` and
   * `/api/projects/:id/reanalyze` only know an `analysis_id` (a deterministic
   * hash of the repo path/name, NOT an AccountStore project id — see
   * remote-sync-client.ts `resolveAnalysisId`). To know which account
   * workspace(s) to mark dirty when an analysis lands, look up every project
   * record that has been linked to this analysis_id (via `createProject` with
   * `analysis_id` set, the `klauro init` reconnect flow). Zero matches is the
   * common case for ad-hoc/unlinked analyze calls — that's fine, there is
   * simply no workspace to refresh.
   */
  async findProjectsByAnalysisId(analysisId: string): Promise<AccountProject[]> {
    if (!analysisId) return [];
    const db = await this.load();
    return db.projects.filter(project => project.analysis_id === analysisId);
  }

  async createProject(userId: string, workspaceId: string, input: { name: string; repo_url?: string; local_path?: string; analysis_id?: string }): Promise<AccountProject> {
    return this.mutate(db => {
      requireMembership(db, userId, workspaceId, ['owner', 'admin', 'member']);
      const project: AccountProject = {
        id: id('prj'),
        workspace_id: workspaceId,
        name: cleanName(input.name),
        repo_url: optionalText(input.repo_url),
        local_path: optionalText(input.local_path),
        analysis_id: optionalText(input.analysis_id),
        created_at: new Date().toISOString(),
      };
      db.projects.push(project);
      return project;
    });
  }

  async getProjectForUser(userId: string, projectId: string): Promise<AccountProject | null> {
    const db = await this.load();
    const project = db.projects.find(candidate => candidate.id === projectId);
    if (!project) return null;
    requireMembership(db, userId, project.workspace_id);
    return project;
  }

  /**
   * Recognition lookup for `klauro init`: has this Git remote already been
   * connected to a project by this user? Searches across every workspace the
   * user belongs to and returns the match with its workspace name so the CLI
   * can offer a one-keystroke reconnect. Matching is normalized (scheme, `.git`
   * suffix, and case are ignored) so `git@github.com:Org/Repo.git` and
   * `https://github.com/org/repo` resolve to the same project.
   */
  async findProjectByRepoUrl(userId: string, repoUrl: string): Promise<{ project: AccountProject; workspace: AccountWorkspace; role: WorkspaceRole } | null> {
    const normalized = normalizeRepoUrlForMatch(repoUrl);
    if (!normalized) return null;
    const db = await this.load();
    const memberWorkspaceIds = new Set(
      db.workspace_users.filter(member => member.user_id === userId).map(member => member.workspace_id),
    );
    const roleFor = (workspaceId: string): WorkspaceRole | undefined =>
      db.workspace_users.find(member => member.user_id === userId && member.workspace_id === workspaceId)?.role;
    const match = db.projects.find(project =>
      memberWorkspaceIds.has(project.workspace_id) && normalizeRepoUrlForMatch(project.repo_url) === normalized,
    );
    if (!match) return null;
    const workspace = db.workspaces.find(candidate => candidate.id === match.workspace_id);
    const role = roleFor(match.workspace_id);
    if (!workspace || !role) return null;
    return { project: match, workspace, role };
  }

  /**
   * ALL projects (across every workspace the user belongs to) whose repo_url
   * normalizes to the same value as `repoUrl`. Unlike `findProjectByRepoUrl`
   * (which returns the first match for the `klauro init` reconnect prompt),
   * this exists so callers that must never guess ambiguously — e.g. the
   * `/v1/analyze` auto-attach fallback in remote-analyzer-service.ts — can
   * tell "exactly one match" apart from "zero or more than one," and only
   * attach on the unambiguous case.
   */
  async findProjectsByRepoUrlForUser(userId: string, repoUrl: string | undefined): Promise<AccountProject[]> {
    const normalized = normalizeRepoUrlForMatch(repoUrl);
    if (!normalized) return [];
    const db = await this.load();
    const memberWorkspaceIds = new Set(
      db.workspace_users.filter(member => member.user_id === userId).map(member => member.workspace_id),
    );
    return db.projects.filter(project =>
      memberWorkspaceIds.has(project.workspace_id) && normalizeRepoUrlForMatch(project.repo_url) === normalized,
    );
  }

  /**
   * Attach (move) an existing project into `targetWorkspaceId`. `workspace_id`
   * on AccountProject is a single required foreign key, not a join table —
   * this model supports exactly one workspace per project, so "attach" is
   * necessarily a MOVE out of whatever workspace the project previously
   * belonged to, never an additive membership. Callers must be a member of
   * BOTH the project's current workspace and the target workspace (the same
   * requireMembership-throws-404 gate used elsewhere, so a non-member gets
   * "not found" rather than a distinguishing 403 that would leak existence).
   * Idempotent: attaching a project that is already in the target workspace
   * is a no-op and reports `already_attached: true`.
   */
  async attachProjectToWorkspace(userId: string, targetWorkspaceId: string, projectId: string): Promise<{
    project: AccountProject;
    already_attached: boolean;
    moved_from_workspace_id?: string;
  }> {
    return this.mutate(db => {
      requireMembership(db, userId, targetWorkspaceId);
      const project = db.projects.find(candidate => candidate.id === projectId);
      if (!project) throw httpError(404, 'Project not found');
      requireMembership(db, userId, project.workspace_id);
      if (project.workspace_id === targetWorkspaceId) {
        return { project, already_attached: true };
      }
      const previousWorkspaceId = project.workspace_id;
      project.workspace_id = targetWorkspaceId;
      project.moved_at = new Date().toISOString();
      project.moved_from_workspace_id = previousWorkspaceId;
      return { project, already_attached: false, moved_from_workspace_id: previousWorkspaceId };
    });
  }

  /**
   * §COORD-AUTH-401 — the highest-frequency write in the store: called on
   * EVERY successful `/v1/analyze` / reanalyze push (see
   * `linkAnalysisToAccountProject` in remote-analyzer-service.ts). Before the
   * `mutate()` fix this was the most likely single call site to race a
   * concurrent `login`/`register` and silently drop that session — a 10-lane
   * fleet pushing analyses every few minutes hits this constantly.
   */
  async setProjectAnalysisId(userId: string, projectId: string, analysisId: string): Promise<AccountProject> {
    return this.mutate(db => {
      const project = db.projects.find(candidate => candidate.id === projectId);
      if (!project) throw httpError(404, 'Project not found');
      requireMembership(db, userId, project.workspace_id);
      project.analysis_id = analysisId;
      return project;
    });
  }

  /**
   * Persist the last client-derived repo_facts alongside the project record
   * (see AccountProject.repo_facts's doc comment) so a later server-side
   * reanalyze — which has no client `.git` to derive facts from — can
   * re-stamp the CAS instead of shipping it with the keys silently absent.
   * A no-op when `facts` is empty/undefined: never overwrites a real
   * last-known value with nothing just because one particular push omitted
   * it (e.g. a reanalyze-driven revision, or a client that lost git access
   * transiently). Same "no user in flight" background-job shape as
   * `listProjectsForWorkspace` — bypasses requireMembership by design; never
   * wire this to an HTTP route directly with untrusted caller input.
   */
  async setProjectRepoFacts(projectId: string, facts: RepoFacts | undefined): Promise<void> {
    if (!facts || (facts.contributor_count === undefined && !facts.first_commit_at && !facts.last_commit_at)) return;
    await this.mutate(db => {
      const project = db.projects.find(candidate => candidate.id === projectId);
      if (!project) return; // unlinked/foreign project id — nothing to stamp, never throw here.
      project.repo_facts = facts;
    });
  }

  private async load(): Promise<AccountDatabase> {
    if (!(await fs.pathExists(this.filePath))) {
      return { version: 1, users: [], workspaces: [], workspace_users: [], projects: [], sessions: [], password_reset_tokens: [], login_throttles: [] };
    }
    const db = await fs.readJson(this.filePath) as AccountDatabase;
    return {
      version: 1,
      users: Array.isArray(db.users) ? db.users : [],
      workspaces: Array.isArray(db.workspaces) ? db.workspaces : [],
      workspace_users: Array.isArray(db.workspace_users) ? db.workspace_users : [],
      projects: Array.isArray(db.projects) ? db.projects : [],
      sessions: pruneSessions(Array.isArray(db.sessions) ? db.sessions : []),
      // Both additive/back-compat: absent on every accounts.json written
      // before §AUTH-LIFECYCLE — default to empty rather than throwing.
      password_reset_tokens: pruneResetTokens(Array.isArray(db.password_reset_tokens) ? db.password_reset_tokens : []),
      login_throttles: Array.isArray(db.login_throttles) ? db.login_throttles : [],
    };
  }

  /** Shared with remote-analyzer-service.ts's appendAuditLog: same file, same shape, so every auth and analyzer event interleaves in one chronological trail. Never throws — a broken audit write must not break the auth flow it is trying to record. */
  private async appendAudit(event: Record<string, unknown>): Promise<void> {
    try {
      const dataDir = path.dirname(path.dirname(this.filePath));
      const auditDir = path.join(dataDir, 'audit');
      await fs.ensureDir(auditDir);
      await fs.appendFile(path.join(auditDir, 'events.jsonl'), `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`, 'utf8');
    } catch {
      // Audit logging is best-effort and must never take down auth itself.
    }
  }

  /**
   * §COORD-AUTH-401 fix — every mutating method used to do a bare
   * `load()` ... `save(db)` pair. `save()`'s `writeQueue` only serialized the
   * physical `fs.writeJson` CALLS, never the read-modify-write CRITICAL
   * SECTION around them: two concurrent mutations (e.g. one lane's
   * `/v1/analyze` push calling `setProjectAnalysisId` while another lane
   * `login`s) could both `load()` the same on-disk snapshot, mutate their own
   * in-memory copy, then `save()` one after another — the SECOND save wins
   * wholesale and silently drops whatever the FIRST save had just added
   * (classic lost-update). Under a multi-agent fleet doing frequent
   * account-mutating pushes, this eventually clobbers another agent's
   * just-added *session* record, so `authenticate()` returns null for a
   * still-valid, still-fresh Bearer token — surfacing as an unexplained 401
   * on whichever endpoint that agent happens to call next (in practice almost
   * always `/v1/coordination/*`, since it is polled continuously via
   * heartbeat/claim/active while `/api/*` calls are comparatively sparse —
   * NOT because the two surfaces use different auth: `authorizeAnalyzerRequest`
   * and `authorizeAccountApiRequest` both defer to this same `authenticate()`).
   *
   * `mutate()` closes the whole load -> fn -> save critical section onto the
   * SAME `writeQueue` used for the physical write, so no two mutations can
   * ever interleave: each sees the previous mutation's fully-saved state.
   * The queue bookkeeping promise itself is never allowed to reject (a
   * validation throw inside `fn`, e.g. `httpError(404, ...)`, is caught and
   * detached from the queue's own continuation) so one failed mutation never
   * poisons every subsequent call.
   */
  private async mutate<T>(fn: (db: AccountDatabase) => T | Promise<T>): Promise<T> {
    const task = this.writeQueue.then(async () => {
      const db = await this.load();
      const result = await fn(db);
      await this.writeToDisk(db);
      return result;
    });
    // Keep the queue itself always-resolving (success or failure) so a
    // rejected mutation doesn't short-circuit every mutation queued after it.
    this.writeQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  /** Atomic on-disk write (temp file + rename): a `save()` that races a
   *  process kill/restart (deploy, OOM, crash) must never leave a
   *  half-written `accounts.json` — a torn write there makes EVERY session
   *  unreadable (JSON.parse throws) until an operator manually restores from
   *  a backup, which is a strictly worse failure mode than one lost mutation.
   *  `fs.writeJson` directly to the target path has no such guarantee. */
  private async writeToDisk(db: AccountDatabase): Promise<void> {
    await fs.ensureDir(path.dirname(this.filePath));
    const tmpPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeJson(tmpPath, db, { spaces: 2 });
    await fs.rename(tmpPath, this.filePath);
  }
}

export class AccountHttpError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

export function httpError(statusCode: number, message: string): AccountHttpError {
  return new AccountHttpError(statusCode, message);
}

function requireMembership(db: AccountDatabase, userId: string, workspaceId: string, roles?: WorkspaceRole[]): AccountWorkspaceUser {
  const membership = db.workspace_users.find(member => member.workspace_id === workspaceId && member.user_id === userId);
  if (!membership) throw httpError(404, 'Workspace not found');
  if (roles && !roles.includes(membership.role)) throw httpError(403, 'Workspace role is not allowed for this action');
  return membership;
}

function createSession(userId: string): { token: string; record: AccountSession } {
  const token = `ks_${crypto.randomBytes(32).toString('base64url')}`;
  const createdAt = new Date();
  return {
    token,
    record: {
      token_hash: hashToken(token),
      user_id: userId,
      created_at: createdAt.toISOString(),
      expires_at: new Date(createdAt.getTime() + SESSION_TTL_MS).toISOString(),
      absolute_expires_at: new Date(createdAt.getTime() + ABSOLUTE_SESSION_MAX_MS).toISOString(),
    },
  };
}

function pruneSessions(sessions: AccountSession[]): AccountSession[] {
  const now = Date.now();
  return sessions.filter(session => new Date(session.expires_at).getTime() > now);
}

/** Expired reset tokens are dropped the same way expired sessions are — they are already dead, no reason to carry them forever in a JSON file with no eviction. Used ones are kept (their `used_at` is itself useful audit context) until they also age past expiry. */
function pruneResetTokens(tokens: AccountPasswordResetToken[]): AccountPasswordResetToken[] {
  const now = Date.now();
  return tokens.filter(token => Date.parse(token.expires_at) > now);
}

function throttleIsStale(throttle: { updated_at: string }): boolean {
  return Date.now() - Date.parse(throttle.updated_at) > LOGIN_THROTTLE_DECAY_MS;
}

/** Record one failed login attempt for `email`, computing the next allowed attempt time via loginBackoffMs. A stale throttle (see LOGIN_THROTTLE_DECAY_MS) restarts from count 1 rather than compounding an old, long-forgotten streak. */
function recordLoginFailure(db: AccountDatabase, email: string): void {
  const existing = db.login_throttles.find(candidate => candidate.email === email);
  const stale = existing ? throttleIsStale(existing) : true;
  const nextCount = stale ? 1 : existing!.failed_count + 1;
  const now = new Date();
  const nextAttemptAt = new Date(now.getTime() + loginBackoffMs(nextCount));
  if (existing) {
    existing.failed_count = nextCount;
    existing.next_attempt_at = nextAttemptAt.toISOString();
    existing.updated_at = now.toISOString();
  } else {
    db.login_throttles.push({ email, failed_count: nextCount, next_attempt_at: nextAttemptAt.toISOString(), updated_at: now.toISOString() });
  }
}

function clearLoginThrottle(db: AccountDatabase, email: string): void {
  db.login_throttles = db.login_throttles.filter(candidate => candidate.email !== email);
}

function publicUser(user: AccountUser): PublicAccountUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    created_at: user.created_at,
  };
}

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = await scrypt(password, salt);
  return `scrypt$${salt}$${hash}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, salt, expected] = stored.split('$');
  if (algorithm !== 'scrypt' || !salt || !expected) return false;
  const actual = await scrypt(password, salt);
  return timingSafeEqual(actual, expected);
}

function scrypt(password: string, salt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey.toString('base64url'));
    });
  });
}

function timingSafeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(12).toString('base64url')}`;
}

/** Normalize a Git remote for identity matching: scheme, `.git`, and case are ignored. */
function normalizeRepoUrlForMatch(value: string | undefined): string | undefined {
  const trimmed = String(value || '').trim();
  if (!trimmed) return undefined;
  const detected = detectRemoteProvider(trimmed);
  const canonical = detected?.repository_url || trimmed;
  return canonical.replace(/\.git$/i, '').toLowerCase();
}

function normalizeEmail(email: string): string {
  const normalized = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw httpError(400, 'A valid email is required');
  return normalized;
}

function cleanName(name: string): string {
  const cleaned = String(name || '').trim().replace(/\s+/g, ' ');
  if (!cleaned) throw httpError(400, 'Name is required');
  if (cleaned.length > 120) throw httpError(400, 'Name is too long');
  return cleaned;
}

function assertPassword(password: string): void {
  if (String(password || '').length < 8) throw httpError(400, 'Password must be at least 8 characters');
}

function normalizeRole(role: string): WorkspaceRole {
  if (role === 'owner' || role === 'admin' || role === 'member') return role;
  throw httpError(400, 'Role must be owner, admin, or member');
}

function optionalText(value: string | undefined): string | undefined {
  const cleaned = String(value || '').trim();
  return cleaned || undefined;
}
