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

  sections.push(`# Agent Bootstrap: ${cas.system.name}`);
  sections.push(`Agent context ready: ${readiness.agent_context_ready ? 'yes' : 'no'}`);
  sections.push(`Readiness: ${readiness.status.toUpperCase()} (${readiness.score}/100)`);
  sections.push(`Analysis profile: ${readiness.profile.kind} (${Math.round(readiness.profile.confidence * 100)}% confidence)`);
  if (readiness.adoption_gaps.length > 0) sections.push(`Gaps: ${readiness.adoption_gaps.join('; ')}`);

  sections.push('');
  sections.push('## Operating Rule');
  sections.push(start.default_rule);
  sections.push(plan.rule);
  sections.push('For edit/debug/review work, prefer `get_agent_context` with `task.response_profile="capsule-only"`, read `K15`, and execute `K5` before broad file reads. Use `first-turn` only when capsule-only leaves a concrete gap.');
  sections.push('Understand at every level, not just files: this codebase is Capability -> Flow -> Step -> Function. `get_summary` names the capabilities; `get_flow_concepts` breaks one into named flows as ordered steps (Validate -> Charge -> Persist -> Notify), each with Input/Logic/Side-effects(state_changes vs external_integrations)/Output/Constraints; `get_coding_context`/`get_call_chain` drill a step into its concrete function(s) — 1:1, 1:many, or a sub-section. Orient wide, narrow through flows/steps, then edit.');
  sections.push('Coordinate at the concept level, and default to parallel: in a multi-agent workspace, splitting work across agents and running it concurrently through the fabric is the normal mode here, not a fallback for conflicts. Announce scope via `claim_work`/`check_collision` in flow/step/capability terms ("I own the Persist step of the Checkout flow"), not files/lines. The fabric is always-on ambient awareness, not a lock — disjoint work runs free, and even same-flow-different-step work is safe. You do not need to fear many agents on this codebase at once.');

  sections.push('');
  sections.push('## System');
  sections.push(`Type: ${start.system.type || 'unknown'}`);
  sections.push(`Description: ${start.system.description || 'unknown'}`);
  sections.push(`Languages: ${start.system.languages.join(', ') || 'unknown'}`);
  sections.push(`Frameworks: ${start.system.frameworks.join(', ') || 'unknown'}`);
  sections.push(`Top capabilities: ${start.system.top_capabilities.slice(0, 8).join(', ') || 'none detected'}`);

  sections.push('');
  sections.push('## Scale');
  sections.push(`Nodes: ${start.scale.nodes}, Edges: ${start.scale.edges}, Entry points: ${start.scale.entry_points}, Analysis errors: ${start.scale.analysis_errors}`);

  if (start.answer_pack.gaps.length > 0) {
    sections.push('');
    sections.push('## Answer Pack Gaps');
    for (const gap of start.answer_pack.gaps) sections.push(`- ${gap}`);
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

  sections.push('');
  sections.push('## When To Read Files');
  for (const rule of start.when_to_read_files) sections.push(`- ${rule}`);

  return sections.join('\n');
}
