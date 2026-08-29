import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateTelemetryExternalProof, type TelemetryExternalProofEvidence } from './telemetry-external-proof-contract';
import { resolveTelemetrySdkReleaseCandidateRoot, verifyTelemetrySdkReleaseReceipt } from '../../../../scripts/telemetry-sdk-release-integrity.mjs';

interface ProofState {
  started_at: string;
  event_ids: { javascript: string[]; python: string[] };
  preanalysis_unmatched: number;
  sdk_release_proof_sha256: string;
  artifact_sha256: { javascript: string; python: string };
}

const phase = process.argv[2];
const statePath = path.resolve(process.argv[3] || 'telemetry-external-proof-state.json');
const outputPath = path.resolve(process.argv[4] || 'telemetry-external-proof-receipt.json');
const endpoint = required('KLAURO_PROOF_ENDPOINT').replace(/\/+$/, '');
const projectId = required('KLAURO_PROOF_PROJECT_ID');
const crossProjectId = required('KLAURO_PROOF_CROSS_PROJECT_ID');
const ingestToken = required('KLAURO_PROOF_INGEST_TOKEN');
const accountToken = required('KLAURO_PROOF_ACCOUNT_TOKEN');
const serverSha = required('KLAURO_PROOF_SERVER_SHA');
const candidateDir = resolveTelemetrySdkReleaseCandidateRoot(path.resolve(required('KLAURO_TELEMETRY_SDK_CANDIDATE_DIR')));
const proofRoute = required('KLAURO_PROOF_ROUTE');
const manifest = JSON.parse(fs.readFileSync(path.join(candidateDir, 'manifest.json'), 'utf8')) as {
  javascript_version: string; python_version: string;
};
const verified = verifyTelemetrySdkReleaseReceipt(candidateDir, {
  sourceSha: serverSha,
  javascriptVersion: manifest.javascript_version,
  pythonVersion: manifest.python_version,
});
const releaseManifest = verified.manifest as unknown as {
  artifacts: Array<{ kind: 'javascript' | 'python'; filename: string; sha256: string }>;
};
const artifacts = Object.fromEntries(releaseManifest.artifacts.map(artifact => [artifact.kind, artifact]));

void main();

async function main(): Promise<void> {
  if (phase === 'preanalysis') await preanalysis();
  else if (phase === 'verify') await verify();
  else throw new Error('Usage: telemetry-external-proof.ts preanalysis|verify [state.json] [receipt.json]');
}

async function preanalysis(): Promise<void> {
  await verifyServerIdentity();
  const startedAt = new Date().toISOString();
  const auth = await authStatuses();
  if (auth.missing_token_status !== 401 || auth.invalid_token_status !== 401 || auth.cross_project_status !== 401) {
    throw new Error('Hosted telemetry authentication did not fail closed.');
  }
  const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-telemetry-external-'));
  try {
    const jsRoot = path.join(installRoot, 'javascript');
    fs.mkdirSync(jsRoot);
    execFileSync('npm', ['install', '--prefix', jsRoot, '--ignore-scripts', '--no-audit', '--no-fund', path.join(candidateDir, artifacts.javascript.filename)], { stdio: 'ignore' });
    const jsSdk = await import(pathToFileURL(path.join(jsRoot, 'node_modules/@klauro/telemetry/dist/index.js')).href);
    const javascriptIds = [`proof-js-${randomSuffix()}`, `proof-js-${randomSuffix()}`];
    let dropFirstAcknowledgement = true;
    const client = new jsSdk.KlauroClient({
      endpoint, projectId, apiKey: ingestToken, batchSize: 1000, flushInterval: 0, retryAttempts: 2, retryBaseDelay: 0,
      fetchImpl: async (...args: Parameters<typeof fetch>) => {
        const response = await fetch(...args);
        if (dropFirstAcknowledgement) {
          dropFirstAcknowledgement = false;
          await response.arrayBuffer();
          throw new Error('proof response-loss injection');
        }
        return response;
      },
    });
    for (const eventId of javascriptIds) client.recordEvent(proofEvent(eventId));
    await client.flush();
    await client.shutdown();

    const pythonRoot = path.join(installRoot, 'python');
    execFileSync('python3', ['-m', 'venv', pythonRoot]);
    execFileSync(path.join(pythonRoot, 'bin/pip'), ['install', '--no-deps', path.join(candidateDir, artifacts.python.filename)], { stdio: 'ignore' });
    const pythonIds = [`proof-py-${randomSuffix()}`];
    const python = [
      'import json, os',
      'from klauro_telemetry import KlauroClient',
      'client=KlauroClient(project_id=os.environ["PROJECT"], api_key=os.environ["TOKEN"], endpoint=os.environ["ENDPOINT"], flush_interval=0, retry_attempts=2)',
      'client.record_event({"event_id": os.environ["EVENT_ID"], "type":"request", "method":"GET", "route":os.environ["PROOF_ROUTE"], "trace_id":"telemetry-proof"})',
      'client.flush(); client.shutdown()',
    ].join('\n');
    execFileSync(path.join(pythonRoot, 'bin/python'), ['-c', python], {
      env: { ...process.env, PROJECT: projectId, TOKEN: ingestToken, ENDPOINT: endpoint, EVENT_ID: pythonIds[0], PROOF_ROUTE: proofRoute }, stdio: 'ignore',
    });
    const observations = await getJson(`/v1/telemetry/observations?workspace=${encodeURIComponent(projectId)}&limit=5000`, accountToken);
    const attempted = [...javascriptIds, ...pythonIds];
    const persisted = observationIds(observations).filter(id => attempted.includes(id));
    if (new Set(persisted).size !== attempted.length) throw new Error('Pre-analysis read-back did not contain every SDK event exactly once.');
    const unmatched = observations.observations.filter((item: any) => attempted.includes(item.event?.event_id) && item.correlation?.status === 'unmatched').length;
    if (unmatched < 1) throw new Error('Pre-analysis proof requires at least one unmatched observation before analysis.');
    const state: ProofState = {
      started_at: startedAt,
      event_ids: { javascript: javascriptIds, python: pythonIds },
      preanalysis_unmatched: unmatched,
      sdk_release_proof_sha256: verified.receipt.proof_sha256,
      artifact_sha256: { javascript: artifacts.javascript.sha256, python: artifacts.python.sha256 },
    };
    writeExclusive(statePath, state);
  } finally {
    fs.rmSync(installRoot, { recursive: true, force: true });
  }
}

async function verify(): Promise<void> {
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as ProofState;
  await verifyServerIdentity();
  if (state.sdk_release_proof_sha256 !== verified.receipt.proof_sha256) throw new Error('SDK release proof changed between phases.');
  const attempted = [...state.event_ids.javascript, ...state.event_ids.python];
  const observations = await getJson(`/v1/telemetry/observations?workspace=${encodeURIComponent(projectId)}&limit=5000`, accountToken);
  const persisted = observationIds(observations).filter(id => attempted.includes(id));
  const remainingUnmatched = observations.observations.filter((item: any) => attempted.includes(item.event?.event_id) && item.correlation?.status === 'unmatched').length;
  const links = await query('get_runtime_static_links', { telemetry_status: 'observed' });
  const flows = await query('get_flow_graph', {});
  const observedCapabilities = (flows.result?.capabilities || []).filter((item: any) => item.telemetry?.observed).map((item: any) => item.id);
  const observedLinks = (links.result?.links || []).map((item: any) => ({ id: item.id, static_id: item.static_id }));
  const actualFlows = (flows.result?.flows || []).map((item: any) => ({
    flow_id: item.flow_id,
    static_ids: item.static_ids || [],
    capability_ids: item.capability_ids || [],
  }));
  const eventProvenance = attempted.map(eventId => {
    const observation = observations.observations.find((item: any) => item.event?.event_id === eventId);
    const staticId = observation?.correlation?.best_match?.id;
    const link = observedLinks.find((item: any) => item.static_id === staticId);
    const flow = actualFlows.find((item: any) => item.static_ids.includes(staticId)
      && item.capability_ids.some((id: string) => observedCapabilities.includes(id)));
    const capabilityId = flow?.capability_ids.find((id: string) => observedCapabilities.includes(id));
    if (!staticId || !link || !flow || !capabilityId) {
      throw new Error(`No causal observed runtime-link/flow/capability chain for submitted event ${eventId}.`);
    }
    return { event_id: eventId, runtime_static_link_id: link.id, static_id: staticId, flow_id: flow.flow_id, capability_id: capabilityId };
  });
  const evidence: TelemetryExternalProofEvidence = {
    schema_version: 1, endpoint_url: endpoint, server_sha: serverSha,
    sdk_release_proof_sha256: state.sdk_release_proof_sha256,
    clients: [
      { runtime: 'javascript', artifact_sha256: state.artifact_sha256.javascript, isolated_install: true, sent_event_ids: state.event_ids.javascript, acknowledged_count: state.event_ids.javascript.length },
      { runtime: 'python', artifact_sha256: state.artifact_sha256.python, isolated_install: true, sent_event_ids: state.event_ids.python, acknowledged_count: state.event_ids.python.length },
    ],
    auth: await authStatuses(),
    delivery: { attempted_event_ids: attempted, persisted_event_ids: persisted, retried_event_ids: state.event_ids.javascript },
    backfill: { preanalysis_unmatched: state.preanalysis_unmatched, analysis_id: flows.analysis_id || '', upgraded: state.preanalysis_unmatched - remainingUnmatched, remaining_unmatched: remainingUnmatched },
    observed: {
      runtime_static_links: observedLinks,
      flows: actualFlows,
      capability_ids: observedCapabilities,
      event_provenance: eventProvenance,
    },
    started_at: state.started_at, completed_at: new Date().toISOString(),
  };
  const receipt = validateTelemetryExternalProof(evidence, { serverSha, sdkReleaseProofSha256: verified.receipt.proof_sha256, artifactSha256: state.artifact_sha256 });
  writeExclusive(outputPath, receipt);
}

async function authStatuses() {
  const pathName = `/api/telemetry/runtime-events/${encodeURIComponent(projectId)}`;
  const body = JSON.stringify({ events: [proofEvent(`auth-${randomSuffix()}`)] });
  const send = (token?: string, target = pathName) => fetch(`${endpoint}${target}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body,
  });
  return {
    missing_token_status: (await send()).status,
    invalid_token_status: (await send('kt_invalid')).status,
    cross_project_status: (await send(ingestToken, `/api/telemetry/runtime-events/${encodeURIComponent(crossProjectId)}`)).status,
  };
}

async function query(tool: string, args: unknown): Promise<any> {
  return getJson(`/api/projects/${encodeURIComponent(projectId)}/query`, accountToken, { tool, args });
}

async function getJson(pathName: string, token: string, body?: unknown): Promise<any> {
  const response = await fetch(`${endpoint}${pathName}`, {
    method: body ? 'POST' : 'GET', headers: { ...(body ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(`Hosted proof request failed with HTTP ${response.status}.`);
  return value;
}

function observationIds(body: any): string[] {
  return (body.observations || []).map((item: any) => item.event?.event_id).filter((id: unknown): id is string => typeof id === 'string');
}
function proofEvent(eventId: string) {
  return { event_id: eventId, type: 'request', method: 'GET', route: proofRoute, trace_id: 'telemetry-proof' };
}
async function verifyServerIdentity(): Promise<void> {
  const health = await getJson('/health', accountToken);
  const actual = health.source_sha || health.git_sha || health.commit_sha;
  if (actual !== serverSha) throw new Error('Hosted server does not report the exact expected source SHA.');
}
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required; external proof never substitutes a local or fake endpoint.`);
  return value;
}
function randomSuffix(): string { return createHash('sha256').update(`${process.pid}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 16); }
function writeExclusive(file: string, value: unknown): void { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); }
