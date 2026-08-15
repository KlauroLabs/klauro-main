import test from 'node:test';
import assert from 'node:assert/strict';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { assessGeneratedDescriptionQuality, descriptionGenerationAttempts } from './analysis-narrative-enrichment-runner';
import type { DescriptionEnrichmentTarget } from './analysis-usefulness-review';

test('narrative enrichment runner rejects generic generated text even when the target would disappear from the queue', () => {
  const target: DescriptionEnrichmentTarget = {
    target_kind: 'capability',
    target: 'Save Management',
    target_id: 'cap-save',
    priority: 'medium',
    reasons: ['description contains generic structural or marketing phrase'],
    suggested_tool: 'generate_element_description',
    suggested_args: {
      target: 'cap-save',
      target_kind: 'capability',
    },
  };

  const bad = assessGeneratedDescriptionQuality(
    'Save Management helps engineers store and update persistent data structures across different system components before or while executing tasks that involve session state, configuration, or user profile information.',
    target,
    fixtureCas(),
  );

  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'generic-cross-platform-claim');

  const badCrossPlatformClaim = assessGeneratedDescriptionQuality(
    'Save Management handles the storage and retrieval of user sessions, configuration data, and cached content across different platforms and services, ensuring consistent state management for authenticated users and background processes.',
    target,
    fixtureCas(),
  );

  assert.equal(badCrossPlatformClaim.ok, false);
  assert.equal(badCrossPlatformClaim.reason, 'generic-cross-platform-claim');

  const badAgentFiller = assessGeneratedDescriptionQuality(
    'Save Management helps engineers or agents send, read, and format text across different channels and platforms before/while handling document processing and message interactions.',
    target,
    fixtureCas(),
  );

  assert.equal(badAgentFiller.ok, false);
  assert.equal(badAgentFiller.reason, 'generic-cross-platform-claim');

  const badUngroundedTarget = assessGeneratedDescriptionQuality(
    'Session Management lets an agent preserve a named browser automation session so later work can resume with the same open pages, credentials, and task state instead of rebuilding that context from scratch.',
    target,
    fixtureCas(),
  );

  assert.equal(badUngroundedTarget.ok, false);
  assert.equal(badUngroundedTarget.reason, 'target-name-not-grounded');

  const good = assessGeneratedDescriptionQuality(
    'Save Management lets an agent preserve a named browser automation session so later work can resume with the same open pages, credentials, and task state instead of rebuilding that context from scratch.',
    target,
    fixtureCas(),
  );

  assert.equal(good.ok, true);
});

test('narrative enrichment runner retries refreshed targets by stable name after stale ids', () => {
  const target: DescriptionEnrichmentTarget = {
    target_kind: 'capability',
    target: 'MCP Server',
    target_id: 'cap_mcp_server',
    priority: 'high',
    reasons: ['description is weak'],
    suggested_tool: 'generate_element_description',
    suggested_args: {
      target: 'cap_stale_mcp_server',
      target_kind: 'capability',
      instructions: 'Focus on agent-facing MCP value.',
    },
  };

  assert.deepEqual(descriptionGenerationAttempts(target), [
    {
      target: 'cap_stale_mcp_server',
      targetKind: 'capability',
      instructions: 'Focus on agent-facing MCP value.',
    },
    {
      target: 'cap_mcp_server',
      targetKind: 'capability',
      instructions: 'Focus on agent-facing MCP value.',
    },
    {
      target: 'MCP Server',
      targetKind: 'capability',
      instructions: 'Focus on agent-facing MCP value.',
    },
  ]);
});

function fixtureCas(): CASOutput {
  return {
    cas_version: '1.10.0',
    analysis_id: 'analysis-narrative-runner-test',
    analysis_timestamp: new Date().toISOString(),
    system: {
      id: 'system-test',
      name: 'openclaw',
      type: 'application',
      root_path: '/tmp/openclaw',
      description: 'A browser automation workbench for agent sessions.',
    },
    enhanced_system_purpose: {
      primary_type: 'desktop-app',
      primary_domain: 'browser-automation',
      core_concepts: ['browser automation', 'agent session', 'saved state'],
      inferred_description: 'A browser automation workbench that lets agents operate, save, and resume browser sessions with reusable state.',
      description_source: 'ai',
      description_generation: { attempted: true, status: 'ai_generated' },
      confidence: 0.9,
      evidence: [],
      supporting_workflow_ids: [],
    } as any,
    capabilities: [{
      id: 'cap-save',
      name: 'Save Management',
      description: 'execute operations for save management',
      description_source: 'deterministic',
      category: 'core',
      criticality: 'high',
      evidence: [],
    } as any],
    nodes: [],
    edges: [],
    analyzer_contributions: [],
    progressive_levels: { levels: {}, level_definitions: [] } as any,
  };
}
