import test from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { captureInFlightChanges } from './in-flight-capture';
import { detectConceptualConflicts } from './conceptual-conflict';
import type { AgentInFlightState, ConflictCas } from './conceptual-conflict';

const execFileAsync = promisify(execFile);

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args]);
  return stdout;
}

async function freshGitRepo(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'klauro-inflight-capture-test-'));
  await git(dir, ['init', '-q']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test']);
  return dir;
}

async function commitAll(dir: string, message: string): Promise<void> {
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', message]);
}

test('captureInFlightChanges: ambiently detects a dropped-nullability change in getUser with NO self-report', async () => {
  const repo = await freshGitRepo();
  try {
    const before = `export function getUser(id: string): User | null {\n  return db.find(id) ?? null;\n}\n`;
    await fsp.writeFile(path.join(repo, 'auth.ts'), before, 'utf8');
    await commitAll(repo, 'initial: getUser returns User | null');

    const after = `export function getUser(id: string): User {\n  return db.find(id)!;\n}\n`;
    await fsp.writeFile(path.join(repo, 'auth.ts'), after, 'utf8');
    // Deliberately NOT committed — this is the dirty working tree, and
    // deliberately no agent ever calls check_conceptual_conflicts to report
    // this change. captureInFlightChanges must find it purely from git + AST.

    const changes = await captureInFlightChanges({ repoPath: repo });

    const getUserChange = changes.find((c) => c.name === 'getUser');
    assert.ok(getUserChange, 'expected an ambiently-captured SymbolChange for getUser');
    assert.equal(getUserChange!.file, 'auth.ts');
    assert.equal(getUserChange!.before?.nullable, true, 'before.nullable should reflect "User | null"');
    assert.equal(getUserChange!.after?.nullable, false, 'after.nullable should reflect "User" (no null/undefined)');
    assert.ok(
      getUserChange!.change_kind === 'nullability' || getUserChange!.change_kind === 'return_type',
      `expected change_kind to reflect the contract change, got ${getUserChange!.change_kind}`
    );
  } finally {
    await fsp.rm(repo, { recursive: true, force: true });
  }
});

test('captureInFlightChanges: new function is reported as an add', async () => {
  const repo = await freshGitRepo();
  try {
    await fsp.writeFile(path.join(repo, 'util.ts'), 'export const x = 1;\n', 'utf8');
    await commitAll(repo, 'initial');

    await fsp.writeFile(
      path.join(repo, 'util.ts'),
      'export const x = 1;\nexport function formatCurrency(n: number): string {\n  return `$${n}`;\n}\n',
      'utf8'
    );

    const changes = await captureInFlightChanges({ repoPath: repo });
    const added = changes.find((c) => c.name === 'formatCurrency');
    assert.ok(added, 'expected an add SymbolChange for the new function');
    assert.equal(added!.change_kind, 'add');
  } finally {
    await fsp.rm(repo, { recursive: true, force: true });
  }
});

test('captureInFlightChanges: unchanged body-only edits produce no signature-level change for that symbol', async () => {
  const repo = await freshGitRepo();
  try {
    await fsp.writeFile(
      path.join(repo, 'math.ts'),
      'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
      'utf8'
    );
    await commitAll(repo, 'initial');

    // Body-only change: same signature, same return type, same params.
    await fsp.writeFile(
      path.join(repo, 'math.ts'),
      'export function add(a: number, b: number): number {\n  // added a comment\n  return a + b;\n}\n',
      'utf8'
    );

    const changes = await captureInFlightChanges({ repoPath: repo });
    const addChange = changes.find((c) => c.name === 'add');
    assert.equal(addChange, undefined, 'a pure comment/body-only edit with unchanged signature should not surface a signature-level change');
  } finally {
    await fsp.rm(repo, { recursive: true, force: true });
  }
});

test('captureInFlightChanges: non-TS/JS changed file degrades to an honest unknown-change entry', async () => {
  const repo = await freshGitRepo();
  try {
    await fsp.writeFile(path.join(repo, 'main.py'), 'def get_user(id):\n    return db.find(id)\n', 'utf8');
    await commitAll(repo, 'initial');

    await fsp.writeFile(path.join(repo, 'main.py'), 'def get_user(id):\n    return db.find(id) or None\n', 'utf8');

    const changes = await captureInFlightChanges({ repoPath: repo });
    const pyChange = changes.find((c) => c.file === 'main.py');
    assert.ok(pyChange, 'expected a fallback entry for the changed Python file');
    assert.equal(pyChange!.change_kind, 'body');
    assert.equal(pyChange!.before, undefined, 'unknown-change fallback must not fabricate a before shape');
    assert.equal(pyChange!.after, undefined, 'unknown-change fallback must not fabricate an after shape');
  } finally {
    await fsp.rm(repo, { recursive: true, force: true });
  }
});

test('integration: two agents\' AMBIENT snapshots (one drops getUser nullability, one edits a caller) trigger detectConceptualConflicts contract-divergence — no self-report from either', async () => {
  const repoA = await freshGitRepo();
  const repoB = await freshGitRepo();
  try {
    // Agent A's repo: getUser loses its nullability.
    const beforeAuth = `export function getUser(id: string): User | null {\n  return db.find(id) ?? null;\n}\n`;
    await fsp.writeFile(path.join(repoA, 'auth.ts'), beforeAuth, 'utf8');
    await commitAll(repoA, 'initial');
    await fsp.writeFile(
      path.join(repoA, 'auth.ts'),
      `export function getUser(id: string): User {\n  return db.find(id)!;\n}\n`,
      'utf8'
    );
    const changesA = await captureInFlightChanges({ repoPath: repoA });

    // Agent B's repo: a caller of getUser is concurrently edited — its own
    // signature changes too (a new `locale` param), which is what makes this
    // an ambiently-CAPTURED SymbolChange for renderProfile (a pure body-only
    // edit with unchanged signature wouldn't register at all with a
    // syntactic signature extractor — see the "unchanged body-only edits"
    // test above). B never coordinated with A about getUser's contract.
    const beforeProfile = `export function renderProfile(id: string) {\n  const user = getUser(id);\n  if (!user) return null;\n  return user.name;\n}\n`;
    await fsp.writeFile(path.join(repoB, 'profile.ts'), beforeProfile, 'utf8');
    await commitAll(repoB, 'initial');
    await fsp.writeFile(
      path.join(repoB, 'profile.ts'),
      `export function renderProfile(id: string, locale: string) {\n  const user = getUser(id);\n  if (!user) return null;\n  return user.name.toUpperCase();\n}\n`,
      'utf8'
    );
    const changesB = await captureInFlightChanges({ repoPath: repoB });

    // Both ambient captures should have found something.
    assert.ok(changesA.some((c) => c.name === 'getUser'), 'agent A ambient capture should find the getUser contract change');

    // A CAS wiring getUser -> renderProfile as a "calls" edge (the fabric's
    // real CAS would carry this; here it's a minimal fixture matching what
    // conceptual-conflict.ts needs) is required for detector 1 to fire.
    const cas: ConflictCas = {
      nodes: [
        { id: 'sym:getUser', name: 'getUser' },
        { id: 'sym:renderProfile', name: 'renderProfile' },
      ],
      edges: [{ source: 'sym:renderProfile', target: 'sym:getUser', type: 'calls' }],
    };

    // Map the ambiently-captured symbol_ids onto the CAS's canonical ids so
    // the call-graph lookup in detectContractDivergence resolves — this
    // mirrors what server.ts's conceptualConflictCasForWorkspace would carry
    // in a real repo where both files are part of the SAME analyzed CAS.
    const statesA: AgentInFlightState = {
      agent_id: 'agent-a',
      intent: 'ambient capture: auth.ts changed',
      changes: changesA
        .filter((c) => c.name === 'getUser')
        .map((c) => ({ ...c, symbol_id: 'sym:getUser' })),
    };
    const statesB: AgentInFlightState = {
      agent_id: 'agent-b',
      intent: 'ambient capture: profile.ts changed',
      changes: changesB
        .filter((c) => c.name === 'renderProfile')
        .map((c) => ({ ...c, symbol_id: 'sym:renderProfile' })),
    };

    const conflicts = detectConceptualConflicts([statesA, statesB], cas);
    const contractDivergence = conflicts.filter((c) => c.kind === 'contract-divergence');
    assert.equal(contractDivergence.length, 1, 'expected exactly one ambiently-detected contract-divergence finding');
    assert.deepEqual([...contractDivergence[0].agents].sort(), ['agent-a', 'agent-b']);
    assert.equal(contractDivergence[0].passes_textual_merge, true);
  } finally {
    await fsp.rm(repoA, { recursive: true, force: true });
    await fsp.rm(repoB, { recursive: true, force: true });
  }
});
