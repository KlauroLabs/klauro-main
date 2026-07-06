import * as crypto from 'node:crypto';
import * as fs from 'fs-extra';
import * as path from 'node:path';
import { detectRemoteProvider } from './remote-provider';

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
}

export interface AccountSession {
  token_hash: string;
  user_id: string;
  created_at: string;
  expires_at: string;
}

interface AccountDatabase {
  version: 1;
  users: AccountUser[];
  workspaces: AccountWorkspace[];
  workspace_users: AccountWorkspaceUser[];
  projects: AccountProject[];
  sessions: AccountSession[];
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
    const db = await this.load();
    if (db.users.some(user => user.email === email)) {
      throw httpError(409, 'A user with that email already exists');
    }

    const now = new Date().toISOString();
    const user: AccountUser = {
      id: id('usr'),
      email,
      name,
      password_hash: await hashPassword(input.password),
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
    await this.save(db);
    return { token: session.token, user: publicUser(user) };
  }

  async login(input: { email: string; password: string }): Promise<AccountSessionResult> {
    const email = normalizeEmail(input.email);
    const db = await this.load();
    const user = db.users.find(candidate => candidate.email === email);
    if (!user || !(await verifyPassword(input.password, user.password_hash))) {
      throw httpError(401, 'Invalid email or password');
    }
    const session = createSession(user.id);
    db.sessions = pruneSessions(db.sessions);
    db.sessions.push(session.record);
    await this.save(db);
    return { token: session.token, user: publicUser(user) };
  }

  async authenticate(token: string | undefined): Promise<PublicAccountUser | null> {
    if (!token) return null;
    const db = await this.load();
    const tokenHash = hashToken(token);
    const session = db.sessions.find(candidate => candidate.token_hash === tokenHash);
    if (!session || new Date(session.expires_at).getTime() <= Date.now()) return null;
    const user = db.users.find(candidate => candidate.id === session.user_id);
    return user ? publicUser(user) : null;
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
    const db = await this.load();
    const workspace: AccountWorkspace = {
      id: id('wsp'),
      name,
      created_by_user_id: userId,
      created_at: now,
    };
    db.workspaces.push(workspace);
    db.workspace_users.push({ workspace_id: workspace.id, user_id: userId, role: 'owner', created_at: now });
    await this.save(db);
    return { ...workspace, role: 'owner' };
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
    const db = await this.load();
    requireMembership(db, actorUserId, workspaceId, ['owner', 'admin']);
    const user = db.users.find(candidate => candidate.email === email);
    if (!user) throw httpError(404, 'No user exists with that email yet');
    const existing = db.workspace_users.find(member => member.workspace_id === workspaceId && member.user_id === user.id);
    if (existing) {
      existing.role = role;
      await this.save(db);
      return existing;
    }
    const membership: AccountWorkspaceUser = {
      workspace_id: workspaceId,
      user_id: user.id,
      role,
      created_at: new Date().toISOString(),
    };
    db.workspace_users.push(membership);
    await this.save(db);
    return membership;
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
    const db = await this.load();
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
    await this.save(db);
    return project;
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

  async setProjectAnalysisId(userId: string, projectId: string, analysisId: string): Promise<AccountProject> {
    const db = await this.load();
    const project = db.projects.find(candidate => candidate.id === projectId);
    if (!project) throw httpError(404, 'Project not found');
    requireMembership(db, userId, project.workspace_id);
    project.analysis_id = analysisId;
    await this.save(db);
    return project;
  }

  private async load(): Promise<AccountDatabase> {
    if (!(await fs.pathExists(this.filePath))) {
      return { version: 1, users: [], workspaces: [], workspace_users: [], projects: [], sessions: [] };
    }
    const db = await fs.readJson(this.filePath) as AccountDatabase;
    return {
      version: 1,
      users: Array.isArray(db.users) ? db.users : [],
      workspaces: Array.isArray(db.workspaces) ? db.workspaces : [],
      workspace_users: Array.isArray(db.workspace_users) ? db.workspace_users : [],
      projects: Array.isArray(db.projects) ? db.projects : [],
      sessions: pruneSessions(Array.isArray(db.sessions) ? db.sessions : []),
    };
  }

  private async save(db: AccountDatabase): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.ensureDir(path.dirname(this.filePath));
      await fs.writeJson(this.filePath, db, { spaces: 2 });
    });
    await this.writeQueue;
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
    },
  };
}

function pruneSessions(sessions: AccountSession[]): AccountSession[] {
  const now = Date.now();
  return sessions.filter(session => new Date(session.expires_at).getTime() > now);
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
