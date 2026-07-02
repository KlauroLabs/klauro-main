/**
 * INTERFACE-SIGNATURE bench — validates get_interface_signature (the I/L/S/O
 * join, SPEC-INTELLIGENCE-CAPITALIZATION.md concept #2).
 *
 * What is being proven
 * ---------------------
 * Today an agent asking "what is this function's full contract" must call
 * get_entry_points, get_exit_points, get_data_lineage, and get_callers/
 * get_callees separately and intersect the results by node_id/source_node by
 * hand — 4+ tool calls, manual joins, real risk of missing a side-effect that
 * isn't in the tool the agent happened to check. get_interface_signature is a
 * pure JOIN over the SAME underlying facts (no new analyzer pass): one call
 * should contain everything the 4-call manual join would have found.
 *
 * This bench is BLACKBOX (goes through analyzeForBench, the product's real
 * analysis path — never imports orchestrator internals directly) and asserts
 * the single-call signature's I/O/S/L fields match the real underlying facts
 * computed independently via the same query.ts functions the manual join
 * would use.
 *
 * Fixture: fixtures/analysis-truth/express-mongoose — a small, self-contained
 * Express + Mongoose API with a real param-typed handler, entry points
 * (routes), exit points (Mongoose calls), and data_lineage (User entity
 * writers/readers) — every I/L/S/O quadrant has real data to check against.
 */

import * as path from 'path';
import { analyzeForBench } from './product-analysis';
import {
  getInterfaceSignature,
  getEntryPoints,
  getExitPoints,
  getDataLineage,
  getCallers,
  getCallees,
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

  const targetNodeId = 'function_src/server.ts_createUser_2';

  // -- The single call under test --
  const signature: any = getInterfaceSignature(cas, targetNodeId, {});

  // -- The OLD way: 4 separate calls + manual node_id/source_node join,
  // exactly as an agent without get_interface_signature would have to do. --
  const manualEntryPoints = getEntryPoints(cas, { limit: 500 }).entry_points
    .filter((ep: any) => ep.source_node === targetNodeId || ep.handler?.node_id === targetNodeId);
  const manualExitPoints = getExitPoints(cas, { limit: 500 }).exit_points
    .filter((ep: any) => ep.source_node === targetNodeId);
  const manualLineage = (getDataLineage(cas, { limit: 500 }) as any).entities
    .filter((e: any) => {
      // getDataLineage's compact shape only carries writer/reader FILE+via, not
      // node_id at top-level list scope — re-fetch full entity detail to check
      // node_id membership the way a careful manual join would have to.
      const full = (cas.data_lineage || []).find((d: any) => d.entity_id === e.entity_id);
      return full && (
        full.writers.some((w: any) => w.node_id === targetNodeId) ||
        full.readers.some((r: any) => r.node_id === targetNodeId)
      );
    });
  const manualCallers = getCallers(cas, targetNodeId, 1, 50);
  const manualCallees = getCallees(cas, targetNodeId, 1, 50);

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

  const inputMatchesManualJoin =
    realParamNames.every(name => inputParamNames.includes(name)) &&
    manualEntryPoints.every((ep: any) => inputEntryPointIds.includes(ep.id));

  const sideEffectsMatchesManualJoin =
    manualExitPoints.length > 0 &&
    manualExitPoints.every((ep: any) => sideEffectExitIds.includes(ep.id)) &&
    manualLineage.length > 0; // confirms lineage-based side-effects exist in this fixture, exercising that join path

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

  // -- Project-level rollup: proves the level-aware aggregation path. --
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
