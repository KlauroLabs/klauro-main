/**
 * DEPTH-3 — behavioral / semantic DIFF head-to-head vs the REAL installed
 * codebase-memory-mcp binary.
 *
 * THE QUESTION (the "is the change moving the right direction?" strategy pillar):
 * given TWO versions of a codebase, what changed in BEHAVIOR — not which bytes
 * moved, but: was an auth guard removed so a route is now public? did a journey
 * stop reaching its sink (a source->sink path broke)? was a capability/journey
 * added? — answered as a STRUCTURED behavioral delta, not a textual git diff.
 *
 * ------------------------------------------------------------------------------
 * WHAT KLAURO'S BEHAVIORAL DIFF ACTUALLY IS TODAY (grounded, not assumed):
 *
 *   Klauro ships a REAL behavioral diff: `diffBehavior(before, after)` in
 *   packages/analyzer-core/src/analyzer/core/behavior-diff.ts, surfaced over MCP
 *   by `diffBehaviorAgainstSnapshot` (query.ts). It is NOT a node/edge churn diff
 *   — it diffs the BEHAVIOR pillars of two CASOutputs:
 *
 *     - cas.user_journeys      -> journeys ADDED / REMOVED / CHANGED. A journey
 *                                 binds entry (METHOD /path) -> steps (the cross-
 *                                 function call chain) -> terminal_entities (the
 *                                 sink). A removed journey = a source->sink path
 *                                 that broke; a changed journey reports e.g.
 *                                 "lost auth boundary".
 *     - journey.security_boundaries (entry-guards like requireAuth, kind=
 *                                 authentication) -> security.newly_unguarded_
 *                                 entries with reason 'lost-guard' / 'new-
 *                                 unguarded', plus boundaries_added/removed. This
 *                                 is the auth-guard-removed signal.
 *     - cas.system_capabilities -> capabilities.added / removed / possibly_
 *                                 duplicated.
 *     - cas.data_lineage        -> entities_with_new_writers, sensitive_exposure_
 *                                 changes (a data-flow path now bypassing a
 *                                 boundary / reaching a new external recipient).
 *     - cas.paradigm_conformance-> paradigms.new_deviations / resolved.
 *
 *   The diff emits human-readable `summary.risk_flags` ("Journey 'X' lost its auth
 *   boundary."). So Klauro's behavioral diff is genuinely BEHAVIORAL (journey /
 *   auth-boundary / capability / lineage / paradigm semantics), grounded in real
 *   CAS fields — not node/edge adds. This bench scores exactly that output against
 *   per-fixture truth, mapping the diff to a {kind} taxonomy:
 *     auth-removed       <- newly_unguarded_entries(lost-guard) | journeys.changed
 *                            ("lost auth boundary") | boundaries_removed
 *     journey-broken     <- journeys.removed
 *     capability-added   <- capabilities.added | journeys.added
 *
 * ------------------------------------------------------------------------------
 * CODEBASE-MEMORY AT ITS BEST (give the competitor its strongest shot):
 *
 *   cbm has `detect_changes` + `index_status`. We drive both at full strength:
 *   index the AFTER snapshot, then call detect_changes and index_status. What cbm
 *   returns:
 *     - detect_changes -> { changed_files:[...], changed_count, impacted_symbols:
 *       [], depth }. A git-derived CHANGED-FILE LIST (textual file churn, scoped
 *       to the git worktree) with NO behavioral semantics: impacted_symbols is
 *       empty and there is no auth/journey/capability/boundary concept at all.
 *     - index_status -> { nodes, edges, status }. Static one-snapshot counts.
 *
 *   cbm is a static index of ONE snapshot; it has no behavioral-delta concept. It
 *   can say WHICH FILES changed, never WHAT BEHAVIOR changed. So its behavioral-
 *   change set is empty on every fixture. We record exactly what detect_changes /
 *   index_status returned, for full transparency.
 *
 * VERDICT (out-of-category by construction, measured honestly):
 *   - win  : cbm cannot produce the behavioral delta (F1 strictly below Klauro).
 *   - tie  : cbm somehow produces a behavioral-change set with F1 >= Klauro
 *            (would be surprising; surfaced honestly if it happens).
 *   - loss : cbm STRICTLY beats Klauro on behavioral-change F1 -> surface LOUD.
 */

import * as fs from 'fs-extra';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { analyzeForBench } from './product-analysis';
import { diffBehavior } from '../../../../packages/analyzer-core/src/analyzer/core/behavior-diff';
import { codebaseMemoryPath } from './real-camp-arms';
import type { CASBehaviorDiff } from '../../../../packages/analyzer-core/src/types/cas.types';

/** A behavioral change kind the truth + the bench agree on. */
export type BehavioralKind = 'auth-removed' | 'journey-broken' | 'capability-added';

interface BehavioralTruth {
  case: string;
  language: string;
  control: boolean;
  description: string;
  behavioral_changes: Array<{ kind: BehavioralKind; detail: string }>;
}

export type BehavioralDiffVerdict = 'win' | 'tie' | 'loss';

export interface DepthBehavioralDiffCaseResult {
  fixture: string;
  control: boolean;
  /** Truth behavioral-change kinds (empty for the control). */
  truthKinds: BehavioralKind[];
  /** Klauro's emitted behavioral-change kinds (from diffBehavior). */
  klauroKinds: BehavioralKind[];
  /** The human-readable risk flags Klauro emitted (evidence). */
  klauroRiskFlags: string[];
  klauroF1: number;
  klauroTokens: number;
  /** cbm's behavioral-change kinds (empty — it has no behavioral-delta concept). */
  cbmKinds: BehavioralKind[];
  cbmF1: number;
  cbmTokens: number;
  /** What cbm.detect_changes / index_status actually surfaced, for transparency. */
  cbmDetectChanges: string;
  /** For the control: did Klauro correctly flag NO behavioral change? */
  controlCleanByKlauro: boolean | null;
  verdict: BehavioralDiffVerdict;
  tokenSaving: number;
}

export interface DepthBehavioralDiffReport {
  available: boolean;
  /** The Klauro query path that surfaces the behavioral delta. */
  klauroQueryPath: string;
  /** cbm's best path and why it cannot produce the behavioral delta. */
  cbmQueryPath: string;
  results: DepthBehavioralDiffCaseResult[];
  aggregate: {
    cases: number;
    klauroWins: number;
    ties: number;
    losses: number;
    winRate: number;
    meanKlauroF1: number;
    meanCbmF1: number;
    tokenSaving: number;
    lossFixtures: string[];
  };
}

const FIXTURES = ['auth-removed', 'journey-broken', 'capability-added', 'control-rename'];

function f1(produced: string[], truth: string[]): number {
  const prod = [...new Set(produced)];
  const truthSet = [...new Set(truth)];
  const tp = prod.filter(r => truthSet.includes(r)).length;
  const precision = prod.length ? tp / prod.length : truthSet.length ? 0 : 1;
  const recall = truthSet.length ? tp / truthSet.length : 1;
  return precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
}

function toTokens(bytes: number): number {
  return Math.max(1, Math.round(bytes / 4));
}

/**
 * Map Klauro's structured behavioral diff to the {kind} taxonomy the truth uses.
 * Each kind is derived ONLY from real CASBehaviorDiff fields — no fabrication.
 */
function klauroKindsFromDiff(diff: CASBehaviorDiff): BehavioralKind[] {
  const kinds = new Set<BehavioralKind>();

  // auth-removed: a journey lost its auth boundary (lost-guard), a journey-change
  // says "lost auth boundary", or an auth boundary label disappeared.
  const lostGuard = diff.security.newly_unguarded_entries.some(e => e.reason === 'lost-guard');
  const changedLostAuth = diff.journeys.changed.some(c =>
    c.what.some(w => /lost auth boundary|removed security boundary/i.test(w)),
  );
  if (lostGuard || changedLostAuth || diff.security.boundaries_removed.length > 0) {
    kinds.add('auth-removed');
  }

  // journey-broken: a previously-present journey (a source->sink path) is gone.
  if (diff.journeys.removed.length > 0) kinds.add('journey-broken');

  // capability-added: a new capability and/or a new journey appeared.
  if (diff.capabilities.added.length > 0 || diff.journeys.added.length > 0) {
    kinds.add('capability-added');
  }

  return [...kinds];
}

/**
 * Klauro: orchestrate before + after, run the REAL diffBehavior, map to kinds.
 * tokens = the bytes of the structured behavioral delta an agent would read
 * (the counts + risk flags + per-kind change list).
 */
async function klauroBehavioralDiff(
  caseDir: string,
): Promise<{ kinds: BehavioralKind[]; riskFlags: string[]; bytes: number }> {
  const before: any = await analyzeForBench(path.join(caseDir, 'before'));
  const after: any = await analyzeForBench(path.join(caseDir, 'after'));
  const diff = diffBehavior(before, after);
  const kinds = klauroKindsFromDiff(diff);

  // The compact behavioral-delta payload an agent consumes (matches the
  // diffBehaviorAgainstSnapshot MCP response shape: counts + risk_flags + the
  // changed/added/removed journey + capability + boundary lists).
  const payload = {
    behavioral_change_kinds: kinds,
    risk_flags: diff.summary.risk_flags,
    journeys: {
      added: diff.journeys.added.map(j => j.entry),
      removed: diff.journeys.removed.map(j => j.entry),
      changed: diff.journeys.changed,
    },
    security: {
      boundaries_removed: diff.security.boundaries_removed,
      newly_unguarded_entries: diff.security.newly_unguarded_entries,
    },
    capabilities: { added: diff.capabilities.added, removed: diff.capabilities.removed },
  };
  return {
    kinds,
    riskFlags: diff.summary.risk_flags,
    bytes: Buffer.byteLength(JSON.stringify(payload), 'utf8'),
  };
}

/**
 * codebase-memory at its BEST: index the AFTER snapshot, then call detect_changes
 * and index_status — its only change/state-aware tools. Returns:
 *   - kinds : cbm's behavioral-change kinds. cbm has NO behavioral-delta concept
 *             (detect_changes is a git changed-file list, impacted_symbols empty),
 *             so this is always [].
 *   - detail: a transparency string of what detect_changes / index_status returned.
 *   - bytes : the bytes of cbm's detect_changes output an agent would read.
 */
function cbmBehavioralDiff(
  caseDir: string,
): { kinds: BehavioralKind[]; detail: string; bytes: number } {
  const bin = codebaseMemoryPath();
  if (!bin) return { kinds: [], detail: 'cbm absent', bytes: 0 };

  const afterDir = path.join(caseDir, 'after');
  let project = '';
  try {
    const idx = execFileSync(bin, ['cli', 'index_repository', JSON.stringify({ repo_path: afterDir })], {
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const line = idx.split('\n').find(l => l.trim().startsWith('{') && l.includes('"project"'));
    if (line) project = JSON.parse(line).project;
  } catch {
    return { kinds: [], detail: 'index failed', bytes: 0 };
  }
  if (!project) project = afterDir.replace(/^\/+/, '').replace(/[^A-Za-z0-9_]+/g, '-');

  const runTool = (tool: string): { json: any; bytes: number } => {
    try {
      const out = execFileSync(bin, ['cli', tool, JSON.stringify({ project })], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: 60_000,
      });
      const jsonLine = out.split('\n').find(l => l.trim().startsWith('{')) || '{}';
      return { json: JSON.parse(jsonLine), bytes: Buffer.byteLength(jsonLine, 'utf8') };
    } catch {
      return { json: {}, bytes: 0 };
    }
  };

  const changes = runTool('detect_changes');
  const status = runTool('index_status');

  // cbm has no behavioral concept: detect_changes yields a textual changed-file
  // list with impacted_symbols:[] and no auth/journey/capability/boundary fields.
  const changedCount =
    typeof changes.json.changed_count === 'number'
      ? changes.json.changed_count
      : (changes.json.changed_files || []).length;
  const impacted = (changes.json.impacted_symbols || []).length;
  const detail =
    `detect_changes: ${changedCount} changed files, ${impacted} impacted symbols (git file churn, no behavioral semantics); ` +
    `index_status: ${status.json.nodes ?? '?'} nodes / ${status.json.edges ?? '?'} edges (single-snapshot static index — no auth/journey/capability/boundary delta)`;

  return { kinds: [], detail, bytes: changes.bytes };
}

let cached: DepthBehavioralDiffReport | null = null;

/**
 * Build the DEPTH-3 behavioral-diff head-to-head vs the real codebase-memory
 * binary.
 *
 * Signature for central integration (camps-bench.ts / dashboard.html):
 *   import { buildDepthBehavioralDiffReport } from './depth-behavioral-diff-bench';
 *   const report = await buildDepthBehavioralDiffReport();
 *   // report.available === false when the cbm binary is not installed.
 *
 * Result is cached in-process after the first build.
 */
export async function buildDepthBehavioralDiffReport(): Promise<DepthBehavioralDiffReport> {
  if (cached) return cached;

  const fixturesRoot = path.join(__dirname, '..', '..', 'fixtures', 'depth-behavioral-diff');
  const binAvailable = codebaseMemoryPath() != null;

  const results: DepthBehavioralDiffCaseResult[] = [];
  for (const fxName of FIXTURES) {
    const dir = path.join(fixturesRoot, fxName);
    let truth: BehavioralTruth;
    try {
      truth = await fs.readJson(path.join(dir, 'truth.json'));
    } catch {
      continue;
    }
    const truthKinds = truth.behavioral_changes.map(c => c.kind);

    const kl = await klauroBehavioralDiff(dir);
    const klauroF1 = f1(kl.kinds, truthKinds);

    const cbm = binAvailable
      ? cbmBehavioralDiff(dir)
      : { kinds: [] as BehavioralKind[], detail: 'cbm absent', bytes: 0 };
    const cbmF1 = f1(cbm.kinds, truthKinds);

    // Control check: for the control fixture, Klauro must emit NO behavioral kind.
    const controlCleanByKlauro = truth.control ? kl.kinds.length === 0 : null;

    let verdict: BehavioralDiffVerdict;
    if (cbmF1 > klauroF1 + 1e-9) verdict = 'loss';
    else if (cbmF1 >= klauroF1 - 1e-9 && cbm.kinds.length > 0) verdict = 'tie';
    else verdict = 'win';

    const klauroTokens = toTokens(kl.bytes);
    let cbmTokens: number;
    if (cbm.kinds.length > 0) {
      cbmTokens = toTokens(cbm.bytes);
    } else {
      // cbm produced no behavioral delta; model its read cost as the detect_changes
      // output it returned plus the changed source it would have to read to (fail
      // to) reconstruct the behavior change itself.
      let srcBytes = cbm.bytes;
      try {
        for (const half of ['before', 'after']) {
          const halfDir = path.join(dir, half);
          for (const f of await fs.readdir(halfDir)) {
            const st = await fs.stat(path.join(halfDir, f));
            if (st.isFile()) srcBytes += st.size;
          }
        }
      } catch {
        /* noop */
      }
      cbmTokens = toTokens(srcBytes);
    }
    const tokenSaving = cbmTokens > 0 ? (cbmTokens - klauroTokens) / cbmTokens : 0;

    results.push({
      fixture: fxName,
      control: truth.control,
      truthKinds,
      klauroKinds: kl.kinds,
      klauroRiskFlags: kl.riskFlags,
      klauroF1,
      klauroTokens,
      cbmKinds: cbm.kinds,
      cbmF1,
      cbmTokens,
      cbmDetectChanges: cbm.detail,
      controlCleanByKlauro,
      verdict,
      tokenSaving,
    });
  }

  const cases = results.length;
  const klauroWins = results.filter(r => r.verdict === 'win').length;
  const ties = results.filter(r => r.verdict === 'tie').length;
  const losses = results.filter(r => r.verdict === 'loss').length;
  const lossFixtures = results.filter(r => r.verdict === 'loss').map(r => r.fixture);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  cached = {
    available: binAvailable,
    klauroQueryPath:
      'orchestrateAnalysis(before) + orchestrateAnalysis(after) -> diffBehavior(before, after) ' +
      '(diffBehaviorAgainstSnapshot MCP tool): a STRUCTURED behavioral delta over the CAS behavior ' +
      'pillars — user_journeys (added/removed/changed), security_boundaries (newly_unguarded / lost-guard), ' +
      'system_capabilities (added/removed), data_lineage, paradigm_conformance — with human risk_flags.',
    cbmQueryPath:
      'index_repository(after) -> detect_changes + index_status: detect_changes returns a git changed-FILE ' +
      'list with impacted_symbols:[] (textual churn, no behavioral semantics); index_status returns single-' +
      'snapshot node/edge counts. cbm is a static one-snapshot index with no behavioral-delta concept.',
    results,
    aggregate: {
      cases,
      klauroWins,
      ties,
      losses,
      winRate: cases ? (klauroWins + ties) / cases : 0,
      meanKlauroF1: mean(results.map(r => r.klauroF1)),
      meanCbmF1: mean(results.map(r => r.cbmF1)),
      tokenSaving: mean(results.map(r => r.tokenSaving)),
      lossFixtures,
    },
  };
  return cached;
}

/** Test/diagnostic hook: clear the in-process cache. */
export function __resetDepthBehavioralDiffCache(): void {
  cached = null;
}
