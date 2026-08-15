import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { getClaimStreams, heartbeatClaimStream, publishClaimStream, releaseClaimStream, type ClaimStreamRequest } from './claim-stream-store';

let coordinationDirectory: string;
let workspaceSequence = 0;

before(() => {
  coordinationDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-fabric-claims-'));
  process.env.KLAURO_COORD_DIR = coordinationDirectory;
});

after(() => {
  fs.rmSync(coordinationDirectory, { recursive: true, force: true });
  delete process.env.KLAURO_COORD_DIR;
});

function workspace(): string {
  workspaceSequence += 1;
  return `workspace-${Date.now()}-${workspaceSequence}`;
}

function request(overrides: Partial<ClaimStreamRequest> & Pick<ClaimStreamRequest, 'workspace_id' | 'agent_id'>): ClaimStreamRequest {
  return {
    agent_kind: 'codex',
    scope: { repo: 'repo', paths: ['src/shared.ts'], symbols: ['symbol:shared'] },
    intent: 'Improve the shared behavior',
    ...overrides,
  };
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe('Fabric claim compatibility', () => {
  it('retains both overlapping streams and returns advisory overlap context', async () => {
    const workspaceId = workspace();
    const first = await publishClaimStream(request({ workspace_id: workspaceId, agent_id: 'agent-a' }));
    const second = await publishClaimStream(request({ workspace_id: workspaceId, agent_id: 'agent-b' }));

    assert.equal(first.verdict, 'granted');
    assert.equal(second.verdict, 'granted');
    assert.equal(second.conflict?.holder_agent_id, 'agent-a');
    assert.deepEqual(second.conflict?.overlapping_symbols, ['symbol:shared']);
    assert.match(second.redirect_hint ?? '', /advisory/i);

    const state = await getClaimStreams(workspaceId);
    assert.deepEqual(state.active.map((entry) => entry.agent_id).sort(), ['agent-a', 'agent-b']);
  });

  it('retains concurrent claims over the same scope without ordering them', async () => {
    const workspaceId = workspace();
    const results = await Promise.all([
      publishClaimStream(request({ workspace_id: workspaceId, agent_id: 'agent-a', intent: 'Explore one approach' })),
      publishClaimStream(request({ workspace_id: workspaceId, agent_id: 'agent-b', intent: 'Explore another approach' })),
    ]);

    assert.deepEqual(results.map((result) => result.verdict), ['granted', 'granted']);
    const state = await getClaimStreams(workspaceId);
    assert.equal(state.active.length, 2);
    assert.equal(new Set(state.active.map((entry) => entry.claim_id)).size, 2);
  });

  it('makes a repeated claim from the same participant and scope idempotent', async () => {
    const workspaceId = workspace();
    const first = await publishClaimStream(request({ workspace_id: workspaceId, agent_id: 'agent-a' }));
    const second = await publishClaimStream(request({ workspace_id: workspaceId, agent_id: 'agent-a' }));

    assert.equal(second.claim_id, first.claim_id);
    assert.equal((await getClaimStreams(workspaceId)).active.length, 1);
  });

  it('heartbeats one stream without changing an overlapping peer stream', async () => {
    const workspaceId = workspace();
    const first = await publishClaimStream(request({ workspace_id: workspaceId, agent_id: 'agent-a', ttl_ms: 180 }));
    await publishClaimStream(request({ workspace_id: workspaceId, agent_id: 'agent-b', ttl_ms: 500 }));
    await pause(100);

    const heartbeat = await heartbeatClaimStream(workspaceId, first.claim_id!);
    assert.equal(heartbeat.ok, true);
    await pause(100);

    assert.deepEqual((await getClaimStreams(workspaceId)).active.map((entry) => entry.agent_id).sort(), ['agent-a', 'agent-b']);
    assert.equal((await heartbeatClaimStream(workspaceId, 'missing')).ok, false);
  });

  it('releases only the selected attributed stream', async () => {
    const workspaceId = workspace();
    const first = await publishClaimStream(request({ workspace_id: workspaceId, agent_id: 'agent-a' }));
    const second = await publishClaimStream(request({ workspace_id: workspaceId, agent_id: 'agent-b' }));

    assert.equal((await releaseClaimStream(workspaceId, 'agent-a', first.claim_id!)).released, true);
    assert.deepEqual((await getClaimStreams(workspaceId)).active.map((entry) => entry.claim_id), [second.claim_id]);
    assert.equal((await releaseClaimStream(workspaceId, 'agent-a', first.claim_id!)).released, false);
  });

  it('expires stale streams independently', async () => {
    const workspaceId = workspace();
    await publishClaimStream(request({ workspace_id: workspaceId, agent_id: 'agent-a', ttl_ms: 60 }));
    await publishClaimStream(request({ workspace_id: workspaceId, agent_id: 'agent-b', ttl_ms: 500 }));
    await pause(90);

    assert.deepEqual((await getClaimStreams(workspaceId)).active.map((entry) => entry.agent_id), ['agent-b']);
  });
});
