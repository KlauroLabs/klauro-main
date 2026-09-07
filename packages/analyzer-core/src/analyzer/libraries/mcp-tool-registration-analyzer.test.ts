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

// Regression test for quality-iter-1 #8: a documentation EXAMPLE inside this
// analyzer's own JSDoc header (`server.tool('do_thing', schema, handler) //
// McpServer .tool() shorthand`) read exactly like a real registration to the
// plain-text regex scan and got extracted as a genuine mcp_tool entry point
// — one of the three sources feeding the junk "Do Thing" workflow. A
// registration call written INSIDE a comment (line or block) must never be
// extracted; the same call written as real code must still be found.
test('McpToolRegistrationAnalyzer does not extract a registration call written inside a comment', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-tool-registration-analyzer-comment-'));
  try {
    await fs.writeJson(path.join(dir, 'package.json'), {
      name: 'comment-fixture',
      dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' }
    });
    await fs.ensureDir(path.join(dir, 'src'));
    await fs.writeFile(path.join(dir, 'src', 'server.ts'), [
      '/**',
      ' * Example shorthand usage:',
      " *   server.tool('do_thing', schema, handler)   // JSDoc example, not real code",
      ' */',
      "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
      "const server = new McpServer({ name: 'fixture', version: '1.0.0' });",
      '',
      "// server.registerTool('also_commented_out', {}, async () => ({}));",
      '',
      "server.registerTool('real_tool', {", // the only REAL registration in this file
      "  description: 'Real registration',",
      '  inputSchema: { type: \'object\' },',
      '}, async () => ({ content: [] }));',
      '',
    ].join('\n'));

    const analyzer = new McpToolRegistrationAnalyzer();
    const result = await analyzer.analyze({ projectPath: dir });

    assert.equal(result.nodes.find(n => n.type === 'mcp_tool' && n.name === 'do_thing'), undefined, 'JSDoc example must not be extracted');
    assert.equal(result.nodes.find(n => n.type === 'mcp_tool' && n.name === 'also_commented_out'), undefined, 'line-commented-out call must not be extracted');
    assert.ok(result.nodes.find(n => n.type === 'mcp_tool' && n.name === 'real_tool'), 'real registration is still extracted');
  } finally {
    await fs.remove(dir);
  }
});

async function makeDescriptionProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-tool-registration-descriptions-'));
  await fs.writeJson(path.join(dir, 'package.json'), { name: 'mcp-desc-fixture', dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' } });
  await fs.ensureDir(path.join(dir, 'src'));
  await fs.writeFile(path.join(dir, 'src', 'server.ts'), [
    "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
    "import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';",
    "const server = new McpServer({ name: 'fixture', version: '1.0.0' });",
    'const dynamicText = process.env.DESC || "x";',
    "server.registerTool('escaped_tool', {",
    "  title: 'Escaped',",
    "  description: 'Reads the user\\'s \"profile\"; never writes.\\nSecond line kept.',",
    "  inputSchema: { type: 'object' },",
    '}, async () => ({ content: [] }));',
    "server.registerTool('template_tool', {",
    '  description: `Multi',
    'line template',
    '  with indentation`,',
    '}, async () => ({ content: [] }));',
    "server.registerTool('dynamic_tool', { description: dynamicText }, async () => ({ content: [] }));",
    "server.registerTool('interpolated_tool', { description: `Reads ${dynamicText}` }, async () => ({ content: [] }));",
    "server.registerTool('nodesc_tool', { inputSchema: { type: 'object' } }, async () => ({ content: [] }));",
    "server.tool('positional_tool', 'Lists things, paginated.', { type: 'object' }, async () => ({ content: [] }));",
    "server.tool('schema_first_tool', { type: 'object' }, async () => ({ content: [] }));",
    "server.tool('dynamic_positional', dynamicText, async () => ({ content: [] }));",
    "server.tool('positional_tool', 'Lists things, paginated.', { type: 'object' }, async () => ({ content: [] }));",
    'server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));',
    '',
  ].join('\n'));
  return dir;
}

test('McpToolRegistrationAnalyzer preserves literal registration descriptions verbatim with provenance', async () => {
  const dir = await makeDescriptionProject();
  try {
    const analyzer = new McpToolRegistrationAnalyzer();
    const result = await analyzer.analyze({ projectPath: dir } as any);
    const byName = new Map(result.nodes.map(node => [node.name, node]));
    const entryByName = new Map(result.entry_points.map(entry => [entry.name, entry]));

    const escaped = byName.get('escaped_tool')!;
    assert.equal(escaped.description, 'Reads the user\'s "profile"; never writes.\nSecond line kept.');
    assert.equal(escaped.description_source, 'deterministic');
    assert.equal(escaped.documentation?.raw, escaped.description);
    assert.equal(escaped.documentation?.summary, 'Reads the user\'s "profile"; never writes.');
    assert.equal((escaped.metadata as any).attributes.descriptionSource, 'string-literal');
    assert.equal((escaped.metadata as any).attributes.descriptionLine, 7);
    assert.equal(entryByName.get('escaped_tool')!.description, escaped.description);
    assert.equal((entryByName.get('escaped_tool')!.metadata as any).descriptionLine, 7);

    const template = byName.get('template_tool')!;
    assert.equal(template.description, 'Multi\nline template\n  with indentation');
    assert.equal((template.metadata as any).attributes.descriptionSource, 'template-literal');

    for (const [name, expected] of [['dynamic_tool', 'dynamic'], ['interpolated_tool', 'dynamic'], ['nodesc_tool', 'absent'], ['schema_first_tool', 'absent'], ['dynamic_positional', 'dynamic']] as const) {
      const node = byName.get(name)!;
      assert.ok(node, `${name} extracted`);
      assert.equal((node.metadata as any).attributes.descriptionSource, expected, name);
      assert.equal(node.description_source, undefined, `${name} has no authored description`);
      assert.equal(node.documentation, undefined, `${name} has no documentation record`);
      assert.match(node.description || '', /^MCP tool registration: /);
      assert.equal(entryByName.get(name)!.description, undefined);
    }

    const positional = result.nodes.filter(node => node.name === 'positional_tool');
    assert.equal(positional.length, 2, 'each registration call site is its own record, no merging and no double counting');
    assert.ok(positional.every(node => node.description === 'Lists things, paginated.'));
    assert.equal(new Set(positional.map(node => node.id)).size, 2);

    const listTools = byName.get('ListToolsRequestSchema')!;
    assert.equal((listTools.metadata as any).attributes.descriptionSource, 'absent');
    assert.equal(listTools.description_source, undefined);
  } finally {
    await fs.remove(dir);
  }
});

async function makeReviewProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-tool-registration-review-'));
  await fs.writeJson(path.join(dir, 'package.json'), { name: 'mcp-review-fixture', dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' } });
  await fs.ensureDir(path.join(dir, 'src'));
  await fs.writeFile(path.join(dir, 'src', 'server.ts'), [
    "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
    "const server = new McpServer({ name: 'fixture', version: '1.0.0' });",
    "const dynamicValue = process.env.X || 'y';",
    "const config = { description: 'from config' };",
    "server.registerTool('nested_only', { inputSchema: { description: 'An input field' } }, async () => ({ content: [] }));",
    "server.registerTool('concat', { description: 'Reads ' + dynamicValue }, async () => ({ content: [] }));",
    "server.registerTool('spread_after', { description: 'A', ...config }, async () => ({ content: [] }));",
    "server.registerTool('spread_before', { ...config, description: 'B' }, async () => ({ content: [] }));",
    "server.registerTool('spread_only', { ...config }, async () => ({ content: [] }));",
    "server.registerTool('dup_last', { description: 'first', title: 't', description: 'last' }, async () => ({ content: [] }));",
    "server.registerTool('quoted_key', { 'description': 'Quoted' }, async () => ({ content: [] }));",
    "server.registerTool('escapes', { description: 'A\\x41\\u{42}\\b\\0end' }, async () => ({ content: [] }));",
    "server.registerTool('shorthand', { description }, async () => ({ content: [] }));",
    "server.registerTool('getter', { get description() { return 'g'; } }, async () => ({ content: [] }));",
    "server.registerTool('multi', {",
    '  description: `line one',
    'line two',
    'line three`,',
    '}, async () => ({ content: [] }));',
    "server.tool('twice', 'first site', async () => ({ content: [] })); server.tool('twice', 'second site', async () => ({ content: [] }));",
    "server.registerTool('text_in_other_prop', { title: \"description: 'not this'\" }, async () => ({ content: [] }));",
    "const key = dynamicValue;",
    "server.registerTool('computed_after', { description: 'A', [key]: dynamicValue }, async () => ({ content: [] }));",
    "server.registerTool('computed_before', { [key]: dynamicValue, description: 'A' }, async () => ({ content: [] }));",
    "server.registerTool('computed_restored', { description: 'A', [key]: dynamicValue, description: 'C' }, async () => ({ content: [] }));",
    "const other = { tool: (..._args: unknown[]) => undefined };",
    "other.tool('foreign', 'Not MCP', async () => ({ content: [] })); server.tool('foreign', 'Actual MCP', async () => ({ content: [] }));",
    "class Holder { server = server; register() { this.server.tool('prop_receiver', 'Property receiver', async () => ({ content: [] })); } }",
    "server",
    "  .tool('multiline_receiver', 'Multiline receiver', async () => ({ content: [] }));",
    '',
  ].join('\n'));
  return dir;
}

test('McpToolRegistrationAnalyzer resolves descriptions structurally: nested keys, concatenation, spreads, duplicates, escapes, end lines, same-line sites', async () => {
  const dir = await makeReviewProject();
  try {
    const result = await new McpToolRegistrationAnalyzer().analyze({ projectPath: dir } as any);
    const nodes = (name: string) => result.nodes.filter(node => node.name === name);
    const one = (name: string) => { const found = nodes(name); assert.equal(found.length, 1, `${name} once`); return found[0]; };
    const source = (node: any) => node.metadata.attributes.descriptionSource;

    assert.equal(source(one('nested_only')), 'absent');
    assert.equal(one('nested_only').description_source, undefined);
    assert.equal(source(one('concat')), 'dynamic');
    assert.equal(one('concat').description_source, undefined);
    assert.equal(source(one('spread_after')), 'dynamic');
    assert.equal(one('spread_before').description, 'B');
    assert.equal(source(one('spread_only')), 'dynamic');
    assert.equal(one('dup_last').description, 'last');
    assert.equal(one('quoted_key').description, 'Quoted');
    assert.equal(one('escapes').description, 'AAB\b\0end');
    assert.equal(source(one('shorthand')), 'dynamic');
    assert.equal(source(one('getter')), 'dynamic');
    assert.equal(source(one('text_in_other_prop')), 'absent');

    const multi = one('multi');
    assert.equal(multi.description, 'line one\nline two\nline three');
    assert.equal(multi.documentation?.location.start_line, 16);
    assert.equal(multi.documentation?.location.end_line, 18);

    const twice = nodes('twice');
    assert.equal(twice.length, 2, 'two same-line registrations are two records');
    assert.equal(new Set(twice.map(node => node.id)).size, 2, 'same-line sites get distinct ids');
    assert.deepEqual(twice.map(node => node.description).sort(), ['first site', 'second site']);
    assert.ok(twice.every(node => /_c\d+$/.test(node.id)), 'shared-line ids carry the call column');
    assert.ok(/_\d+$/.test(one('multi').id) && !/_c\d+$/.test(one('multi').id), 'unshared sites keep the stable id shape');

    assert.equal(source(one('computed_after')), 'dynamic', 'a computed key after the literal may override it');
    assert.equal(one('computed_before').description, 'A', 'a computed key before the literal cannot override it');
    assert.equal(one('computed_restored').description, 'C', 'a later explicit literal restores certainty');
    const foreign = one('foreign');
    assert.equal(foreign.description, 'Actual MCP', 'the same-line foreign receiver does not consume the MCP registration');
    assert.equal(foreign.metadata.attributes.receiver, 'server');
    assert.equal(one('prop_receiver').description, 'Property receiver');
    assert.equal(one('multiline_receiver').description, 'Multiline receiver');
  } finally {
    await fs.remove(dir);
  }
});
