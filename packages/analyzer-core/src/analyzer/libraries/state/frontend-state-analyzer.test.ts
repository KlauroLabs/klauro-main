import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FrontendStateAnalyzer } from './frontend-state-analyzer';
import { ReactiveStreamsAnalyzer } from './reactive-streams-analyzer';
import type { CASContribution, CASNode } from '../../../types/cas.types';

test('FrontendStateAnalyzer resolves nested-root file anchors for NgRx exits', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'frontend-state-anchor-'));
  try {
    const relativePath = 'src/app/auth.service.ts';
    const filePath = path.join(projectPath, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, [
      "import { Store } from '@ngrx/store';",
      'export class AuthService {',
      '  constructor(private store: Store) {}',
      '  clear(): void { this.store.dispatch(clearSession()); }',
      '}',
    ].join('\n'));
    const fileNode: CASNode = {
      id: 'file_workspace_src_app_auth_service_ts',
      name: 'auth.service.ts',
      type: 'file',
      level: 3,
      category: 'code',
      source: { file: `workspace/${relativePath}`, line: 1 },
    } as CASNode;
    const existingAnalysis = [{ nodes: [fileNode], edges: [] }] as CASContribution[];

    const contribution = await new FrontendStateAnalyzer().analyze({ projectPath, existingAnalysis } as any);
    const dispatch = contribution.exit_points?.find(item => item.name === 'NgRx dispatch: clearSession');

    assert.ok(dispatch);
    assert.equal(dispatch.source_node, fileNode.id);
  } finally {
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});

test('ReactiveStreamsAnalyzer resolves nested-root file anchors for subscription exits', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'reactive-stream-anchor-'));
  try {
    const relativePath = 'src/app/feed.service.ts';
    const filePath = path.join(projectPath, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, [
      "import { Observable } from 'rxjs';",
      'export class FeedService {',
      '  connect(actions$: Observable<string>): void { actions$.subscribe(); }',
      '}',
    ].join('\n'));
    const fileNode = {
      id: 'file_workspace_src_app_feed_service_ts',
      name: 'feed.service.ts',
      type: 'file',
      level: 3,
      category: 'code',
      source: { file: `workspace/${relativePath}`, line: 1 },
    } as CASNode;
    const existingAnalysis = [{
      nodes: [
        fileNode,
        {
          id: 'import_rxjs',
          name: 'rxjs',
          type: 'import',
          level: 4,
          category: 'dependency',
          source: { file: filePath, line: 1 },
          metadata: { source: 'rxjs' },
        } as CASNode,
      ],
      edges: [],
    }] as unknown as CASContribution[];

    const contribution = await new ReactiveStreamsAnalyzer().analyze({ projectPath, existingAnalysis } as any);
    const subscription = contribution.exit_points?.find(item => item.name === 'RxJS subscription: actions$.subscribe()');

    assert.ok(subscription);
    assert.equal(subscription.source_node, fileNode.id);
  } finally {
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});
