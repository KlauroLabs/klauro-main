import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { evaluateAgentReadiness } from './agent-adoption';
import { validateCASContract, type CASGoldenSnapshot, compareCASGoldenSnapshot } from './cas-contract';
import { summarizeAnalysisFreshness } from './freshness';
import { getAnalysisFreshness } from './analysis-freshness-deep';
import { getRuntimeEventContract } from './runtime-contract';
import { getRuntimeSdkPackage } from './runtime-sdk';
import { getTestDiscoveryEvidence } from './test-discovery';
import { loadGoldenSnapshot } from './storage';

type DoctorStatus = 'pass' | 'warn' | 'fail';

export async function getAgentDoctor(cas: CASOutput, projectPath: string, options: { assumeFresh?: boolean } = {}) {
  const testEvidence = await getTestDiscoveryEvidence(projectPath, cas);
  const freshness = options.assumeFresh
    ? {
        status: 'fresh',
        recommendation: 'Analysis was generated for the current evaluation run.',
      }
    : await getAnalysisFreshness(projectPath);








  const sharedStaleness = options.assumeFresh ? null : summarizeAnalysisFreshness(projectPath, cas.analysis_timestamp);
  const reconciledFreshnessStatus: typeof freshness.status = sharedStaleness
    ? (sharedStaleness.staleness === 'fresh' ? 'fresh' : sharedStaleness.staleness === 'stale' ? 'stale' : freshness.status)
    : freshness.status;
  if (sharedStaleness && reconciledFreshnessStatus !== freshness.status) {
    (freshness as { status: typeof freshness.status }).status = reconciledFreshnessStatus;
    (freshness as { recommendation: string }).recommendation = sharedStaleness.recommendation;
  }




  const layersReady = cas.layers_ready;
  const analysisComplete = !layersReady || layersReady.complete !== false;
  const pendingLayers = (layersReady?.layers || []).filter(layer => layer.status === 'pending').map(layer => layer.layer);
  const readiness = evaluateAgentReadiness(cas, projectPath, { testEvidence });
  const contract = validateCASContract(cas);
  const runtime = getRuntimeEventContract(cas, { limit: 25 });
  const sdkPackage = getRuntimeSdkPackage(cas, { limit: 10 });
  const savedGolden = await loadGoldenSnapshot(projectPath);
  const goldenGates = savedGolden?.snapshot
    ? compareCASGoldenSnapshot(cas, savedGolden.snapshot as CASGoldenSnapshot)
    : [];
  const goldenStatus: DoctorStatus = !savedGolden
    ? 'warn'
    : goldenGates.some(gate => gate.status === 'fail') ? 'fail' : goldenGates.some(gate => gate.status === 'warn') ? 'warn' : 'pass';

  const checks = [
    check('cas-contract', contract.status, contract.score, `${contract.summary.nodes} nodes, ${contract.summary.edges} edges`),
    check('agent-readiness', readiness.status, readiness.score, readiness.agent_context_ready ? 'Ready for agent use' : readiness.adoption_gaps.join('; ')),
    check('freshness', freshness.status === 'fresh' ? 'pass' : freshness.status === 'stale' ? 'warn' : 'fail', freshness.status === 'fresh' ? 100 : freshness.status === 'stale' ? 70 : 0, freshness.recommendation),
    check('layers-complete', analysisComplete ? 'pass' : 'warn', analysisComplete ? 100 : 60,
      analysisComplete ? 'All analysis layers complete' : `Analysis still populating: ${pendingLayers.join(', ') || 'background layers pending'}`),
    check('test-evidence', testEvidence.status === 'cas-covered' ? 'pass' : 'warn', testEvidence.status === 'cas-covered' ? 100 : 80, testEvidence.summary),
    check('runtime-sdk', runtime.totals.runtime_static_links > 0 && sdkPackage.files.length > 0 ? 'pass' : 'warn', runtime.totals.runtime_static_links > 0 ? 100 : 75, `${runtime.totals.runtime_static_links} runtime links, ${sdkPackage.files.length} SDK files`),
    check('golden-snapshot', goldenStatus, goldenStatus === 'pass' ? 100 : goldenStatus === 'warn' ? 80 : 0, savedGolden ? `${goldenGates.length} snapshot gates` : 'No saved CAS golden snapshot'),
  ];
  const status: DoctorStatus = checks.some(item => item.status === 'fail')
    ? 'fail'
    : checks.some(item => item.status === 'warn') ? 'warn' : 'pass';

  return {
    generated_at: new Date().toISOString(),
    path: projectPath,
    status,
    agent_context_ready: status !== 'fail' && readiness.agent_context_ready && freshness.status !== 'stale' && analysisComplete,
    checks,
    readiness,
    freshness,
    test_discovery: testEvidence,
    runtime_sdk: {
      manifest: sdkPackage.manifest,
      proof: sdkPackage.proof,
    },
    golden_snapshot: {
      saved: Boolean(savedGolden),
      saved_at: savedGolden?.saved_at,
      status: goldenStatus,
      gates: goldenGates,
    },
    agent_default_rule: 'Agents should call get_agent_bootstrap or run `klauro agent-start <repo>` before broad source reads when this doctor status is pass or warn.',
    first_commands: [
      `klauro doctor ${projectPath}`,
      `klauro agent-start ${projectPath} --task-type orient`,
      `klauro agent-start ${projectPath} --task-type modify --target <area>`,
    ],
    mcp_first_tools: [
      'get_agent_bootstrap',
      'get_analysis_freshness',
      'validate_cas_contract',
      'get_test_discovery_evidence',
      'get_runtime_sdk_package',
    ],
  };
}

function check(id: string, status: DoctorStatus, score: number, detail: string) {
  return { id, status, score: Math.round(score), detail };
}
