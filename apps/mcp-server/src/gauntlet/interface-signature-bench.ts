

























import * as path from 'path';
import { analyzeForBench } from './product-analysis';
import { hasUnresolvedDependencyEffect } from '../../../../packages/analyzer-core/src/analyzer/core/exit-point-effects';
import {
  getInterfaceSignature,
  getEntryPoints,
  getExitPoints,

  getCallers,
} from '../query';

const FIXTURE_DIR = path.join(__dirname, '..', '..', 'fixtures', 'analysis-truth', 'express-mongoose');

export interface InterfaceSignatureCaseResult {
  target: string;
  level: string;
  has_input: boolean;
  has_output: boolean;
  has_side_effects: boolean;
  has_logic: boolean;
  input_matches_manual_join: boolean;
  side_effects_matches_manual_join: boolean;
  logic_callers_total_matches: boolean;
  one_call_contains_all_four_dimensions: boolean;
}

export interface InterfaceSignatureBenchReport {
  function_level: InterfaceSignatureCaseResult;
  project_level: { target: string; level: string; has_all_four: boolean };
  passed: boolean;
}

export async function runInterfaceSignatureBench(): Promise<InterfaceSignatureBenchReport> {
  const cas: any = await analyzeForBench(FIXTURE_DIR);

  const target = cas.nodes.find((node: any) =>
    node.name === 'createUser' &&
    ['function', 'method'].includes(node.type) &&
    String(node.source?.file ?? '').endsWith('src/server.ts'));
  const targetNodeId: string = target?.id ?? 'createUser:unresolved';


  const signature: any = getInterfaceSignature(cas, targetNodeId, {});



  const manualEntryPoints = getEntryPoints(cas, { limit: 500 }).entry_points
    .filter((ep: any) => ep.source_node === targetNodeId || ep.handler?.node_id === targetNodeId);
  const manualExitPoints = getExitPoints(cas, { limit: 500 }).exit_points
    .filter((ep: any) => ep.source_node === targetNodeId);
  const exitById = new Map((cas.exit_points || []).map((exit: any) => [exit.id, exit] as const));
  const expectedRecipients = new Set(manualExitPoints
    .filter((exit: any) => !['database', 'cache', 'file'].includes(exit.type) && !hasUnresolvedDependencyEffect(exit))
    .map((exit: any) => exit.target?.service_id || exit.target?.resource || `${exit.type}:${exit.name}`));
  for (const entry of cas.data_lineage || []) {
    if (!entry.writers.some((writer: any) => writer.node_id === targetNodeId) &&
        !entry.readers.some((reader: any) => reader.node_id === targetNodeId)) continue;
    for (const recipient of entry.external_recipients) {
      const exit: any = exitById.get(recipient.exit_point_id);
      const carrier = recipient.via_node ?? exit?.source_node;
      if (carrier === targetNodeId && (!exit || !hasUnresolvedDependencyEffect(exit))) expectedRecipients.add(recipient.service);
    }
  }
  const manualCallers = getCallers(cas, targetNodeId, 1, 50);

  const realParamNode = cas.nodes.find((n: any) => n.id === targetNodeId);
  const realParamNames: string[] = (realParamNode?.signature?.parameters || []).map((p: any) => p.name);

  const inputParamNames = (signature.input || [])
    .filter((i: any) => i.kind === 'parameter')
    .map((i: any) => i.name);
  const inputEntryPointIds = (signature.input || [])
    .filter((i: any) => i.kind === 'entry_point')
    .map((i: any) => i.id);

  const sideEffectExitIds = (signature.side_effects || [])
    .filter((s: any) => s.kind === 'exit_point')
    .map((s: any) => s.id);
  const sideEffectRecipients = (signature.side_effects || [])
    .filter((s: any) => s.kind === 'external_recipient')
    .map((s: any) => s.service);
  const sideEffectBoundaries = (signature.side_effects || [])
    .filter((s: any) => s.kind === 'boundary')
    .map((s: any) => s.boundary);

  const inputMatchesManualJoin =
    realParamNames.every(name => inputParamNames.includes(name)) &&
    manualEntryPoints.every((ep: any) => inputEntryPointIds.includes(ep.id));

  const sideEffectsMatchesManualJoin =
    manualExitPoints.every((ep: any) => sideEffectExitIds.includes(ep.id)) &&
    sideEffectExitIds.length === manualExitPoints.length &&
    expectedRecipients.size === new Set(sideEffectRecipients).size &&
    [...expectedRecipients].every(service => sideEffectRecipients.includes(service)) &&
    sideEffectBoundaries.length === 0 &&
    Boolean(realParamNode?.contract) &&
    JSON.stringify(signature.contract) === JSON.stringify(realParamNode.contract);

  const logicCallersTotalMatches = signature.logic?.callers_total === manualCallers.total;

  const functionLevel: InterfaceSignatureCaseResult = {
    target: targetNodeId,
    level: signature.level,
    has_input: Array.isArray(signature.input) && signature.input.length > 0,
    has_output: Array.isArray(signature.output),
    has_side_effects: Array.isArray(signature.side_effects) && signature.side_effects.length > 0,
    has_logic: typeof signature.logic?.callers_total === 'number',
    input_matches_manual_join: inputMatchesManualJoin,
    side_effects_matches_manual_join: sideEffectsMatchesManualJoin,
    logic_callers_total_matches: logicCallersTotalMatches,
    one_call_contains_all_four_dimensions:
      Array.isArray(signature.input) && signature.input.length > 0 &&
      Array.isArray(signature.output) &&
      Array.isArray(signature.side_effects) && signature.side_effects.length > 0 &&
      typeof signature.logic?.callers_total === 'number',
  };


  const projectSignature: any = getInterfaceSignature(cas, 'project', { level: 'project' });
  const projectLevel = {
    target: 'project',
    level: projectSignature.level,
    has_all_four:
      Array.isArray(projectSignature.input) && projectSignature.input.length > 0 &&
      Array.isArray(projectSignature.output) &&
      Array.isArray(projectSignature.side_effects?.exit_point_types) &&
      typeof projectSignature.logic?.internal_module_count === 'number',
  };

  const passed =
    functionLevel.one_call_contains_all_four_dimensions &&
    functionLevel.input_matches_manual_join &&
    functionLevel.side_effects_matches_manual_join &&
    functionLevel.logic_callers_total_matches &&
    projectLevel.has_all_four;

  return { function_level: functionLevel, project_level: projectLevel, passed };
}
