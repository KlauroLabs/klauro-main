/**
 * Security / privacy scaffold for uncommitted-code sync (§WS-F SPEC-COORDINATION-FABRIC.md,
 * HARD GATE — must exist before any cross-machine in-flight/claim sync ships).
 *
 * Pure, IO-light, transport-free (except reading `.klauroignore` off disk and
 * appending to a local audit file — no network). Three responsibilities:
 *
 *  1. Redaction / ignore filter — never let a secret-shaped file leave the
 *     machine in an in-flight diff, and support diff-only (no full-file-body)
 *     mode for extra caution.
 *  2. Tenancy/authz predicates — a WorkClaim/InFlightSnapshot is only visible
 *     to a requester in the same org_id + workspace_id.
 *  3. Append-only audit log — who published/read which in-flight scope, for
 *     the WS-F acceptance test ("audit log: who published/read which scope").
 *
 * Reuses the existing ignore-glob engine from `klauro-config.ts`
 * (`parseIgnorePatterns` / `sourcePatternListMatches`) instead of reimplementing
 * gitignore-style matching, and the local coordination-dir convention from
 * `local-store.ts` (`KLAURO_COORD_DIR || ~/.klauro/coordination/<workspace_id>`).
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { parseIgnorePatterns, sourcePatternListMatches } from '../klauro-config';

// ---------------------------------------------------------------------------
// 1. Redaction / ignore filter
// ---------------------------------------------------------------------------

/**
 * Built-in default-deny patterns for secret-shaped filenames. These apply
 * regardless of `.klauroignore` contents — a project cannot accidentally
 * un-deny a real secret file by omission. Matched with the same glob engine
 * as `.klauroignore` (`sourcePatternListMatches`), so `**`/`*` semantics match
 * exactly what `klauro-config.ts` already uses for uploads.
 *
 * Deliberately narrow ("environment.ts" must NOT match "*.env*"-style rules):
 * patterns target known secret file *shapes* (dotenv, PEM/key/keystore
 * material, credential/secret dumps), not any file whose name merely contains
 * a secret-adjacent word as a substring of a longer identifier.
 */
export function defaultSecretDenyPatterns(): string[] {
  return [
    '**/.env',
    '**/.env.*',
    '**/*.pem',
    '**/*.key',
    '**/id_rsa',
    '**/id_rsa.*',
    '**/id_dsa',
    '**/id_dsa.*',
    '**/id_ecdsa',
    '**/id_ecdsa.*',
    '**/id_ed25519',
    '**/id_ed25519.*',
    '**/*.p12',
    '**/*.pfx',
    '**/*.keystore',
    '**/credentials',
    '**/credentials.*',
    '**/credentials-*',
    '**/secrets',
    '**/secrets.*',
    '**/secrets-*',
    '**/*.secrets',
  ];
}

/** Merged redaction ruleset: built-in secret deny-list + project `.klauroignore` globs. */
export interface RedactionRules {
  /** Always-applied secret filename patterns (not user-overridable). */
  secretPatterns: string[];
  /** Project-supplied `.klauroignore` patterns, if the file exists. */
  ignorePatterns: string[];
  /** Absolute path to the `.klauroignore` that was loaded, if any. */
  ignorePath?: string;
}

/**
 * Load redaction rules for a project: the built-in secret default-deny list
 * merged with `.klauroignore` (gitignore-style globs) if present. No network,
 * no throw on missing file (an absent `.klauroignore` just means "no extra
 * project-specific rules" — the secret deny-list still applies).
 */
export async function loadRedactionRules(projectPath: string): Promise<RedactionRules> {
  const root = path.resolve(projectPath);
  const ignorePath = path.join(root, '.klauroignore');
  let ignorePatterns: string[] = [];
  let foundPath: string | undefined;
  try {
    const content = await fsp.readFile(ignorePath, 'utf8');
    ignorePatterns = parseIgnorePatterns(content);
    foundPath = ignorePath;
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err;
  }
  return {
    secretPatterns: defaultSecretDenyPatterns(),
    ignorePatterns,
    ignorePath: foundPath,
  };
}

/** One file entry in an in-flight diff, as captured by WS-B's diff-context computation. */
export interface InFlightDiffFile {
  path: string;
  /** Unified-diff-style patch text, if available. */
  patch?: string;
  /** Full file body — only ever sent when NOT in diff-only mode. */
  content?: string;
}

/** Why a file was dropped from an in-flight diff before it left the machine. */
export type DropReason = 'secret-pattern' | 'klauroignore';

export interface DroppedFile {
  path: string;
  reason: DropReason;
  /** The specific glob pattern that matched, for audit/debugging. */
  pattern: string;
}

export interface RedactInFlightDiffOptions {
  /**
   * When true, strip `content` (full file body) from every kept file,
   * retaining only `patch`. Use for the WS-F "diff-only, never full-file"
   * mode. Files are still subject to the same drop rules either way.
   */
  diffOnly?: boolean;
}

export interface RedactInFlightDiffResult {
  kept: InFlightDiffFile[];
  dropped: DroppedFile[];
}

/**
 * Apply redaction rules to an in-flight diff before it is ever published
 * cross-machine. Drops any file whose path matches a secret pattern or a
 * `.klauroignore` glob; in `diffOnly` mode, strips full-file `content` from
 * every remaining kept file. A dropped file's body is NEVER included in the
 * `dropped` list — only its path and the matching reason/pattern, so the
 * secret content itself never appears in logs, telemetry, or this return
 * value.
 */
export function redactInFlightDiff(
  diff: InFlightDiffFile[],
  rules: RedactionRules,
  options: RedactInFlightDiffOptions = {}
): RedactInFlightDiffResult {
  const kept: InFlightDiffFile[] = [];
  const dropped: DroppedFile[] = [];

  for (const file of diff) {
    const secretMatch = firstMatchingPattern(file.path, rules.secretPatterns);
    if (secretMatch) {
      dropped.push({ path: file.path, reason: 'secret-pattern', pattern: secretMatch });
      continue;
    }
    const ignoreMatch = firstMatchingPattern(file.path, rules.ignorePatterns);
    if (ignoreMatch) {
      dropped.push({ path: file.path, reason: 'klauroignore', pattern: ignoreMatch });
      continue;
    }
    if (options.diffOnly) {
      const { content, ...rest } = file;
      kept.push({ ...rest });
    } else {
      kept.push({ ...file });
    }
  }

  return { kept, dropped };
}

function firstMatchingPattern(filePath: string, patterns: string[]): string | undefined {
  for (const pattern of patterns) {
    if (sourcePatternListMatches(filePath, [pattern])) return pattern;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 2. Tenancy / authz predicates
// ---------------------------------------------------------------------------

/** A tenant-scoped record: extends WorkClaim/InFlightSnapshot with optional org/workspace scoping. */
export interface TenantScoped {
  /** Organization the record belongs to. Optional for backward compat with un-scoped records. */
  org_id?: string;
  /** Workspace the record belongs to. Falls back to `workspace`/`workspace_id` field names
   * already present on WorkClaim (`workspace_id`) / InFlightSnapshot (`workspace`) via the
   * generic accessor below — callers may also set `workspace_id` directly here. */
  workspace_id?: string;
  workspace?: string;
}

/** The identity making a request: which org + workspace it claims membership in. */
export interface TenantRequester {
  org_id?: string;
  workspace_id?: string;
}

function recordWorkspaceId(record: TenantScoped): string | undefined {
  return record.workspace_id ?? record.workspace;
}

/**
 * A record is visible to a requester only if both `org_id` and `workspace_id`
 * match. Records/requesters with no `org_id` are treated as belonging to a
 * single implicit default org (so existing single-tenant/local-only data
 * doesn't spuriously fail authz) — but once either side sets an `org_id`,
 * both must match exactly. `workspace_id` (or `workspace`) must always match
 * when present on the record; a record with no workspace at all is only
 * visible to a requester that also specifies no workspace.
 */
export function isVisibleToRequester(record: TenantScoped, requester: TenantRequester): boolean {
  const recordOrg = record.org_id ?? null;
  const requesterOrg = requester.org_id ?? null;
  if (recordOrg !== requesterOrg) return false;

  const recordWs = recordWorkspaceId(record) ?? null;
  const requesterWs = requester.workspace_id ?? null;
  if (recordWs !== requesterWs) return false;

  return true;
}

/** Thrown by `assertSameTenant` when a requester attempts to access another tenant's record. */
export class TenantMismatchError extends Error {
  constructor(record: TenantScoped, requester: TenantRequester) {
    super(
      `cross-tenant access denied: record org=${record.org_id ?? '(none)'} workspace=${
        recordWorkspaceId(record) ?? '(none)'
      } is not visible to requester org=${requester.org_id ?? '(none)'} workspace=${
        requester.workspace_id ?? '(none)'
      }`
    );
    this.name = 'TenantMismatchError';
  }
}

/** Throws `TenantMismatchError` unless `isVisibleToRequester(record, requester)`. */
export function assertSameTenant(record: TenantScoped, requester: TenantRequester): void {
  if (!isVisibleToRequester(record, requester)) {
    throw new TenantMismatchError(record, requester);
  }
}

// ---------------------------------------------------------------------------
// 3. Audit log
// ---------------------------------------------------------------------------

/** One append-only security audit entry: who did what, to which scope. */
export interface SecurityAuditEntry {
  ts: string;
  actor: string;
  action: string;
  workspace: string;
  scope: string;
}

/**
 * Root directory for a workspace's coordination store — mirrors
 * `local-store.ts`'s `getStoreDir` convention exactly (same env var, same
 * default path) so the audit log lives alongside `claims.jsonl` without this
 * module importing local-store.ts (kept dependency-free/pure per the module
 * boundary noted in local-store.ts's own header).
 */
export function getSecurityStoreDir(workspaceId: string): string {
  const base = process.env.KLAURO_COORD_DIR || path.join(os.homedir(), '.klauro', 'coordination');
  return path.join(base, workspaceId);
}

function getAuditLogPath(dir: string): string {
  return path.join(dir, 'security-audit.jsonl');
}

/**
 * Append one entry to the workspace's append-only security audit log at
 * `<dir>/security-audit.jsonl`. `dir` is caller-supplied (typically
 * `getSecurityStoreDir(workspaceId)`) so tests/callers control placement
 * without this module hardcoding a global side effect beyond what's asked.
 */
export async function appendSecurityAudit(dir: string, entry: SecurityAuditEntry): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  const logPath = getAuditLogPath(dir);
  await fsp.appendFile(logPath, JSON.stringify(entry) + '\n', 'utf8');
}

/** Read and parse every line of a workspace's security audit log (empty if none yet). */
export async function readSecurityAudit(dir: string): Promise<SecurityAuditEntry[]> {
  const logPath = getAuditLogPath(dir);
  let raw: string;
  try {
    raw = await fsp.readFile(logPath, 'utf8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  const entries: SecurityAuditEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as SecurityAuditEntry);
    } catch {
      // tolerate a torn/partial line, matching local-store.ts's readClaimLog behavior.
    }
  }
  return entries;
}
