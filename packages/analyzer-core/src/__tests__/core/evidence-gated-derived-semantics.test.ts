import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';
import type { CASNode } from '../../types/cas.types';

describe('evidence-gated derived semantics', () => {
  const orchestrator = new AnalyzerOrchestrator() as any;
  const node = (input: Partial<CASNode> & Pick<CASNode, 'id' | 'name' | 'type'>): CASNode => input as CASNode;

  it('does not classify production lifecycle middleware as a test fixture', () => {
    const productionBefore = node({
      id: 'production_before',
      name: 'before',
      type: 'function',
      source: { file: 'controllers/user/index.js' },
    });
    const testBefore = node({
      id: 'test_before',
      name: 'before',
      type: 'function',
      source: { file: 'tests/user.test.js' },
    });
    const fixtures = orchestrator.buildFixtures([productionBefore, testBefore]);
    expect(fixtures.map((fixture: { id: string }) => fixture.id)).toEqual(['fixture_test_before']);
  });

  it('does not infer authentication from a generic session variable', () => {
    const session = node({
      id: 'session_state',
      name: 'session',
      type: 'variable',
      source: { file: 'app.js' },
    });
    expect(orchestrator.buildSecurityContexts([session], [], [])).toEqual([]);
  });

  it('retains authentication context when enforcement evidence exists', () => {
    const guard = node({
      id: 'api_key_guard',
      name: 'ApiKeyGuard',
      type: 'guard',
      source: { file: 'security/api-key.ts' },
    });
    const contexts = orchestrator.buildSecurityContexts([guard], [], []);
    expect(contexts.find((context: { id: string }) => context.id === 'security_ctx_authentication')?.scope.node_ids)
      .toContain('api_key_guard');
  });

  it('does not project an in-memory domain model into database schema', () => {
    const inMemoryModel = node({
      id: 'pet_model',
      name: 'Pet',
      type: 'model',
      subcategories: ['domain-shape', 'in-memory-store'],
      metadata: { attributes: { record_sequence: 'pets' } },
    });
    const persistedModel = node({
      id: 'account_model',
      name: 'Account',
      type: 'model',
      metadata: { attributes: { collection: 'accounts' } },
    });
    expect(orchestrator.buildDatabaseSchema([inMemoryModel], []).entities).toEqual([]);
    expect(orchestrator.buildDatabaseSchema([persistedModel], []).entities.map((entity: { name: string }) => entity.name))
      .toEqual(['Account']);
  });
});
