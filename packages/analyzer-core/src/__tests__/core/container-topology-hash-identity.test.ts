jest.unmock('fs-extra');
jest.unmock('fs');
jest.unmock('glob');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { DockerfileAnalyzer } from '../../analyzer/languages/container-topology-analyzer';
import { isHashOrIdShapedToken } from '../../analyzer/core/deployable-evidence/util';

// Mirrors the on-disk snapshot dir name production analyze calls use
// (analysisId hash from remote-analyzer-service.ts).
const HASH_BASENAME = 'b4d1b9a5fa2fab1c';

describe('DockerfileAnalyzer: service_aliases never leak a hash-shaped workspace basename', () => {
  let parent: string;
  let projectPath: string;

  afterEach(() => {
    if (parent) fs.removeSync(parent);
  });

  test('a hash-named project dir falls back to a real/non-hash service alias', async () => {
    parent = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-container-topology-'));
    projectPath = path.join(parent, HASH_BASENAME);
    fs.mkdirSync(projectPath);
    fs.writeFileSync(path.join(projectPath, 'Dockerfile'), 'FROM node:22-alpine\nEXPOSE 3000\nCMD ["node", "server.js"]\n');

    const analyzer = new DockerfileAnalyzer();
    const contribution = await analyzer.analyze({ projectPath });
    const node = (contribution.nodes ?? []).find(n => n.type === 'container_image_definition');
    expect(node).toBeDefined();
    const aliases: string[] = (node!.metadata as any).service_aliases;
    expect(aliases).toBeDefined();
    for (const alias of aliases) {
      expect(isHashOrIdShapedToken(alias)).toBe(false);
    }
    expect(aliases).not.toContain(HASH_BASENAME.toLowerCase());
  });

  test('a real project dir name is preserved as the service alias', async () => {
    parent = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-container-topology-'));
    projectPath = path.join(parent, 'zerac-ui');
    fs.mkdirSync(projectPath);
    fs.writeFileSync(path.join(projectPath, 'Dockerfile'), 'FROM node:22-alpine\nEXPOSE 3000\nCMD ["node", "server.js"]\n');

    const analyzer = new DockerfileAnalyzer();
    const contribution = await analyzer.analyze({ projectPath });
    const node = (contribution.nodes ?? []).find(n => n.type === 'container_image_definition');
    expect((node!.metadata as any).service_aliases).toEqual(['zerac-ui']);
  });
});
