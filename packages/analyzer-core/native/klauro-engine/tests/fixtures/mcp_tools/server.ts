import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new McpServer({ name: 'demo', version: '1.0.0' });

async function handleFindTests(args: unknown) {
  return { content: [] };
}

server.registerTool('find_tests', { description: 'Finds tests' }, handleFindTests);

server.tool('say_hello', async () => {
  return { content: [{ type: 'text', text: 'hi' }] };
});

const lowLevel = new Server({ name: 'low', version: '1.0.0' }, { capabilities: { tools: {} } });

async function handleGreeting() {
  return { content: [] };
}

lowLevel.setRequestHandler(CallToolRequestSchema, async (request) => {
  switch (request.params.name) {
    case 'greet':
      return handleGreeting();
    case 'list_items':
      return { content: [] };
    default:
      throw new Error('unknown tool');
  }
});
