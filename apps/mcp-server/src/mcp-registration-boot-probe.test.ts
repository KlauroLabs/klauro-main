import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { probeMcpBoot } from './mcp-registration-doctor';

function entryFile(source: string): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-boot-probe-'));
  const file = path.join(folder, 'entry.js');
  fs.writeFileSync(file, source);
  return file;
}

test('an entry that answers the MCP initialize handshake without a grammar line is healthy', async () => {
  const entry = entryFile(`
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      const message = JSON.parse(chunk.split('\\n')[0]);
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { serverInfo: { name: 'fake' } } }) + '\\n');
    });
    process.stdin.on('end', () => process.exit(0));
  `);
  const result = await probeMcpBoot({ entryPath: entry, maxMs: 4000 });
  assert.equal(result.status, 'ok');
});

test('an entry that exits cleanly without speaking MCP or reporting grammars still warns', async () => {
  const entry = entryFile('process.exit(0);');
  const result = await probeMcpBoot({ entryPath: entry, maxMs: 4000 });
  assert.equal(result.status, 'warn');
});
