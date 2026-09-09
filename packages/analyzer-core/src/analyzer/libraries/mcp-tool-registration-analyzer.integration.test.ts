import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { AnalyzerOrchestrator } from '../core/orchestrator';
import { TypeScriptJavaScriptAnalyzer } from '../languages/typescript-javascript-analyzer';
import { McpToolRegistrationAnalyzer } from './mcp-tool-registration-analyzer';
import type { SystemCapability } from '../../types/cas.types';
import { projectCapabilityCatalogPromptEvidence } from '../core/capability-catalog-prompt-evidence';

test('through-product: asserted MCP config preserves the authored contract for catalog grounding', async () => {
  const fixtureDir = await writeFixture();
  const description = 'Upload a filtered source snapshot for hosted Klauro analysis. The installed MCP server never parses or builds CAS locally.';
  try {
    await fs.writeFile(path.join(fixtureDir, 'src', 'index.ts'), [
      "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
      "const server = new McpServer({ name: 'fixture-server', version: '1.0.0' });",
      "server.registerTool(",
      "  'analyze_codebase',",
      "  {",
      "    title: 'Analyze Codebase',",
      "    description: " + JSON.stringify(description) + ",",
      "    inputSchema: { path: { description: 'An input path, not the tool contract' } } as any,",
      "  } as any,",
      "  async ({ path }: any) => uploadSnapshot(path),",
      ");",
    ].join('\n'));
    const output = await createPipelineOrchestrator().orchestrateAnalysis(fixtureDir);
    const node = output.nodes.find(item => item.type === 'mcp_tool' && item.name === 'analyze_codebase');
    const entry = output.entry_points?.find(item => item.name === 'analyze_codebase' && item.source_node === node?.id);
    assert.ok(node);
    assert.ok(entry);
    assert.equal(node.documentation?.raw, description);
    assert.equal(node.documentation?.location.start_line, 7);
    assert.equal(node.documentation?.location.end_line, 7);
    const candidate: SystemCapability = {
      id: 'analysis-surface', name: 'Analysis surface', description: '', category: 'supporting',
      criticality: 'medium', criticality_factors: [], related_entities: [], related_domains: [],
      operations: [{ entry_point_id: entry.id, entry_point_type: entry.type, action: entry.name }],
    };
    const nodes = new Map(output.nodes.map(item => [item.id, item]));
    const entries = new Map((output.entry_points || []).map(item => [item.id, item]));
    const evidence = projectCapabilityCatalogPromptEvidence(candidate, nodes, entries);
    assert.deepEqual(evidence.declared_contracts, [{
      entry_point_id: entry.id, source_node_id: node.id, text: description, example_blocks_omitted: 0,
    }]);
  } finally {
    await fs.remove(fixtureDir);
  }
});

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
