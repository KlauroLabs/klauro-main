import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseCapabilityModelBenchmarkArgs,
  scoreCapabilityModelTrial,
} from './capability-model-benchmark';

test('scores grounded product language above implementation-shaped output', () => {
  const product = scoreCapabilityModelTrial({
    elapsed_ms: 90000,
    primary_domain: 'access-governance',
    system_description: 'Teams request and approve access to protected resources.',
    description_status: 'ai_applied',
    capabilities: [{
      name: 'Manage Access Requests',
      description: 'Gives administrators a clear way to approve or reject resource access requests.',
      category: 'core',
      operations: 4,
      entities: 2,
    }],
  }, 'model-a', 1, 180000);
  const implementation = scoreCapabilityModelTrial({
    elapsed_ms: 250000,
    primary_domain: '',
    system_description: '',
    description_status: 'ai_rejected',
    capabilities: [{
      name: 'API Controller',
      description: 'Lets users API Controller.',
      category: 'core',
      operations: 0,
      entities: 0,
    }],
  }, 'model-b', 1, 180000);
  assert.ok(product.score > implementation.score);
  assert.equal(product.score_components.product_language, 25);
  assert.equal(implementation.score_components.duration, 0);
});

test('parses arbitrary model names without repository-specific defaults', () => {
  const parsed = parseCapabilityModelBenchmarkArgs([
    '--project', '.',
    '--base-url', 'http://model-host/v1',
    '--model', 'first-model',
    '--model', 'second-model',
    '--trials', '3',
  ], {});
  assert.deepEqual(parsed.models.map(model => model.name), ['first-model', 'second-model']);
  assert.equal(parsed.trials, 3);
  assert.equal(parsed.models[0].baseUrl, 'http://model-host/v1');
});
