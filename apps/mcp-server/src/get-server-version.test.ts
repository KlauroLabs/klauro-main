import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from './server';
import { getBuildIdentity } from '../../../packages/analyzer-core/src/analyzer/core/build-identity';

function getToolHandler(server: ReturnType<typeof createServer>, name: string): (args: any) => Promise<any> {
  const registered = (server as any)._registeredTools[name];
  return registered.callback ?? registered.handler;
}

/**
 * Verifies the get_server_version MCP wiring: an agent should be able to call
 * this to detect a stale MCP build (the #1 recurring "tool not found" pain
 * when a subagent is talking to a pre-release dist). Asserts the handler
 * reuses getBuildIdentity() as the single source of truth for current_version
 * and degrades gracefully (never throws) when the release manifest is
 * unreachable, as it will be in this test environment.
 */
test('get_server_version reports current_version from getBuildIdentity and handles an unreachable manifest gracefully', async () => {
  const server = createServer();
  const handler = getToolHandler(server, 'get_server_version');
  // Point at an unroutable host (TEST-NET-1, RFC 5737) via the tool's own
  // override param so the manifest fetch fails fast and deterministically,
  // instead of depending on which env vars normalizeServerUrl happens to read.
  const result = await handler({ server_url: 'http://192.0.2.1:1' });

  assert.ok(!result.isError, `expected success, got ${JSON.stringify(result)}`);
  const payload = JSON.parse(result.content[0].text);

  assert.equal(payload.current_version, getBuildIdentity().version);
  assert.ok(payload.current_version, 'current_version should be non-null');
  assert.equal(payload.update_command, 'klauro update');
  assert.equal(payload.latest_version, null, 'latest_version should be null when the manifest is unreachable');
  assert.equal(payload.up_to_date, null, 'up_to_date should be null (unknown) when latest_version is null');
  assert.equal(payload.note, 'Could not reach the release manifest.');
});

test('get_server_version is registered as a core tool, always available regardless of profile', () => {
  const previousProfile = process.env.KLAURO_TOOL_PROFILE;
  try {
    process.env.KLAURO_TOOL_PROFILE = 'core';
    const server = createServer();
    assert.ok((server as any)._registeredTools['get_server_version'], 'get_server_version should be directly registered under the core profile');
  } finally {
    if (previousProfile === undefined) delete process.env.KLAURO_TOOL_PROFILE;
    else process.env.KLAURO_TOOL_PROFILE = previousProfile;
  }
});
