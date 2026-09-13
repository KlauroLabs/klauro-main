import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CASOutput, CASTerminalityMember, FlowConcept } from '../../../packages/analyzer-core/src/types/cas.types';
import { buildTerminalSignal } from '../../../packages/analyzer-core/src/analyzer/core/terminal-signal';
import { projectUserJourneysFromCas } from '../../../packages/analyzer-core/src/analyzer/core/journey-projection';
import { analyzeForBench } from './gauntlet/product-analysis';
import { evaluateAgentReadiness } from './agent-adoption';
import { buildSummary } from './query';
import { runAnswerPack } from './product';
import { isDirectCliInvocation } from './cli-invocation';

interface NamedTerminality extends CASTerminalityMember {
  name: string;
}

function namedTerminality(
  members: CASTerminalityMember[],
  names: Map<string, string>,
  predicate: (member: CASTerminalityMember) => boolean,
  limit = 12,
): NamedTerminality[] {
  return members
    .filter(predicate)
    .slice(0, limit)
    .map(member => ({ ...member, name: names.get(member.id) || member.id }));
}

function flowEvidence(flow: FlowConcept, entryFiles: Map<string, string | undefined>) {
  return {
    id: flow.flow_id,
    name: flow.name,
    intent: flow.intent,
    entry_point: flow.entry_point,
    entry_file: entryFiles.get(flow.entry_point) || null,
    capability_id: flow.capability_id || null,
    capability_relationships: flow.capability_relationships || [],
    steps: flow.steps.map(step => ({
      name: step.name,
      description: step.description,
      entities: step.entities,
      inputs: step.contract.input,
      outputs: step.contract.output,
      state_changes: step.contract.side_effects.state_changes,
      integrations: step.contract.side_effects.external_integrations,
    })),
    terminus: flow.terminus || null,
    continuations: flow.continuations || [],
    continued_from: flow.continued_from || [],
  };
}

export function buildAnalysisTruthReview(cas: CASOutput, projectPath: string) {
  const journeys = projectUserJourneysFromCas(cas).journeys;
  const summary = buildSummary(cas);
  const readiness = evaluateAgentReadiness(cas, projectPath);
  const answerPack = runAnswerPack(cas, projectPath);
  const terminality = cas.terminality || { nodes: [], entities: [], flows: [], capabilities: [] };
  const flowById = new Map((cas.flows || []).map(flow => [flow.flow_id, flow]));
  const flowNames = new Map((cas.flows || []).map(flow => [flow.flow_id, flow.name]));
  const entityNames = new Map((cas.entities || []).map(entity => [entity.id, entity.name]));
  const capabilityNames = new Map((cas.capabilities || []).map(capability => [capability.id, capability.name]));
  const entryFiles = new Map((cas.entry_points || []).map(entry => [entry.id, entry.handler?.file]));
  const terminalFlows = namedTerminality(terminality.flows, flowNames, member => member.terminal);
  const proximalFlows = namedTerminality(terminality.flows, flowNames, member => member.proximal_terminal);
  const reviewedFlowIds = new Set([...terminalFlows, ...proximalFlows].map(member => member.id));
  const terminalSignal = buildTerminalSignal({ journeys, systemCapabilities: cas.capabilities || [] });
  const fieldsByParent = new Map<string, typeof cas.nodes>();
  for (const node of cas.nodes) {
    if (!node.parent || !['field', 'property', 'attribute'].includes(node.type)) continue;
    const fields = fieldsByParent.get(node.parent) || [];
    fields.push(node);
    fieldsByParent.set(node.parent, fields);
  }

  return {
    project_path: projectPath,
    system: {
      name: summary.name,
      type: summary.type,
      description: summary.description,
      description_source: summary.description_source,
      primary_domain: summary.primary_domain,
      languages: summary.languages,
      frameworks: summary.frameworks,
    },
    analysis: {
      nodes: cas.nodes.length,
      edges: cas.edges.length,
      entry_points: cas.entry_points?.length || 0,
      flows: cas.flows?.length || 0,
      journeys: journeys.length,
      diagnostics: cas.analysis_errors || [],
    },
    comprehension: readiness.comprehension,
    answer_pack: answerPack,
    data_shape_evidence: cas.nodes
      .filter(node => ['struct', 'dto', 'entity', 'model', 'interface', 'type'].includes(node.type))
      .slice(0, 60)
      .map(node => ({
        id: node.id,
        name: node.name,
        type: node.type,
        source: node.source,
        subcategories: node.subcategories || [],
        fields: (fieldsByParent.get(node.id) || []).map(field => ({
          name: field.name,
          type: field.signature?.return_type || field.metadata?.attributes?.type || (field.metadata as Record<string, unknown> | undefined)?.type || 'unknown',
        })),
      })),
    canonical_capabilities: (cas.capabilities || []).map(capability => ({
      id: capability.id,
      name: capability.name,
      description: capability.description,
      category: capability.category,
      depends_on: capability.depends_on || [],
    })),
    terminality: {
      terminal_flows: terminalFlows,
      proximal_flows: proximalFlows,
      terminal_entities: namedTerminality(terminality.entities, entityNames, member => member.terminal),
      proximal_entities: namedTerminality(terminality.entities, entityNames, member => member.proximal_terminal),
      terminal_capabilities: namedTerminality(terminality.capabilities, capabilityNames, member => member.terminal),
      proximal_capabilities: namedTerminality(terminality.capabilities, capabilityNames, member => member.proximal_terminal),
      flow_evidence: [...reviewedFlowIds].map(id => flowById.get(id)).filter(Boolean).map(flow => flowEvidence(flow!, entryFiles)),
      terminal_signal: terminalSignal,
    },
    journey_evidence: [...journeys]
      .sort((left, right) => Number(right.journey_kind === 'user-facing') - Number(left.journey_kind === 'user-facing'))
      .slice(0, 16)
      .map(journey => ({
        id: journey.id,
        name: journey.name,
        kind: journey.journey_kind,
        entry: journey.entry,
        steps: journey.steps,
        terminal_effects: journey.terminal_effects,
        terminal_entities: journey.terminal_entities,
        security_boundaries: journey.security_boundaries,
      })),
  };
}

async function run(argv: string[]) {
  const outputIndex = argv.indexOf('--output');
  const output = outputIndex >= 0 ? path.resolve(argv[outputIndex + 1]) : undefined;
  const projectPaths = argv.filter((value, index) => value !== '--output' && index !== outputIndex + 1).map(value => path.resolve(value));
  if (projectPaths.length === 0) throw new Error('At least one project path is required');
  const reviews = [];
  for (const projectPath of projectPaths) reviews.push(buildAnalysisTruthReview(await analyzeForBench(projectPath), projectPath));
  const report = { generated_at: new Date().toISOString(), reviews };
  if (output) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (isDirectCliInvocation('analysis-truth-review')) {
  run(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
