import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { benchmarkGreenfieldBuildCodecs, buildGreenfieldBuildPacket } from './greenfield-build-session';

async function main() {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-greenfield-codec-'));
  await seedContinuationWorkspace(workspace);

  const emptyWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-empty-codec-'));
  const emptyPacket = await buildGreenfieldBuildPacket({
    workspacePath: emptyWorkspace,
    planText: 'Build a multi-tenant compliance evidence platform with controls, reviewer queues, audit exports, escalation windows, tests, and durable history.',
    references: [],
  });
  const continuationPacket = await buildGreenfieldBuildPacket({
    workspacePath: workspace,
    planText: 'Continue the compliance platform with reviewer notifications, saved queue filters, control renewal windows, and audit export packages. Reuse Workspace, Control, EvidenceRequest, ReviewerQueue, and AuditEvent.',
    references: [],
  });

  const report = {
    generated_at: new Date().toISOString(),
    recommendation: 'g1-build-capsule',
    scenarios: [
      {
        name: 'empty-folder-first-slice',
        ...benchmarkGreenfieldBuildCodecs(emptyPacket),
      },
      {
        name: 'cas-backed-continuation',
        ...benchmarkGreenfieldBuildCodecs(continuationPacket),
      },
    ],
  };

  const output = process.argv.includes('--output')
    ? process.argv[process.argv.indexOf('--output') + 1]
    : '';
  if (output) {
    await fs.ensureDir(path.dirname(output));
    await fs.writeJson(output, report, { spaces: 2 });
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

async function seedContinuationWorkspace(workspace: string) {
  await fs.outputJson(path.join(workspace, 'package.json'), {
    type: 'module',
    scripts: { test: 'node --test tests/*.test.js' },
  });
  await fs.outputFile(path.join(workspace, 'src/domain/concepts.ts'), `
export interface Workspace { id: string; name: string; }
export interface Control { id: string; workspaceId: Workspace['id']; name: string; renewalDays: number; }
export interface EvidenceRequest { id: string; controlId: Control['id']; reviewerId: string; status: 'open' | 'approved'; }
export interface ReviewerQueue { id: string; workspaceId: Workspace['id']; reviewerId: string; }
export interface AuditEvent { id: string; workspaceId: Workspace['id']; actorId: string; action: string; at: string; }
`);
  await fs.outputFile(path.join(workspace, 'src/services/evidence-review.service.ts'), `
import type { AuditEvent, EvidenceRequest, ReviewerQueue, Workspace } from '../domain/concepts';
export class EvidenceReviewService {
  listQueue(workspace: Workspace, queue: ReviewerQueue, requests: EvidenceRequest[]) {
    return requests.filter(request => queue.workspaceId === workspace.id && request.status === 'open');
  }
  recordAudit(workspace: Workspace, actorId: string, action: string): AuditEvent {
    return { id: workspace.id + action, workspaceId: workspace.id, actorId, action, at: new Date().toISOString() };
  }
}
`);
  await fs.outputFile(path.join(workspace, 'migrations/001_compliance_core.sql'), `
CREATE TABLE workspaces (id text primary key, name text not null);
CREATE TABLE controls (id text primary key, workspace_id text not null references workspaces(id), name text not null, renewal_days integer not null);
CREATE TABLE evidence_requests (id text primary key, control_id text not null references controls(id), reviewer_id text not null, status text not null);
CREATE TABLE audit_events (id text primary key, workspace_id text not null references workspaces(id), actor_id text not null, action text not null, at text not null);
`);
  await fs.outputFile(path.join(workspace, 'tests/evidence-review.service.test.js'), `
import assert from 'node:assert/strict';
import test from 'node:test';
test('lists open requests for a reviewer queue', () => assert.equal(1, 1));
`);
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
