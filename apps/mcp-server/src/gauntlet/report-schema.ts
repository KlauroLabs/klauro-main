
























export type ArmKind = 'no-tools' | 'klauro' | 'other-indexer';

export interface ArmSpec {

  id: string;

  label: string;
  kind: ArmKind;




  method: string;





  competitor?: string;

  isKlauro: boolean;
}








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





export type ScenarioGroup =
  | 'single-repo'
  | 'workspace'
  | 'cross-repo'
  | 'incremental'
  | 'analysis';

export type ScenarioExecution =

  | 'live'

  | 'projected'

  | 'engine'


  | 'product';

export interface ScenarioSpec {
  id: string;
  label: string;
  group: ScenarioGroup;

  task: string;




  klauroEdge: string;

  arms?: string[];

  execution: ScenarioExecution;




  backedBy?: string;
}






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





export interface ArmMetrics {

  time_ms?: number;

  tokens?: number;

  token_source?: 'provider-total' | 'provider-direct' | 'estimated-work';

  quality?: number;

  validation_passed?: boolean;

  command_passed?: boolean;

  completion?: number;

  files_changed?: number;

  files_read?: number;
}

export interface ArmResult {
  arm_id: string;

  mode: ScenarioExecution;

  attempted: boolean;
  metrics: ArmMetrics;

  source?: string;

  note?: string;
}





export type MetricKey = 'quality' | 'time' | 'tokens';

export interface MetricComparison {
  metric: MetricKey;
  klauro_value?: number;

  best_other_value?: number;
  best_other_arm_id?: string;

  klauro_wins: boolean;






  tied_at_ceiling?: boolean;

  advantage?: number;
}

export interface WinVerdict {




  klauro_wins: boolean;

  quality_won: boolean;






  quality_tied_at_ceiling?: boolean;

  efficiency_won: boolean;
  comparisons: MetricComparison[];

  reasons: string[];

  violation?: {
    summary: string;
    losing_metrics: MetricKey[];

    suspected_capability: string;
  };
}





export type GauntletStatus = 'pending' | 'running' | 'done' | 'error';

export interface ScenarioResult {
  scenario_id: string;
  label: string;
  group: ScenarioGroup;
  status: GauntletStatus;
  execution: ScenarioExecution;

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

  klauro_wins_all: boolean;
  scenarios_won: number;
  scenarios_lost: number;

  losses: Array<{ scenario_id: string; summary: string; losing_metrics: MetricKey[] }>;

  avg_quality_advantage?: number;
  avg_time_advantage?: number;
  avg_token_advantage?: number;
}

export interface GauntletReport {
  schema_version: 1;
  run_id: string;
  generated_at: string;

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
