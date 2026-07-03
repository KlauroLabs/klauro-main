import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { AnalyzerOrchestrator } from '../core/orchestrator';
import { TypeScriptJavaScriptAnalyzer } from '../languages/typescript-javascript-analyzer';
import { McpToolRegistrationAnalyzer } from './mcp-tool-registration-analyzer';

/**
 * THROUGH-PRODUCT verification: this does not call McpToolRegistrationAnalyzer
 * directly. It builds a real AnalyzerOrchestrator, registers the analyzer the
 * same way cas-analyzer.service.ts's registerAnalyzers() does (same
 * AnalyzerRegistration shape, same registerAnalyzer() call), then runs the
 * full orchestrateAnalysis pipeline (detection -> analyzer execution -> node
 * merge) over a fixture MCP-server-like project on disk. This proves the
 * registry wiring works end-to-end, not just that the detector function
 * works in isolation.
 */
function createPipelineOrchestrator(): AnalyzerOrchestrator {
  const orchestrator = new AnalyzerOrchestrator();
  orchestrator.registerAnalyzer({
    id: 'typescript-javascript',
    name: 'TypeScript/JavaScript Analyzer',
    type: 'language',
    version: '1.0.0',
    detectPatterns: {
      files: ['package.json', 'tsconfig.json'],
      content: [/\.ts$/, /\.js$/],
    },
    analyzer: new TypeScriptJavaScriptAnalyzer(),
  });
  orchestrator.registerAnalyzer({
    id: 'mcp-tool-registration',
    name: 'MCP Tool Registration Analyzer',
    type: 'library',
    version: '1.0.0',
    detectPatterns: {
      dependencies: ['@modelcontextprotocol/sdk'],
      content: [/\.registerTool\s*\(/, /\.setRequestHandler\s*\(/],
    },
    requires: ['typescript-javascript'],
    analyzer: new McpToolRegistrationAnalyzer(),
  });
  return orchestrator;
}

async function writeFixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-mcp-tool-index-fixture-'));
  await fs.writeJson(path.join(dir, 'package.json'), {
    name: 'fixture-mcp-server',
    version: '1.0.0',
    dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' },
  });
  await fs.ensureDir(path.join(dir, 'src'));
  await fs.writeFile(
    path.join(dir, 'src', 'index.ts'),
    [
      "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
      '',
      "const server = new McpServer({ name: 'fixture-server', version: '1.0.0' });",
      '',
      'async function doThingHandler() {',
      "  return { content: [{ type: 'text', text: 'did the thing' }] };",
      '}',
      '',
      "server.registerTool('do_thing', {",
      "  description: 'Does the thing',",
      '  inputSchema: { type: \'object\', properties: {} },',
      '}, doThingHandler);',
      '',
    ].join('\n'),
  );
  return dir;
}

test('through-product: orchestrateAnalysis surfaces registerTool literal as a searchable node', async () => {
  const fixtureDir = await writeFixture();
  try {
    const orchestrator = createPipelineOrchestrator();
    const output = await orchestrator.orchestrateAnalysis(fixtureDir);

    // Simulates what search_nodes('do_thing') would find: a node whose name
    // is the literal tool name registered via server.registerTool(...).
    const toolNode = output.nodes.find(n => n.type === 'mcp_tool' && n.name === 'do_thing');
    assert.ok(toolNode, 'CAS output contains an mcp_tool node named do_thing');
    assert.match(toolNode!.source?.file || '', /src[\/\\]index\.ts$/);
    assert.equal(toolNode!.metadata?.attributes?.registrationKind, 'registerTool');

    // Also discoverable via entry points (get_entry_points / route-table style tools).
    const entryPoint = output.entry_points?.find(e => e.name === 'do_thing');
    assert.ok(entryPoint, 'CAS output contains an entry point named do_thing');
  } finally {
    await fs.remove(fixtureDir);
  }
});
