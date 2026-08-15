




















import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { parseIgnorePatterns, sourcePatternListMatches } from '../klauro-config';
import type { SymbolChange } from './conceptual-conflict';

















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


export interface RedactionRules {

  secretPatterns: string[];

  ignorePatterns: string[];

  ignorePath?: string;
}







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


export interface InFlightDiffFile {
  path: string;

  patch?: string;

  content?: string;
}


export type DropReason = 'secret-pattern' | 'klauroignore';

export interface DroppedFile {
  path: string;
  reason: DropReason;

  pattern: string;
}

export interface RedactInFlightDiffOptions {





  diffOnly?: boolean;
}

export interface RedactInFlightDiffResult {
  kept: InFlightDiffFile[];
  dropped: DroppedFile[];
}










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


export interface DroppedChange {
  symbol_id: string;
  file: string;
  reason: DropReason;
  pattern: string;
}

export interface RedactInFlightChangesResult {
  kept: SymbolChange[];
  dropped: DroppedChange[];
}


















export function redactInFlightChanges(
  changes: SymbolChange[],
  rules: RedactionRules
): RedactInFlightChangesResult {
  const kept: SymbolChange[] = [];
  const dropped: DroppedChange[] = [];

  for (const change of changes) {
    const secretMatch = firstMatchingPattern(change.file, rules.secretPatterns);
    if (secretMatch) {
      dropped.push({ symbol_id: change.symbol_id, file: change.file, reason: 'secret-pattern', pattern: secretMatch });
      continue;
    }
    const ignoreMatch = firstMatchingPattern(change.file, rules.ignorePatterns);
    if (ignoreMatch) {
      dropped.push({ symbol_id: change.symbol_id, file: change.file, reason: 'klauroignore', pattern: ignoreMatch });
      continue;
    }
    kept.push(change);
  }

  return { kept, dropped };
}






export interface TenantScoped {

  org_id?: string;



  workspace_id?: string;
  workspace?: string;
}


export interface TenantRequester {
  org_id?: string;
  workspace_id?: string;
}

function recordWorkspaceId(record: TenantScoped): string | undefined {
  return record.workspace_id ?? record.workspace;
}










export function isVisibleToRequester(record: TenantScoped, requester: TenantRequester): boolean {
  const recordOrg = record.org_id ?? null;
  const requesterOrg = requester.org_id ?? null;
  if (recordOrg !== requesterOrg) return false;

  const recordWs = recordWorkspaceId(record) ?? null;
  const requesterWs = requester.workspace_id ?? null;
  if (recordWs !== requesterWs) return false;

  return true;
}


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


export function assertSameTenant(record: TenantScoped, requester: TenantRequester): void {
  if (!isVisibleToRequester(record, requester)) {
    throw new TenantMismatchError(record, requester);
  }
}






export interface SecurityAuditEntry {
  ts: string;
  actor: string;
  action: string;
  workspace: string;
  scope: string;
}








export function getSecurityStoreDir(workspaceId: string): string {
  const base = process.env.KLAURO_COORD_DIR || path.join(os.homedir(), '.klauro', 'coordination');
  return path.join(base, workspaceId);
}

function getAuditLogPath(dir: string): string {
  return path.join(dir, 'security-audit.jsonl');
}







export async function appendSecurityAudit(dir: string, entry: SecurityAuditEntry): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  const logPath = getAuditLogPath(dir);
  await fsp.appendFile(logPath, JSON.stringify(entry) + '\n', 'utf8');
}


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

    }
  }
  return entries;
}
