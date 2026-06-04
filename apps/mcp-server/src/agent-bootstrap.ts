import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import {
  evaluateAgentReadiness,
  getAgentStartContext,
  getAgentToolPlan,
  getAgentWorkPacket,
  type AgentTask,
} from './agent-adoption';

export async function getAgentBootstrap(cas: CASOutput, path: string, task: AgentTask = {}) {
  const normalizedTask = { task_type: task.task_type || 'orient', target: task.target, related_paths: task.related_paths, runtime_event: task.runtime_event };
  const start = getAgentStartContext(cas, path, normalizedTask);
  const plan = getAgentToolPlan(cas, { path, task: normalizedTask });
  const packet = await getAgentWorkPacket(cas, path, normalizedTask);
  const readiness = evaluateAgentReadiness(cas, path);

  return {
    path,
    generated_at: new Date().toISOString(),
    default_use: readiness.default_use,
    readiness,
    start_context: start,
    tool_plan: plan,
    work_packet: packet,
    prompt: buildAgentBootstrapPrompt(cas, start, plan, packet, readiness),
  };
}

export function buildAgentBootstrapPrompt(
  cas: CASOutput,
  start: ReturnType<typeof getAgentStartContext>,
  plan: ReturnType<typeof getAgentToolPlan>,
  packet: Awaited<ReturnType<typeof getAgentWorkPacket>>,
  readiness: ReturnType<typeof evaluateAgentReadiness>
): string {
  const sections: string[] = [];

  sections.push(`# Agent Bootstrap: ${cas.system.name}`);
  sections.push(`Default use: ${readiness.default_use ? 'yes' : 'no'}`);
  sections.push(`Readiness: ${readiness.status.toUpperCase()} (${readiness.score}/100)`);
  sections.push(`Analysis profile: ${readiness.profile.kind} (${Math.round(readiness.profile.confidence * 100)}% confidence)`);
  if (readiness.adoption_gaps.length > 0) sections.push(`Gaps: ${readiness.adoption_gaps.join('; ')}`);

  sections.push('');
  sections.push('## Operating Rule');
  sections.push(start.default_rule);
  sections.push(plan.rule);

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

  if (packet.selected_node) {
    sections.push('');
    sections.push('## Selected Target');
    sections.push(`${packet.selected_node.name} (${packet.selected_node.type})`);
    if (packet.selected_node.file) sections.push(`File: ${packet.selected_node.file}:${packet.selected_node.line || 1}`);
  }

  if (packet.file_read_plan.length > 0) {
    sections.push('');
    sections.push('## File Read Plan');
    for (const item of packet.file_read_plan) {
      sections.push(`- ${item.file}${item.line ? `:${item.line}` : ''} - ${item.reason}`);
    }
  }

  const invariantImpact = (packet as any).invariant_impact;
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
