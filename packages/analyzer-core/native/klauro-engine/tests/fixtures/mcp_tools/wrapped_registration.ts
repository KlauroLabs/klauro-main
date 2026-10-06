import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

declare function withGuard<T>(register: T): T;
declare function pushRecord(record: unknown): Promise<void>;

export function createServer(): McpServer {
  const server = new McpServer({ name: 'wrapped', version: '1.0.0' });
  const registerGuarded = withGuard(server.registerTool.bind(server) as any);
  const register = ((name: string, ...args: any[]) => {
    if (!name) throw new Error('unnamed tool');
    return registerGuarded(name, ...args);
  }) as typeof registerGuarded;

  register('push_record', { description: 'Pushes a record' }, async ({ record }: any) => {
    await pushRecord(record);
    return { content: [] };
  });

  return server;
}

export function unrelated(register: (name: string, handler: () => void) => void) {
  register('not_a_tool_either', () => {});
}
