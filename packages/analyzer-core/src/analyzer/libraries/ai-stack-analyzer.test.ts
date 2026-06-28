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
