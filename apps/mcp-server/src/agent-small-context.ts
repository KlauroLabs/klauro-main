export function compactSmallRepoReadiness(readiness: any) {
  if (!readiness || typeof readiness !== 'object') return readiness || null;
  return {
    status: readiness.status,
    score: readiness.score,
    agent_context_ready: readiness.agent_context_ready,
    language_coverage_note: readiness.language_coverage_note,
    gaps: Array.isArray(readiness.gaps) ? readiness.gaps.slice(0, 2) : readiness.gaps,
  };
}

export function compactSmallRepoTargetResolution(resolution: any) {
  if (!resolution || typeof resolution !== 'object') return resolution || null;
  return {
    query: resolution.query,
    selected_node_id: resolution.selected_node_id,
    candidate_count: Array.isArray(resolution.candidates) ? resolution.candidates.length : undefined,
    candidates_truncated: Array.isArray(resolution.candidates) ? resolution.candidates.length > 4 : undefined,
    candidates: Array.isArray(resolution.candidates) ? resolution.candidates.slice(0, 4) : resolution.candidates,
    gaps: Array.isArray(resolution.gaps) ? resolution.gaps.slice(0, 2) : resolution.gaps,
  };
}

export function compactSmallRepoExecutionBrief(brief: any) {
  if (!brief || typeof brief !== 'object') return brief || null;
  return {
    mode: brief.mode,
    read_first: Array.isArray(brief.read_first) ? brief.read_first.slice(0, 2) : brief.read_first,
    edit_scope: Array.isArray(brief.edit_scope) ? brief.edit_scope.slice(0, 2) : brief.edit_scope,
    validate: Array.isArray(brief.validate) ? brief.validate.slice(0, 2) : brief.validate,
    token_policy: brief.token_policy,
    stop_rule: brief.stop_rule,
    stop_condition: brief.stop_condition,
    capsule: brief.capsule,
  };
}

export function compactSmallRepoValidationPlan(plan: any) {
  if (!plan || typeof plan !== 'object') return plan || null;
  return {
    strategy: plan.strategy,
    commands: Array.isArray(plan.commands) ? plan.commands.slice(0, 2) : plan.commands,
    tests_to_inspect: Array.isArray(plan.tests_to_inspect) ? plan.tests_to_inspect.slice(0, 2) : plan.tests_to_inspect,
    manual_checks: compactManualChecks(plan.manual_checks),
    gaps: Array.isArray(plan.gaps) ? plan.gaps.slice(0, 1) : plan.gaps,
  };
}

function compactManualChecks(checks: any): string[] {
  if (!Array.isArray(checks)) return [];
  return [...new Set(checks.slice(0, 2).map(check => {
    const value = String(check || '');
    if (/validate_behavioral_invariants/i.test(value)) return 'Run validate_behavioral_invariants after edits.';
    if (/validate_codebase_idioms/i.test(value)) return 'Run validate_codebase_idioms after edits.';
    return value.replace(/\s+/g, ' ').replace(/ for [A-Za-z0-9_./:-]+\.?$/, '.');
  }))];
}
