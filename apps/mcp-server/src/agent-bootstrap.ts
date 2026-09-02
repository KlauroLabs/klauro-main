import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import {
  evaluateAgentReadiness,
  getAgentStartContext,
  getAgentToolPlan,
  getAgentContext,
  type AgentTask,
} from './agent-adoption';

export async function getAgentBootstrap(cas: CASOutput, path: string, task: AgentTask = {}) {
  const normalizedTask: AgentTask = {
    task_type: task.task_type || 'orient',
    target: task.target,
    related_paths: task.related_paths,
    runtime_event: task.runtime_event,
    instructions: task.instructions,
    success_criteria: task.success_criteria,
    response_profile: task.response_profile || 'capsule-only',
  };
  const start = getAgentStartContext(cas, path, normalizedTask);
  const plan = getAgentToolPlan(cas, { path, task: normalizedTask });
  const context = await getAgentContext(cas, path, normalizedTask);
  const readiness = evaluateAgentReadiness(cas, path);

  return {
    path,
    generated_at: new Date().toISOString(),
    agent_context_ready: readiness.agent_context_ready,
    readiness,
    start_context: start,
    tool_plan: plan,
    agent_context: context,
    prompt: buildAgentBootstrapPrompt(cas, start, plan, context, readiness),
  };
}

export function buildAgentBootstrapPrompt(
  cas: CASOutput,
  start: ReturnType<typeof getAgentStartContext>,
  plan: ReturnType<typeof getAgentToolPlan>,
  context: Awaited<ReturnType<typeof getAgentContext>>,
  readiness: ReturnType<typeof evaluateAgentReadiness>
): string {
  const sections: string[] = [];
  const startContext = start as any;
  const scale = startContext.scale || (readiness as any).summary || {};
  const scaleNodes = scale.nodes ?? cas.nodes?.length ?? 0;
  const scaleEdges = scale.edges ?? cas.edges?.length ?? 0;
  const scaleEntryPoints = scale.entry_points ?? cas.entry_points?.length ?? 0;
  const scaleErrors = scale.analysis_errors ?? scale.errors ??
    (cas.analysis_errors || []).filter(error => error.severity === 'error').length;
  const scaleWarnings = scale.analysis_warnings ?? scale.warnings ??
    (cas.analysis_errors || []).filter(error => error.severity === 'warning').length;
  const answerPackGaps = Array.isArray(startContext.answer_pack?.gaps)
    ? startContext.answer_pack.gaps
    : [];
  const whenToReadFiles = Array.isArray(startContext.when_to_read_files)
    ? startContext.when_to_read_files
    : [];

  sections.push(`# Agent Bootstrap: ${cas.system.name}`);
  sections.push(`Agent context ready: ${readiness.agent_context_ready ? 'yes' : 'no'}`);
  sections.push(`Readiness: ${readiness.status.toUpperCase()} (${readiness.score}/100)`);
  sections.push(`Analysis profile: ${readiness.profile.kind} (${Math.round(readiness.profile.confidence * 100)}% confidence)`);
  if (readiness.adoption_gaps.length > 0) sections.push(`Gaps: ${readiness.adoption_gaps.join('; ')}`);

  sections.push('');
  sections.push('## Operating Rule');
  sections.push(startContext.default_rule || startContext.rule || 'Use CAS-backed context before broad source exploration.');
  sections.push(plan.rule);
  sections.push('For edit/debug/review work, prefer `get_agent_context` with `task.response_profile="capsule-only"`, read `K15`, and execute `K5` before broad file reads. Use `first-turn` only when capsule-only leaves a concrete gap.');
  sections.push('Understand at every level, not just files: this codebase is Capability -> Flow -> Step -> Function. `get_summary` names the capabilities; `get_flow_concepts` breaks one into named flows as ordered steps (Validate -> Charge -> Persist -> Notify); `get_coding_context`/`get_call_chain` drill a step into its concrete function(s) — 1:1, 1:many, or a sub-section. Orient wide, narrow through flows/steps, then edit.');
  sections.push('Every unit (flow, step, function/node) carries the SAME uniform 6-facet understanding contract, all evidence-gated (never fabricated, absent facets omitted): input, output, logic, system-effects (state_changes vs external_integrations), constraints (first-class {kind, rule, evidence} — validation | auth | rate-limit | error | invariant | business-rule | consistency, where a consistency constraint means "reads here may be eventually consistent / stale"), and telemetry (real request_count/error_rate/p50-p95-p99 when observations exist). `get_flow_concepts` returns it per flow AND per step; `get_coding_context` returns it (incl. telemetry) for one node. Read the constraints/telemetry facets for "what must hold here" / "how it actually runs" instead of re-deriving from raw source.');
  sections.push('Coordinate at the concept level, and default to parallel: in a multi-agent workspace, splitting work across agents and running it concurrently through the fabric is the normal mode here, not a fallback for conflicts. Announce scope via `claim_work`/`check_collision` in flow/step/capability terms ("I own the Persist step of the Checkout flow"), not files/lines. The fabric is always-on ambient awareness, not a lock — disjoint work runs free, and even same-flow-different-step work is safe. You do not need to fear many agents on this codebase at once.');
  sections.push('Beyond the static graph, you can also ask how the system RUNS, TALKS, and SHIPS: `get_runtime_observations` (per-node traffic/error_rate/p50-p95-p99) + `get_operational_priorities` for debug/perf/incident work; `get_communication_seams` for how components talk — every seam classified sync/async/passive, including shared-state passive coupling no call-graph shows, with passive seams tagged strong/eventual + staleness_risk + cap_lean (a read-replica/CDC/materialized seam is eventually consistent — a real correctness constraint); `get_product_map` `runtime_topology` for infra/hosting (deployable -> exposes/routes/depends_on, reverse-proxy routes, IaC, CI/CD pipeline/job/step/deploy facts, and the public-URL -> proxy -> service -> route -> handler chain). A deployable can bundle members (bundled_into) — treat a bundled member as part of its host, not a separate system.');

  sections.push('');
  sections.push('## System');
  sections.push(`Type: ${start.system.type || 'unknown'}`);
  sections.push(`Description: ${start.system.description || 'unknown'}`);
  sections.push(`Languages: ${start.system.languages.join(', ') || 'unknown'}`);
  sections.push(`Frameworks: ${start.system.frameworks.join(', ') || 'unknown'}`);
  sections.push(`Top capabilities: ${start.system.top_capabilities.slice(0, 8).join(', ') || 'none detected'}`);

  sections.push('');
  sections.push('## Scale');
  sections.push(`Nodes: ${scaleNodes}, Edges: ${scaleEdges}, Entry points: ${scaleEntryPoints}, Analysis errors: ${scaleErrors}, warnings: ${scaleWarnings}`);

  if (answerPackGaps.length > 0) {
    sections.push('');
    sections.push('## Answer Pack Gaps');
    for (const gap of answerPackGaps) sections.push(`- ${gap}`);
  }

  sections.push('');
  sections.push('## MCP Plan');
  for (const stepValue of plan.steps) {
    const required = stepValue.required ? 'required' : 'optional';
    sections.push(`${stepValue.order}. ${stepValue.tool} (${required}) - ${stepValue.purpose}`);
    sections.push(`   args: ${JSON.stringify(stepValue.args)}`);
  }

  if ((context as any).context_capsule) {
    sections.push('');
    sections.push('## K15 Context Capsule');
    sections.push('```text');
    sections.push(typeof (context as any).context_capsule === 'string'
      ? (context as any).context_capsule
      : (context as any).context_capsule.capsule);
    sections.push('```');
  }

  if ((context as any).capsule || (context as any).execution_capsule) {
    sections.push('');
    sections.push('## K5 Execution Capsule');
    sections.push('```text');
    sections.push((context as any).capsule || (context as any).execution_capsule);
    sections.push('```');
  }

  if ((context as any).selected_node || (context as any).selected) {
    const selected = (context as any).selected_node || (context as any).selected;
    sections.push('');
    sections.push('## Selected Target');
    sections.push(`${selected.name || selected.id || 'unknown'} (${selected.type || 'unknown'})`);
    if (selected.file) sections.push(`File: ${selected.file}:${selected.line || 1}`);
  }

  const filePlan = Array.isArray((context as any).file_read_plan)
    ? (context as any).file_read_plan
    : Array.isArray((context as any).files)
      ? (context as any).files
      : [];
  if (filePlan.length > 0) {
    sections.push('');
    sections.push('## File Read Plan');
    for (const item of filePlan) {
      if (typeof item === 'string') {
        sections.push(`- ${item}`);
      } else {
        sections.push(`- ${item.file || item.path}${item.line ? `:${item.line}` : ''} - ${item.reason || item.role || 'read first'}`);
      }
    }
  }

  const invariantImpact = (context as any).invariant_impact;
  if (invariantImpact?.impacted_count > 0) {
    sections.push('');
    sections.push('## Invariant Impact');
    sections.push(`Status: ${invariantImpact.status}, impacted invariants: ${invariantImpact.impacted_count}`);
    for (const invariant of invariantImpact.impacted_invariants.slice(0, 8)) {
      sections.push(`- ${invariant.status.toUpperCase()} ${invariant.name} (${invariant.invariant_type})`);
    }
  }

  if (whenToReadFiles.length > 0) {
    sections.push('');
    sections.push('## When To Read Files');
    for (const rule of whenToReadFiles) sections.push(`- ${rule}`);
  }

  return sections.join('\n');
}
