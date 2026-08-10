/**
 * Unified Gauntlet — report schema + scenario/arm/metric catalogs.
 *
 * This is the spine the whole gauntlet hangs off. Every scenario, every arm,
 * every metric, and the win-validator all speak this one contract, and the UI
 * renders nothing but this.
 *
 * The shape is a matrix:
 *
 *     SCENARIOS  (what an agent is asked to do, on real repos / workspaces)
 *        x
 *     ARMS       (how the agent retrieves context: no-tools, Klauro, or another indexer)
 *        x
 *     METRICS    (measured per arm: time, tokens, quality)
 *
 * The point of the whole exercise is the win-validator (win-validator.ts): for
 * every scenario, Klauro must win on quality AND on at least one of speed/tokens
 * against every other arm. Any scenario where it doesn't is a Klauro bug, surfaced
 * loudly — the same posture as the dogfood + agent-feedback loops.
 */

// ---------------------------------------------------------------------------
// Arms — how the agent gets its context.
// ---------------------------------------------------------------------------

export type ArmKind = 'no-tools' | 'klauro' | 'other-indexer';

export interface ArmSpec {
  /** Stable id used as a key everywhere (report, UI, validator). */
  id: string;
  /** Human label for the UI. */
  label: string;
  kind: ArmKind;
  /**
   * Short description of the retrieval method this arm models — what the agent
   * is allowed to use to find and understand code.
   */
  method: string;
  /**
   * The competing tool/approach this arm represents, for "other-indexer" arms
   * (ctags, embeddings/RAG, LSP, Cursor-style index, …). Undefined for the two
   * canonical arms.
   */
  competitor?: string;
  /** The arm we are proving Klauro beats. Exactly one arm has kind 'klauro'. */
  isKlauro: boolean;
}

/**
 * The arm catalog. `no-tools` is the floor (grep/Read only). `klauro` is us.
 * The rest are the "other indexing tools/methods" the user requires us to also
 * beat. They are real, distinct retrieval strategies — not all are wired to a
 * live backend yet (see runner), but the matrix, validator, and UI treat them
 * uniformly so adding a live backend is a drop-in.
 */
export const ARMS: ArmSpec[] = [
  {
    id: 'no-tools',
    label: 'No tools (grep + read)',
    kind: 'no-tools',
    method: 'Agent has only ripgrep and file reads — the universal baseline every coding agent starts from.',
    isKlauro: false,
  },
  {
    id: 'klauro',
    label: 'Klauro (Unravl MCP)',
    kind: 'klauro',
    method: 'Agent queries the precomputed CAS analysis (workspace level and repo level) via the Unravl MCP tools before reading any file.',
    isKlauro: true,
  },
  {
    id: 'ctags',
    label: 'ctags / symbol index',
    kind: 'other-indexer',
    method: 'Agent has a universal-ctags symbol index (jump-to-definition, symbol list) plus grep/read.',
    competitor: 'universal-ctags',
    isKlauro: false,
  },
  {
    id: 'embeddings-rag',
    label: 'Embeddings RAG',
    kind: 'other-indexer',
    method: 'Agent retrieves top-k semantically similar chunks from a vector index of the repo, then reads them.',
    competitor: 'vector-rag',
    isKlauro: false,
  },
  {
    id: 'cursor-proxy',
    label: 'Cursor-style index',
    kind: 'other-indexer',
    method: 'Agent uses a Cursor-style codebase index retrieval proxy (the competitor-baseline arm).',
    competitor: 'cursor-style-index-context-proxy',
    isKlauro: false,
  },
];

export const KLAURO_ARM_ID = 'klauro';

// ---------------------------------------------------------------------------
// Scenarios — what the agent is asked to do.
// ---------------------------------------------------------------------------

export type ScenarioGroup =
  | 'single-repo'
  | 'workspace'
  | 'cross-repo'
  | 'incremental'
  | 'analysis';

export type ScenarioExecution =
  /** Runs real agents per arm and measures actual time/tokens/quality. */
  | 'live'
  /** Derives metrics from an existing benchmark report (replayed, honest, fast). */
  | 'projected'
  /** Measured directly from the analysis engine (no agent needed), e.g. readiness. */
  | 'engine'
  /** Measured by driving the INSTALLED CLI against the hosted product (the VPS),
   *  i.e. the real customer path rather than the in-process engine. */
  | 'product';

export interface ScenarioSpec {
  id: string;
  label: string;
  group: ScenarioGroup;
  /** One-line description of the agent task this scenario poses. */
  task: string;
  /**
   * Why Klauro should win this one — the mechanism, so a loss points at the
   * specific capability to fix.
   */
  klauroEdge: string;
  /** Which arms are meaningful for this scenario (defaults to all). */
  arms?: string[];
  /** How this scenario produces its numbers. */
  execution: ScenarioExecution;
  /**
   * For projected/live scenarios, the benchmark engine that backs it (npm
   * script or module) — recorded in the report for provenance.
   */
  backedBy?: string;
}

/**
 * The scenario catalog. Every item the user enumerated is here, plus the
 * objective analysis-readiness gate. Cross-repo + workspace scenarios are the
 * differentiated ground (the workspace-level CAS) where Klauro's lead should be largest.
 */
export const SCENARIOS: ScenarioSpec[] = [
  {
    id: 'cold-onboarding',
    label: 'Cold onboarding',
    group: 'single-repo',
    task: 'A fresh agent must accurately describe what a repo is, does, and how it is structured.',
    klauroEdge: 'get_summary + get_coding_context deliver the architecture in one call instead of dozens of reads.',
    execution: 'projected',
    backedBy: 'analysis-output-cold-review',
  },
  {
    id: 'repo-change',
    label: 'Repo change / feature',
    group: 'single-repo',
    task: 'Implement a small feature/change in a single repo and pass its tests.',
    klauroEdge: 'get_coding_context + get_callers scope the blast radius so the edit lands in the right place first try.',
    execution: 'projected',
    backedBy: 'agent-quality-benchmark',
  },
  {
    id: 'repo-bug',
    label: 'Repo bug diagnosis',
    group: 'single-repo',
    task: 'Locate and diagnose the root cause of a bug in a single repo.',
    klauroEdge: 'get_call_chain + get_callees trace the failing path without re-reading the tree.',
    execution: 'projected',
    backedBy: 'agent-quality-benchmark',
  },
  {
    id: 'workspace-orientation',
    label: 'Workspace orientation',
    group: 'workspace',
    task: 'Describe a multi-repo workspace: what each repo is for and how they fit together.',
    klauroEdge: 'get_workspace_summary composes per-repo CAS into one workspace-level CAS no grep can assemble.',
    arms: ['no-tools', 'klauro', 'embeddings-rag'],
    execution: 'projected',
    backedBy: 'workspace-agent-benchmark',
  },
  {
    id: 'cross-repo-change',
    label: 'Cross-repo change',
    group: 'cross-repo',
    task: 'Make a change that spans repos (e.g. a contract change in an API and its consumers).',
    klauroEdge: 'get_cross_repo_contracts + get_cross_repo_links expose every touchpoint across repos in one query.',
    arms: ['no-tools', 'klauro', 'cursor-proxy'],
    execution: 'projected',
    backedBy: 'workspace-agent-benchmark',
  },
  {
    id: 'cross-repo-bug',
    label: 'Cross-repo bug diagnosis',
    group: 'cross-repo',
    task: 'Trace a bug whose cause and symptom live in different repos.',
    klauroEdge: 'Cross-repo call/data lineage links the symptom repo to the cause repo deterministically.',
    arms: ['no-tools', 'klauro', 'cursor-proxy'],
    execution: 'projected',
    backedBy: 'workspace-agent-benchmark',
  },
  {
    id: 'cross-repo-analysis',
    label: 'Cross-repo analysis',
    group: 'cross-repo',
    task: 'Answer an architectural question about how N repos compose into one product.',
    klauroEdge: 'The workspace-level CAS graph + capability map answer product-level questions a per-file index cannot.',
    arms: ['no-tools', 'klauro', 'embeddings-rag'],
    execution: 'projected',
    backedBy: 'cross-codebase-gauntlet',
  },
  {
    id: 'incremental-change',
    label: 'Incremental change analysis',
    group: 'incremental',
    task: 'After a diff, identify what changed and its ripple (callers/callees/contracts affected).',
    klauroEdge: 'get_changes_for_node + assess_change_risk give the ripple directly from incremental analysis.',
    arms: ['no-tools', 'klauro'],
    execution: 'projected',
    backedBy: 'incremental-benchmark',
  },
  {
    id: 'security-audit',
    label: 'Security audit',
    group: 'single-repo',
    task: 'Find the security-sensitive surfaces (authn/authz, input sinks, secrets) in a repo.',
    klauroEdge: 'get_security_overview + get_route_table surface every auth boundary and sink without a full read.',
    execution: 'projected',
    backedBy: 'agent-quality-benchmark',
  },
  {
    id: 'test-authoring',
    label: 'Test authoring',
    group: 'single-repo',
    task: 'Write meaningful tests for an under-tested module.',
    klauroEdge: 'find_tests + get_test_summary + get_usage_examples show what exists and what the unit does.',
    execution: 'projected',
    backedBy: 'agent-quality-benchmark',
  },
  {
    id: 'refactor-safety',
    label: 'Refactor safety',
    group: 'single-repo',
    task: 'Refactor a core function safely, knowing everything it touches.',
    klauroEdge: 'get_callers + assess_change_risk give the full blast radius before the edit.',
    execution: 'projected',
    backedBy: 'agent-quality-benchmark',
  },
  {
    id: 'dependency-impact',
    label: 'Dependency impact',
    group: 'incremental',
    task: 'Assess what a change to a shared entity/dependency ripples into.',
    klauroEdge: 'get_data_lineage + get_changes_for_node trace the ripple deterministically.',
    arms: ['no-tools', 'klauro'],
    execution: 'projected',
    backedBy: 'incremental-benchmark',
  },
  {
    id: 'api-contract-drift',
    label: 'API contract drift',
    group: 'cross-repo',
    task: 'Detect where an API contract and its consumers have drifted apart.',
    klauroEdge: 'get_cross_repo_contracts pinpoints every producer/consumer mismatch across repos.',
    arms: ['no-tools', 'klauro', 'cursor-proxy'],
    execution: 'projected',
    backedBy: 'workspace-agent-benchmark',
  },
  {
    id: 'onboarding-depth',
    label: 'Onboarding depth (deep Q&A)',
    group: 'single-repo',
    task: 'Answer deep "how does X work end-to-end" questions about a repo, with evidence.',
    klauroEdge: 'get_call_chain + get_flow_graph + get_data_entities answer end-to-end with cited evidence.',
    execution: 'projected',
    backedBy: 'agent-quality-benchmark',
  },
  {
    id: 'analysis-readiness',
    label: 'Analysis readiness (objective)',
    group: 'analysis',
    task: 'Does the produced analysis meet the objective quality gates for every repo?',
    klauroEdge: 'Pure engine measurement — graph quality, answerability, evidence, tests, safety.',
    arms: ['klauro'],
    execution: 'engine',
    backedBy: 'gauntlet',
  },
];

// ---------------------------------------------------------------------------
// Metrics — measured per arm.
// ---------------------------------------------------------------------------

export interface ArmMetrics {
  /** Wall-clock to complete the task, ms. Lower is better. */
  time_ms?: number;
  /** Total provider tokens consumed. Lower is better. */
  tokens?: number;
  /** Which token figure tokens came from, for honesty in the UI. */
  token_source?: 'provider-total' | 'provider-direct' | 'estimated-work';
  /** LLM-judged quality of the result, 0..100. Higher is better. */
  quality?: number;
  /** Did the agent's change pass the repo's tests / validation? */
  validation_passed?: boolean;
  /** Did the agent's command exit cleanly? */
  command_passed?: boolean;
  /** Task completion score 0..100 (separate from quality of the result). */
  completion?: number;
  /** Files the agent touched (precision signal). */
  files_changed?: number;
  /** Files the agent had to read to get there (effort signal). */
  files_read?: number;
}

export interface ArmResult {
  arm_id: string;
  /** live (real agent run), projected (replayed from a benchmark), engine (measured). */
  mode: ScenarioExecution;
  /** True if this arm was actually executed vs. carried as not-applicable. */
  attempted: boolean;
  metrics: ArmMetrics;
  /** Provenance: which report/run produced these numbers. */
  source?: string;
  /** Free-form note (e.g. why an arm was skipped). */
  note?: string;
}

// ---------------------------------------------------------------------------
// Win verdict — the heart. Produced by win-validator.ts.
// ---------------------------------------------------------------------------

export type MetricKey = 'quality' | 'time' | 'tokens';

export interface MetricComparison {
  metric: MetricKey;
  klauro_value?: number;
  /** Best (most favorable) value among non-Klauro arms. */
  best_other_value?: number;
  best_other_arm_id?: string;
  /** Did Klauro win this metric against every other arm? */
  klauro_wins: boolean;
  /**
   * Quality only: Klauro did not win outright but matched the best competitor at
   * the achievable ceiling (e.g. both F1 = 1.0 against a compiler-accurate tool).
   * A ceiling tie is an acceptable quality outcome — you cannot out-correct ground
   * truth — provided Klauro then wins on efficiency. Never set below the ceiling.
   */
  tied_at_ceiling?: boolean;
  /** Relative advantage, signed fraction (e.g. +0.42 = 42% better). */
  advantage?: number;
}

export interface WinVerdict {
  /**
   * The contract: Klauro wins quality against EVERY other arm AND beats every
   * other arm on at least one efficiency metric (time or tokens).
   */
  klauro_wins: boolean;
  /** quality won outright. */
  quality_won: boolean;
  /**
   * Quality matched the best competitor at the ceiling (both perfect) rather than
   * winning outright. Counts as an acceptable quality result when paired with an
   * efficiency win — Klauro never *loses* quality, and the decisive edge is then
   * tokens/speed (plus the Camp-C axes competitors cannot answer at all).
   */
  quality_tied_at_ceiling?: boolean;
  /** at least one of time/tokens won. */
  efficiency_won: boolean;
  comparisons: MetricComparison[];
  /** Human-readable reasons (pass) or violations (fail). */
  reasons: string[];
  /** Set when klauro_wins is false — this is a bug to fix, with a pointer. */
  violation?: {
    summary: string;
    losing_metrics: MetricKey[];
    /** The scenario's klauroEdge — the capability that failed to deliver. */
    suspected_capability: string;
  };
}

// ---------------------------------------------------------------------------
// Scenario + top-level report.
// ---------------------------------------------------------------------------

export type GauntletStatus = 'pending' | 'running' | 'done' | 'error';

export interface ScenarioResult {
  scenario_id: string;
  label: string;
  group: ScenarioGroup;
  status: GauntletStatus;
  execution: ScenarioExecution;
  /** Repo/workspace this scenario ran against (when applicable). */
  target?: string;
  arms: ArmResult[];
  verdict?: WinVerdict;
  started_at?: string;
  finished_at?: string;
  error?: string;
}

export interface GauntletProgress {
  total_scenarios: number;
  completed: number;
  running: number;
  pending: number;
  errored: number;
}

export interface GauntletSummary {
  /** Overall pass: every completed scenario's verdict.klauro_wins is true. */
  klauro_wins_all: boolean;
  scenarios_won: number;
  scenarios_lost: number;
  /** Scenarios where Klauro lost — the work list. */
  losses: Array<{ scenario_id: string; summary: string; losing_metrics: MetricKey[] }>;
  /** Averaged advantages across won scenarios, for the headline. */
  avg_quality_advantage?: number;
  avg_time_advantage?: number;
  avg_token_advantage?: number;
}

export interface GauntletReport {
  schema_version: 1;
  run_id: string;
  generated_at: string;
  /** live = real agent runs; projected = replayed; mixed = both. */
  mode: 'live' | 'projected' | 'mixed';
  status: GauntletStatus;
  progress: GauntletProgress;
  arms: ArmSpec[];
  scenarios: ScenarioResult[];
  summary: GauntletSummary;
}

export function scenarioById(id: string): ScenarioSpec | undefined {
  return SCENARIOS.find(s => s.id === id);
}

export function armsForScenario(spec: ScenarioSpec): ArmSpec[] {
  if (!spec.arms) return ARMS;
  const set = new Set(spec.arms);
  return ARMS.filter(a => set.has(a.id));
}
