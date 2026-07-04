import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { McpToolRegistrationAnalyzer } from './mcp-tool-registration-analyzer';

async function makeProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-tool-registration-analyzer-test-'));
  await fs.writeJson(path.join(dir, 'package.json'), {
    name: 'mcp-server-fixture',
    dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' }
  });

  const srcDir = path.join(dir, 'src');
  await fs.ensureDir(srcDir);

  await fs.writeFile(path.join(srcDir, 'server.ts'), [
    "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
    "import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';",
    '',
    "const server = new McpServer({ name: 'fixture', version: '1.0.0' });",
    '',
    'async function doThingHandler(args: unknown) {',
    "  return { content: [{ type: 'text', text: 'done' }] };",
    '}',
    '',
    "server.registerTool('do_thing', {",
    "  description: 'Does the thing',",
    '  inputSchema: { type: \'object\' },',
    '}, doThingHandler);',
    '',
    "server.tool('get_summary', 'Gets a summary', async (args) => {",
    "  return { content: [{ type: 'text', text: 'summary' }] };",
    '});',
    '',
    'server.setRequestHandler(ListToolsRequestSchema, async () => {',
    '  return { tools: [] };',
    '});',
    '',
  ].join('\n'));

  return dir;
}

test('McpToolRegistrationAnalyzer extracts registerTool, tool shorthand, and setRequestHandler calls', async () => {
  const dir = await makeProject();
  try {
    const analyzer = new McpToolRegistrationAnalyzer();

    assert.equal(await analyzer.canAnalyze(dir), true, 'should detect MCP tool registrations');

    const result = await analyzer.analyze({ projectPath: dir });

    const doThing = result.nodes.find(n => n.type === 'mcp_tool' && n.name === 'do_thing');
    assert.ok(doThing, 'do_thing node exists');
    assert.equal(doThing!.metadata?.attributes?.registrationKind, 'registerTool');
    assert.equal(doThing!.metadata?.attributes?.receiver, 'server');
    assert.equal(doThing!.metadata?.attributes?.nameSource, 'string-literal');
    assert.ok(doThing!.source?.file?.endsWith('server.ts'), 'file path recorded');
    assert.equal(doThing!.source?.line, 10, 'line number points at the registerTool call');

    const getSummary = result.nodes.find(n => n.type === 'mcp_tool' && n.name === 'get_summary');
    assert.ok(getSummary, 'get_summary node exists (tool shorthand)');
    assert.equal(getSummary!.metadata?.attributes?.registrationKind, 'tool');

    const listTools = result.nodes.find(n => n.type === 'mcp_tool' && n.name === 'ListToolsRequestSchema');
    assert.ok(listTools, 'setRequestHandler best-effort node exists');
    assert.equal(listTools!.metadata?.attributes?.registrationKind, 'setRequestHandler');
    assert.equal(listTools!.metadata?.attributes?.nameSource, 'schema-identifier');

    // Every registration should also produce a corresponding entry point,
    // which is what makes it discoverable via get_entry_points/search alongside nodes.
    assert.equal(result.entry_points.length, 3);
    const names = result.entry_points.map(e => e.name).sort();
    assert.deepEqual(names, ['ListToolsRequestSchema', 'do_thing', 'get_summary']);
  } finally {
    await fs.remove(dir);
  }
});

test('McpToolRegistrationAnalyzer surfaces handlerCallCandidates from inline async handler bodies', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-tool-registration-analyzer-inline-'));
  try {
    await fs.writeJson(path.join(dir, 'package.json'), {
      name: 'mcp-server-inline-fixture',
      dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' }
    });
    await fs.ensureDir(path.join(dir, 'src'));
    await fs.writeFile(path.join(dir, 'src', 'server.ts'), [
      "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
      "import * as query from './query';",
      '',
      "const server = new McpServer({ name: 'fixture', version: '1.0.0' });",
      '',
      "server.registerTool('get_summary', {",
      "  inputSchema: { type: 'object' },",
      "}, async ({ path }) => {",
      '  const cas = await getFreshAnalysisForAgent(path);',
      '  return json(query.buildSummary(cas));',
      '});',
      '',
    ].join('\n'));

    const analyzer = new McpToolRegistrationAnalyzer();
    const result = await analyzer.analyze({ projectPath: dir });

    const getSummaryEntry = result.entry_points.find(e => e.name === 'get_summary');
    assert.ok(getSummaryEntry, 'get_summary entry point exists');
    const candidates = (getSummaryEntry as any).metadata?.handlerCallCandidates as string[] | undefined;
    assert.ok(candidates, 'handlerCallCandidates populated for inline handler');
    assert.ok(candidates!.includes('buildSummary'), 'captures bare callee name from qualified call');
    assert.ok(candidates!.includes('query.buildSummary'), 'captures qualified callee name');
    assert.ok(candidates!.includes('getFreshAnalysisForAgent'), 'captures bare function call inside handler body');
  } finally {
    await fs.remove(dir);
  }
});

test('McpToolRegistrationAnalyzer leaves handlerCallCandidates unset when handler is a bare identifier', async () => {
  const dir = await makeProject();
  try {
    const analyzer = new McpToolRegistrationAnalyzer();
    const result = await analyzer.analyze({ projectPath: dir });
    const doThing = result.entry_points.find(e => e.name === 'do_thing');
    assert.ok(doThing, 'do_thing entry exists');
    assert.equal((doThing as any).metadata?.handlerCallCandidates, undefined, 'bare-identifier handler has no candidates (handlerRef already covers it)');
  } finally {
    await fs.remove(dir);
  }
});

test('McpToolRegistrationAnalyzer ignores unrelated .tool() calls on non-server receivers', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-tool-registration-analyzer-negative-'));
  try {
    await fs.writeJson(path.join(dir, 'package.json'), { name: 'unrelated-fixture', dependencies: {} });
    await fs.ensureDir(path.join(dir, 'src'));
    await fs.writeFile(path.join(dir, 'src', 'hammer.ts'), [
      "class Hammer {",
      "  tool(name: string) { return name; }",
      "}",
      "const hammer = new Hammer();",
      "hammer.tool('claw');",
      '',
    ].join('\n'));

    const analyzer = new McpToolRegistrationAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), false, 'should not flag unrelated .tool() usage');
  } finally {
    await fs.remove(dir);
  }
});
