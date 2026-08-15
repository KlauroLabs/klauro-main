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







  moved_at?: string;
  moved_from_workspace_id?: string;











  repo_facts?: RepoFacts;
}

export interface AccountSession {
  token_hash: string;
  user_id: string;
  created_at: string;
  expires_at: string;











  absolute_expires_at?: string;
}










export interface AccountPasswordResetToken {
  token_hash: string;
  user_id: string;
  created_at: string;
  expires_at: string;
  used_at?: string;

  minted_by: string;
}











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

  password_reset_tokens: AccountPasswordResetToken[];

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












const ABSOLUTE_SESSION_MAX_MS = 1000 * 60 * 60 * 24 * 90;










const SESSION_SLIDING_WRITE_THRESHOLD_MS = 1000 * 60 * 60;











const RESET_TOKEN_TTL_MS = 1000 * 60 * 30;














function loginBackoffMs(failedCount: number): number {
  const BASE_MS = 1000;
  const CAP_MS = 1000 * 60 * 15;
  return Math.min(CAP_MS, BASE_MS * Math.pow(2, Math.max(0, failedCount - 1)));
}


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




    const passwordHash = await hashPassword(input.password);
    return this.mutate(db => {




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




    const preDb = await this.load();
    const throttle = preDb.login_throttles.find(candidate => candidate.email === email);
    if (throttle && !throttleIsStale(throttle) && Date.parse(throttle.next_attempt_at) > Date.now()) {
      const retryAfterMs = Date.parse(throttle.next_attempt_at) - Date.now();
      await this.appendAudit({ event: 'auth_login_throttled', email, retry_after_ms: retryAfterMs, source: input.source });
      throw httpError(429, `Too many failed login attempts for this account. Retry in ${Math.max(1, Math.ceil(retryAfterMs / 1000))}s.`);
    }


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




    this.maybeExtendSession(session, tokenHash).catch(() => undefined);
    return publicUser(user);
  }












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
      if (!record) return;
      const absolute = record.absolute_expires_at || new Date(Date.parse(record.created_at) + ABSOLUTE_SESSION_MAX_MS).toISOString();
      record.absolute_expires_at = absolute;
      const newExpiry = Math.min(Date.now() + SESSION_TTL_MS, Date.parse(absolute));
      if (newExpiry > Date.parse(record.expires_at)) {
        record.expires_at = new Date(newExpiry).toISOString();
      }
    });
  }










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



      freshDb.sessions = freshDb.sessions.filter(candidate => candidate.user_id !== userId);
      const session = createSession(userId);
      freshDb.sessions.push(session.record);
      return { token: session.token, user: publicUser(freshUser) };
    });
    await this.appendAudit({ event: 'auth_password_changed', user_id: userId, revoked_prior_session: Boolean(currentToken) });
    return result;
  }














  async mintPasswordResetToken(input: { email: string; mintedBy: string }): Promise<{ token: string; userId: string; expiresAt: string }> {
    const email = normalizeEmail(input.email);
    return this.mutate(db => {
      const user = db.users.find(candidate => candidate.email === email);
      if (!user) throw httpError(404, 'No account exists with that email');
      const now = new Date();
      const expiresAt = new Date(now.getTime() + RESET_TOKEN_TTL_MS);

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

      clearLoginThrottle(db, user.email);
      return { userId: user.id, email: user.email, revokedSessions };
    });
    await this.appendAudit({ event: 'auth_reset_token_redeemed', user_id: result.userId, revoked_sessions: result.revokedSessions });
    return { userId: result.userId, email: result.email };
  }


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









  async listProjectsForWorkspace(workspaceId: string): Promise<AccountProject[]> {
    const db = await this.load();
    return db.projects
      .filter(project => project.workspace_id === workspaceId)
      .sort((left, right) => left.name.localeCompare(right.name));
  }


  async getWorkspaceById(workspaceId: string): Promise<AccountWorkspace | null> {
    const db = await this.load();
    return db.workspaces.find(candidate => candidate.id === workspaceId) || null;
  }












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
    if (!project) {
      throw httpError(404, `Project '${projectId}' was not found on this server. Confirm the project id in this repo's .klaurorc, or run \`klauro init\` to bind a fresh project.`);
    }
    const membership = db.workspace_users.find(member => member.workspace_id === project.workspace_id && member.user_id === userId);
    if (!membership) {
      const caller = db.users.find(candidate => candidate.id === userId);
      const callerDesc = caller ? `Signed in as ${caller.email}` : 'The signed-in account';
      throw httpError(404, `${callerDesc}, which has no access to workspace '${project.workspace_id}'. This repo is bound to a project owned by another account. Run \`klauro accounts\` on this machine — if that account is already signed in (just not active), \`klauro accounts --use <email>\` switches to it with no password needed. Otherwise re-bind this repo with \`klauro init --force\` to a project your current account can see; do not run \`klauro login\` unless you actually intend to replace the currently active session.`);
    }
    return project;
  }









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









  async setProjectAnalysisId(userId: string, projectId: string, analysisId: string): Promise<AccountProject> {
    return this.mutate(db => {
      const project = db.projects.find(candidate => candidate.id === projectId);
      if (!project) throw httpError(404, 'Project not found');
      requireMembership(db, userId, project.workspace_id);
      project.analysis_id = analysisId;
      return project;
    });
  }













  async setProjectRepoFacts(projectId: string, facts: RepoFacts | undefined): Promise<void> {
    if (!facts || (facts.contributor_count === undefined && !facts.first_commit_at && !facts.last_commit_at)) return;
    await this.mutate(db => {
      const project = db.projects.find(candidate => candidate.id === projectId);
      if (!project) return;
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


      password_reset_tokens: pruneResetTokens(Array.isArray(db.password_reset_tokens) ? db.password_reset_tokens : []),
      login_throttles: Array.isArray(db.login_throttles) ? db.login_throttles : [],
    };
  }


  private async appendAudit(event: Record<string, unknown>): Promise<void> {
    try {
      const dataDir = path.dirname(path.dirname(this.filePath));
      const auditDir = path.join(dataDir, 'audit');
      await fs.ensureDir(auditDir);
      await fs.appendFile(path.join(auditDir, 'events.jsonl'), `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`, 'utf8');
    } catch {

    }
  }




























  private async mutate<T>(fn: (db: AccountDatabase) => T | Promise<T>): Promise<T> {
    const task = this.writeQueue.then(async () => {
      const db = await this.load();
      const result = await fn(db);
      await this.writeToDisk(db);
      return result;
    });


    this.writeQueue = task.then(() => undefined, () => undefined);
    return task;
  }







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


function pruneResetTokens(tokens: AccountPasswordResetToken[]): AccountPasswordResetToken[] {
  const now = Date.now();
  return tokens.filter(token => Date.parse(token.expires_at) > now);
}

function throttleIsStale(throttle: { updated_at: string }): boolean {
  return Date.now() - Date.parse(throttle.updated_at) > LOGIN_THROTTLE_DECAY_MS;
}


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
