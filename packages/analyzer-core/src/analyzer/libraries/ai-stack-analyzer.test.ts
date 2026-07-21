import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import { AIStackAnalyzer } from './ai-stack-analyzer';

async function makeFixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-stack-fixture-'));

  await fs.writeJson(path.join(dir, 'package.json'), {
    name: 'ai-fixture',
    dependencies: {
      ai: '^4.0.0',
      '@modelcontextprotocol/sdk': '^1.0.0',
      '@pinecone-database/pinecone': '^3.0.0',
    },
  });

  // Vercel AI SDK: generateText + tool definition.
  await fs.writeFile(
    path.join(dir, 'agent.ts'),
    `import { generateText, tool } from 'ai';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';

export async function run() {
  const result = await generateText({
    model: openai('gpt-4o'),
    prompt: 'What is the weather?',
    tools: {
      getWeather: tool({
        description: 'Get the weather',
        parameters: z.object({ city: z.string() }),
        execute: async ({ city }) => ({ temp: 72, city }),
      }),
    },
  });
  return result;
}
`
  );

  // MCP server with a registered tool.
  await fs.writeFile(
    path.join(dir, 'mcp.ts'),
    `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const server = new McpServer({ name: 'search-server', version: '1.0.0' });

server.registerTool('search', { description: 'Search the index' }, async (args) => {
  return { content: [{ type: 'text', text: 'ok' }] };
});
`
  );

  // Vector store: Pinecone init + query.
  await fs.writeFile(
    path.join(dir, 'rag.ts'),
    `import { Pinecone } from '@pinecone-database/pinecone';

const pc = new Pinecone();

export async function search(vec: number[]) {
  const index = pc.index('docs');
  return index.query({ topK: 5, vector: vec });
}
`
  );

  return dir;
}

test('AIStackAnalyzer detects an AI/LLM stack', async () => {
  const dir = await makeFixture();
  try {
    const analyzer = new AIStackAnalyzer();

    assert.equal(await analyzer.canAnalyze(dir), true, 'canAnalyze should be true');

    const result = await analyzer.analyze({ projectPath: dir });
    const nodes = result.nodes;

    const llmCall = nodes.find(n => (n.metadata as any)?.capability === 'llm-call');
    assert.ok(llmCall, 'expected an llm-call node');

    const weatherTool = nodes.find(
      n => (n.metadata as any)?.capability === 'ai-tool' && n.name === 'getWeather'
    );
    assert.ok(weatherTool, 'expected a tool node named getWeather');

    const searchEntry = result.entry_points?.find(e => e.name === 'search');
    assert.ok(searchEntry, "expected an mcp-server tool 'search' entry point");
    assert.equal((searchEntry?.metadata as any)?.mcp, true);

    const mcpServer = nodes.find(n => (n.metadata as any)?.capability === 'mcp-server');
    assert.ok(mcpServer, 'expected an mcp-server node');

    const vectorStore = nodes.find(n => (n.metadata as any)?.capability === 'vector-store');
    assert.ok(vectorStore, 'expected a vector-store node');

    // Top-level AI app profile signal.
    const profile = (result.analyzer_metadata as any)?.aiAppProfile;
    assert.ok(profile, 'expected aiAppProfile signal');
    assert.equal(profile.isAIApp, true);
    assert.equal(profile.isMCPServer, true);
    assert.equal(profile.isRAGApp, true);
    assert.ok(profile.llmCalls >= 1);
    assert.ok(profile.mcpTools >= 1);

    // Capability model literal capture.
    const modeled = nodes.find(n => (n.metadata as any)?.model === 'gpt-4o');
    assert.ok(modeled, 'expected a node with captured model gpt-4o');
  } finally {
    await fs.remove(dir);
  }
});

// ---------------------------------------------------------------------------
// Test-file exclusion regression (scaffold-paths.ts isTestFileName)
// ---------------------------------------------------------------------------
//
// Open finding from the fixture-pollution audit: "ai-stack-analyzer scans
// test files with no exclusion" — a co-located `*.test.ts`/`*.spec.ts` file
// lives OUTSIDE any fixtures/__tests__ directory, so directory-name exclusion
// (getIgnorePatterns) alone does not catch it; a unit test exercising the
// analyzer's own AI-SDK detection (e.g. `agent.test.ts` calling
// `generateText(...)` to assert on mocked output) must not itself register as
// a product AI-app node/entry point.
test('AIStackAnalyzer.analyze does not mint nodes/entry points from a co-located *.test.ts file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-stack-testfile-'));
  try {
    await fs.writeJson(path.join(dir, 'package.json'), { name: 'plain-app', dependencies: {} });
    // A unit test file (not under any fixtures/__tests__ directory) that
    // exercises AI-SDK-shaped code — this is TEST code, not a product AI
    // surface.
    await fs.writeFile(
      path.join(dir, 'agent.test.ts'),
      `import { generateText } from 'ai';
test('calls generateText', async () => {
  await generateText({ model: 'gpt-4o', prompt: 'hi' });
});
`
    );

    const analyzer = new AIStackAnalyzer();
    const result = await analyzer.analyze({ projectPath: dir });
    assert.equal(result.nodes.length, 0, `expected zero nodes from a *.test.ts-only tree, got: ${JSON.stringify(result.nodes.map(n => n.name))}`);
    assert.equal((result.entry_points || []).length, 0, 'expected zero entry points');

    const relevant = await analyzer.getRelevantFiles(dir);
    assert.deepEqual(relevant, [], 'getRelevantFiles must not surface the co-located test file');
  } finally {
    await fs.remove(dir);
  }
});

// ---------------------------------------------------------------------------
// Comment-blanking regression (base-analyzer.ts blankComments)
// ---------------------------------------------------------------------------
//
// This analyzer runs its own independent `.registerTool`/`.tool(` regex pass
// (the "MCP tools (registered handlers — HIGH value)" section of scanFile) —
// a SEPARATE extraction from mcp-tool-registration-analyzer.ts's dedicated
// one. mcp-tool-registration-analyzer.ts already blanks comments before
// scanning (quality-iter-1 #8 / quality-iter-2) so a JSDoc/line-comment
// documenting the call shape (e.g. its own header illustrating
// `server.tool('do_thing', schema, handler)`) is never mistaken for a real
// registration — but this analyzer's copy of the same regex ran unblanked,
// so a detector-source-like file (real source containing a doc-comment
// example of an MCP registration call, not a real call) still yielded a
// `do_thing` mcp-tool node/entry point through THIS pass even after the
// other analyzer's fix landed.
test('AIStackAnalyzer does not extract an MCP tool registration written inside a comment', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-stack-comment-'));
  try {
    await fs.writeJson(path.join(dir, 'package.json'), {
      name: 'comment-fixture',
      dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' },
    });
    await fs.writeFile(
      path.join(dir, 'detector-source-like.ts'),
      [
        '/**',
        ' * Example usage:',
        " *   server.tool('do_thing', schema, handler)   // JSDoc example, not real code",
        ' */',
        "// server.registerTool('also_commented_out', {}, async () => ({}));",
        'export const marker = 1;',
        '',
      ].join('\n')
    );

    const analyzer = new AIStackAnalyzer();
    const result = await analyzer.analyze({ projectPath: dir });
    assert.equal(
      result.nodes.find(n => (n.metadata as any)?.capability === 'mcp-tool' && n.name === 'do_thing'),
      undefined,
      'JSDoc example must not be extracted'
    );
    assert.equal(
      result.nodes.find(n => (n.metadata as any)?.capability === 'mcp-tool' && n.name === 'also_commented_out'),
      undefined,
      'line-commented-out call must not be extracted'
    );
    assert.equal((result.entry_points || []).length, 0, 'expected zero entry points from comment-only content');
  } finally {
    await fs.remove(dir);
  }
});
