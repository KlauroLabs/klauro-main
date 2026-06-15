import { isLocalAIProvider } from '../../../packages/analyzer-core/src/config/ai.config';

export type AnalysisFocus = 'agent-fast' | 'ui-overview' | 'deep-context' | 'full';
export type AnalysisTrigger = 'mcp' | 'cli' | 'ui' | 'inspector' | 'manual-description' | 'runtime' | 'unknown';

export interface AnalysisFocusProfile {
  focus: AnalysisFocus;
  default_for: AnalysisTrigger[];
  token_policy: 'minimize-first-turn' | 'spend-on-human-narrative' | 'spend-on-semantic-depth' | 'environment-default';
  cost_tier: 'lowest' | 'moderate' | 'higher' | 'variable';
  produces: string[];
  defers: string[];
  recommended_layers: string[];
  next_tool: 'analyze_codebase' | 'run_analysis_layer';
  agent_guidance: string;
}

export interface AnalysisFocusRecommendation {
  trigger: AnalysisTrigger;
  task_type?: string;
  recommended_focus: AnalysisFocus;
  recommended_layer: 'agent-fast-refresh' | 'ui-overview-refresh' | 'deep-context-refresh' | null;
  reason: string;
  token_policy: AnalysisFocusProfile['token_policy'];
  deferred_until_needed: string[];
}

interface AnalysisFocusOptions {
  elementDescriptionLimit?: string;
  interpretationBudgetMs?: string;
  elementDescriptionBudgetMs?: string;
}

const FOCUS_ENV_KEYS = [
  'KLAURO_ANALYSIS_FOCUS',
  'KLAURO_AI_INTERPRETATION',
  'KLAURO_AI_INTERPRETATION_FORCE',
  'KLAURO_AI_INTERPRETATION_ALLOW_DETERMINISTIC_KEEP',
  'KLAURO_AI_INTERPRETATION_BUDGET_MS',
  'KLAURO_AI_ELEMENT_DESCRIPTION_BUDGET_MS',
  'KLAURO_AI_ELEMENT_DESCRIPTION_BATCH_SIZE',
  'KLAURO_AI_ELEMENT_DESCRIPTION_LIMIT',
  'KLAURO_AI_ELEMENT_DESCRIPTIONS',
  'KLAURO_EMBEDDING_ENABLED',
  'KLAURO_AGENT_FAST_EXCLUDE_LEGACY',
  'KLAURO_OLLAMA_AUTO',
  'OLLAMA_BASE_URL',
  'OLLAMA_MODEL',
] as const;

type FocusEnvKey = typeof FOCUS_ENV_KEYS[number];

const FOCUS_PROFILES: AnalysisFocusProfile[] = [
  {
    focus: 'agent-fast',
    default_for: ['mcp', 'cli'],
    token_policy: 'minimize-first-turn',
    cost_tier: 'lowest',
    produces: [
      'CAS graph',
      'entry and exit points',
      'risks',
      'idioms',
      'tests',
      'K15/K5 capsule-only work packets',
      'freshness and incremental state',
    ],
    defers: [
      'AI-written system narrative',
      'AI element descriptions',
      'embedding-heavy semantic layers',
      'visual polish enrichment',
    ],
    recommended_layers: ['agent-fast-refresh'],
    next_tool: 'analyze_codebase',
    agent_guidance: 'Use this before coding, debugging, review, trace, or any capsule-only/first-turn MCP context. Expand only when the packet reports a gap.',
  },
  {
    focus: 'ui-overview',
    default_for: ['ui', 'inspector', 'manual-description'],
    token_policy: 'spend-on-human-narrative',
    cost_tier: 'moderate',
    produces: [
      'AI-written system narrative',
      'AI capability descriptions',
      'manual element descriptions',
      'visualization-friendly summaries',
    ],
    defers: [
      'embedding-heavy semantic layers',
      'deep audit-only context',
    ],
    recommended_layers: ['ui-overview-refresh', 'manual-element-description'],
    next_tool: 'run_analysis_layer',
    agent_guidance: 'Use this when a human is inspecting the UI, asking for better descriptions, or drilling into one element. Do not use it as the default coding path.',
  },
  {
    focus: 'deep-context',
    default_for: ['runtime'],
    token_policy: 'spend-on-semantic-depth',
    cost_tier: 'higher',
    produces: [
      'embedding-backed semantic retrieval where configured',
      'AI system narrative when a provider is available',
      'runtime correlation readiness',
      'audit-grade relationship context',
    ],
    defers: [
      'bulk AI element descriptions unless manually requested',
    ],
    recommended_layers: ['deep-context-refresh', 'runtime-simulation'],
    next_tool: 'run_analysis_layer',
    agent_guidance: 'Use after the fast graph is good and the task needs audit, runtime, cross-boundary, or deeper semantic evidence.',
  },
  {
    focus: 'full',
    default_for: ['unknown'],
    token_policy: 'environment-default',
    cost_tier: 'variable',
    produces: [
      'whatever repository and environment defaults enable',
    ],
    defers: [
      'nothing explicitly; behavior depends on environment variables and provider availability',
    ],
    recommended_layers: [],
    next_tool: 'analyze_codebase',
    agent_guidance: 'Use only when you explicitly want environment defaults. For agent token discipline, prefer agent-fast.',
  },
];

export function getAnalysisFocusProfiles(input: {
  trigger?: AnalysisTrigger | string;
  taskType?: string;
} = {}): {
  recommendation: AnalysisFocusRecommendation;
  profiles: AnalysisFocusProfile[];
} {
  const trigger = normalizeTrigger(input.trigger);
  return {
    recommendation: recommendAnalysisFocus({ trigger, taskType: input.taskType }),
    profiles: FOCUS_PROFILES,
  };
}

export function recommendAnalysisFocus(input: {
  trigger?: AnalysisTrigger | string;
  taskType?: string;
} = {}): AnalysisFocusRecommendation {
  const trigger = normalizeTrigger(input.trigger);
  const taskType = input.taskType?.toLowerCase();
  const deepTask = taskType && /runtime|cross-repo|audit|architecture|trace/.test(taskType);
  const uiTask = taskType && /describe|description|visual|overview|ui|inspect/.test(taskType);

  if (trigger === 'ui' || trigger === 'inspector' || trigger === 'manual-description' || uiTask) {
    const profile = profileFor('ui-overview');
    return {
      trigger,
      task_type: input.taskType,
      recommended_focus: 'ui-overview',
      recommended_layer: trigger === 'manual-description' ? 'ui-overview-refresh' : 'ui-overview-refresh',
      reason: 'Human-facing inspection needs AI narrative and visualization-friendly descriptions; keep it out of the default coding path.',
      token_policy: profile.token_policy,
      deferred_until_needed: profile.defers,
    };
  }

  if (trigger === 'runtime' || deepTask) {
    const profile = profileFor('deep-context');
    return {
      trigger,
      task_type: input.taskType,
      recommended_focus: 'deep-context',
      recommended_layer: 'deep-context-refresh',
      reason: 'This task needs deeper semantic/runtime/cross-boundary context after the fast graph is available.',
      token_policy: profile.token_policy,
      deferred_until_needed: profile.defers,
    };
  }

  const profile = profileFor('agent-fast');
  return {
    trigger,
    task_type: input.taskType,
    recommended_focus: 'agent-fast',
    recommended_layer: 'agent-fast-refresh',
    reason: 'Agent coding and capsule-only MCP context should minimize prompt and analysis cost while preserving graph, idioms, risks, tests, and K15/K5 work packets.',
    token_policy: profile.token_policy,
    deferred_until_needed: profile.defers,
  };
}

function profileFor(focus: AnalysisFocus): AnalysisFocusProfile {
  return FOCUS_PROFILES.find(profile => profile.focus === focus)!;
}

function normalizeTrigger(trigger?: AnalysisTrigger | string): AnalysisTrigger {
  if (
    trigger === 'mcp' ||
    trigger === 'cli' ||
    trigger === 'ui' ||
    trigger === 'inspector' ||
    trigger === 'manual-description' ||
    trigger === 'runtime'
  ) {
    return trigger;
  }
  return 'unknown';
}

export async function withAnalysisFocus<T>(
  focus: AnalysisFocus | undefined,
  fn: () => Promise<T>,
  options: AnalysisFocusOptions = {},
): Promise<T> {
  const previous = captureFocusEnv();

  try {
    applyAnalysisFocus(focus, options);
    return await fn();
  } finally {
    restoreFocusEnv(previous);
  }
}

export function applyAnalysisFocus(
  focus: AnalysisFocus | undefined,
  options: AnalysisFocusOptions = {},
): void {
  if (focus === 'agent-fast') {
    process.env.KLAURO_ANALYSIS_FOCUS = 'agent-fast';
    process.env.KLAURO_AI_INTERPRETATION = 'false';
    process.env.KLAURO_AI_INTERPRETATION_FORCE = 'false';
    process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS = 'false';
    process.env.KLAURO_EMBEDDING_ENABLED = 'false';
    process.env.KLAURO_AGENT_FAST_EXCLUDE_LEGACY = 'true';
    return;
  }

  if (focus === 'ui-overview') {
    process.env.KLAURO_ANALYSIS_FOCUS = 'ui-overview';
    applyLocalOllamaDefaults();
    const localProvider = isLocalAIProvider();
    process.env.KLAURO_AI_INTERPRETATION = process.env.KLAURO_AI_INTERPRETATION || 'true';
    process.env.KLAURO_AI_INTERPRETATION_FORCE = process.env.KLAURO_AI_INTERPRETATION_FORCE || 'true';
    process.env.KLAURO_AI_INTERPRETATION_ALLOW_DETERMINISTIC_KEEP = 'false';
    process.env.KLAURO_AI_INTERPRETATION_BUDGET_MS = process.env.KLAURO_AI_INTERPRETATION_BUDGET_MS ||
      options.interpretationBudgetMs ||
      (localProvider ? '240000' : '45000');
    process.env.KLAURO_AI_ELEMENT_DESCRIPTION_BUDGET_MS = process.env.KLAURO_AI_ELEMENT_DESCRIPTION_BUDGET_MS ||
      options.elementDescriptionBudgetMs ||
      (localProvider ? '240000' : '90000');
    process.env.KLAURO_AI_ELEMENT_DESCRIPTION_BATCH_SIZE = process.env.KLAURO_AI_ELEMENT_DESCRIPTION_BATCH_SIZE || '4';
    process.env.KLAURO_AI_ELEMENT_DESCRIPTION_LIMIT = process.env.KLAURO_AI_ELEMENT_DESCRIPTION_LIMIT ||
      options.elementDescriptionLimit ||
      '8';
    process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS = process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS || 'true';
    process.env.KLAURO_EMBEDDING_ENABLED = 'false';
    return;
  }

  if (focus === 'deep-context') {
    process.env.KLAURO_ANALYSIS_FOCUS = 'deep-context';
    applyLocalOllamaDefaults();
    const localProvider = isLocalAIProvider();
    process.env.KLAURO_AI_INTERPRETATION = process.env.KLAURO_AI_INTERPRETATION || 'true';
    process.env.KLAURO_AI_INTERPRETATION_FORCE = process.env.KLAURO_AI_INTERPRETATION_FORCE || 'false';
    process.env.KLAURO_AI_INTERPRETATION_ALLOW_DETERMINISTIC_KEEP = process.env.KLAURO_AI_INTERPRETATION_ALLOW_DETERMINISTIC_KEEP || 'false';
    process.env.KLAURO_AI_INTERPRETATION_BUDGET_MS = process.env.KLAURO_AI_INTERPRETATION_BUDGET_MS ||
      options.interpretationBudgetMs ||
      (localProvider ? '240000' : '60000');
    process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS = process.env.KLAURO_AI_ELEMENT_DESCRIPTIONS || 'false';
    process.env.KLAURO_AI_ELEMENT_DESCRIPTION_LIMIT = process.env.KLAURO_AI_ELEMENT_DESCRIPTION_LIMIT ||
      options.elementDescriptionLimit ||
      '0';
    process.env.KLAURO_EMBEDDING_ENABLED = process.env.KLAURO_EMBEDDING_ENABLED || 'true';
    return;
  }

  if (focus === 'full') {
    process.env.KLAURO_ANALYSIS_FOCUS = 'full';
  }
}

function applyLocalOllamaDefaults(): void {
  if (process.env.KLAURO_OLLAMA_AUTO === 'false' || process.env.KLAURO_OLLAMA_AUTO === '0') {
    return;
  }
  process.env.KLAURO_OLLAMA_AUTO = process.env.KLAURO_OLLAMA_AUTO || 'true';
  process.env.OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
  process.env.OLLAMA_MODEL = process.env.OLLAMA_MODEL || process.env.KLAURO_LOCAL_AI_MODEL || 'qwen3:8b';
}

function captureFocusEnv(): Record<FocusEnvKey, string | undefined> {
  return Object.fromEntries(FOCUS_ENV_KEYS.map(key => [key, process.env[key]])) as Record<FocusEnvKey, string | undefined>;
}

function restoreFocusEnv(previous: Record<FocusEnvKey, string | undefined>): void {
  for (const key of FOCUS_ENV_KEYS) {
    const value = previous[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
