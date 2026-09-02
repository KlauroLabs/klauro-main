import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';

const node = (id: string, name: string, type: string, file: string) => ({
  id,
  name,
  type,
  source: { file, line: 1 },
  metadata: {},
});

describe('architecture system type uses dominant MCP entry evidence', () => {
  const orchestrator = new AnalyzerOrchestrator() as any;

  it('does not classify an HTTP frontend as an MCP server from an incidental mcp path', () => {
    const nodes = [
      node('controller', 'MemoController', 'controller', 'server/memo.go'),
      node('page', 'MemoPage', 'component', 'web/src/pages/MemoPage.tsx'),
      node('adapter', 'ProtocolAdapter', 'class', 'internal/mcp/adapter.go'),
    ];
    const entryPoints = [{
      id: 'memo-http',
      type: 'http',
      name: 'GET /memos',
      source_node: 'controller',
      handler: { node_id: 'controller', file: 'server/memo.go' },
      trigger: { method: 'GET', path: '/memos' },
    }];

    const summary = orchestrator.buildArchitectureSummary(nodes, entryPoints, [], []);

    expect(summary.system_type).toBe('HTTP service');
    expect(summary.system_type).not.toBe('MCP server');
  });

  it('recognizes a small MCP server from its actual message/tool surface', () => {
    const nodes = [
      node('tool', 'get_context', 'mcp_tool', 'src/server.ts'),
    ];
    const entryPoints = [{
      id: 'tool-entry',
      type: 'message',
      name: 'get_context',
      source_node: 'tool',
      trigger: { method: 'registerTool', path: 'get_context' },
    }];

    const summary = orchestrator.buildArchitectureSummary(nodes, entryPoints, [], []);

    expect(summary.system_type).toBe('MCP server');
  });

  it('uses every nested package manifest for monorepo identity without depth or count truncation', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-system-name-'));
    try {
      for (let index = 0; index < 505; index += 1) {
        const directory = path.join(root, 'packages', `package-${index}`);
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: `@acme/package-${index}` }));
      }
      const deepDirectory = path.join(root, ...Array.from({ length: 12 }, (_, index) => `level-${index}`));
      fs.mkdirSync(deepDirectory, { recursive: true });
      fs.writeFileSync(path.join(deepDirectory, 'package.json'), JSON.stringify({ name: '@acme/deep-package' }));

      const manifests = orchestrator.collectNestedPackageJsonFiles(root)
        .map((file: string) => path.relative(root, file).replace(/\\/g, '/'));

      expect(manifests).toHaveLength(506);
      expect(manifests).toContain(`${Array.from({ length: 12 }, (_, index) => `level-${index}`).join('/')}/package.json`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
