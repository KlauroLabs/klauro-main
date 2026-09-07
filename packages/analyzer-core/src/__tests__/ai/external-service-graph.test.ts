import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';
import type { CASExitPoint, CASNode } from '../../types/cas.types';

const node = (id: string, analyzers?: string[]): CASNode => ({ id, name: id, type: 'function', analyzers });
const exit = (id: string, source: string, service = 'Remote Model'): CASExitPoint => ({
  id, source_node: source, type: 'api', name: service, target: { service_id: service },
});
const library = (name: string, version = '1') => ({ name, version });
const build = (nodes: CASNode[], exits: CASExitPoint[], libraries: ReturnType<typeof library>[]) =>
  (new AnalyzerOrchestrator() as any).buildExternalServices(nodes, exits, libraries);

test('external services preserve the first matching node when IDs repeat', () => {
  const exits = [exit('call', 'duplicate')];
  const libraries = [library('openai')];
  const unqualified = build([node('duplicate'), node('duplicate', ['OpenAI'])], exits, libraries);
  expect(unqualified.map((service: any) => [service.id, service.type])).toEqual([
    ['ext_remote_model', 'api'], ['ext_openai', 'ai_provider'],
  ]);
  const qualified = build([node('duplicate', ['OpenAI']), node('duplicate')], exits, libraries);
  expect(qualified).toHaveLength(1);
  expect(qualified[0]).toMatchObject({ id: 'ext_remote_model', type: 'ai_provider', name: 'OpenAI' });
});

test('external services tolerate missing nodes and analyzers without inventing connections', () => {
  const services = build([node('plain')], [exit('missing-call', 'missing'), exit('plain-call', 'plain')], [
    library('openai'), library('@anthropic-ai/sdk'),
  ]);
  expect(services.map((service: any) => service.id)).toEqual(['ext_remote_model', 'ext_openai', 'ext_anthropic']);
  expect(services[0].connected_nodes).toEqual(['missing', 'plain']);
  expect(services[1].connected_nodes).toBeUndefined();
  expect(services[2].connected_nodes).toBeUndefined();
});

test('external services preserve ordered provider selection and repeated library updates', () => {
  const services = build(
    [node('both', ['OPENAI', 'Anthropic']), node('second', ['openai'])],
    [exit('first', 'both'), exit('other', 'second', 'Second Remote'), exit('first', 'both')],
    [library('openai'), library('@anthropic-ai/sdk'), library('openai', '2')],
  );
  expect(services.map((service: any) => service.id)).toEqual(['ext_remote_model', 'ext_second_remote']);
  expect(services[0]).toMatchObject({
    name: 'OpenAI', type: 'ai_provider', configuration: { library: 'openai', version: '2' },
    connected_nodes: ['both'], exit_points: ['first', 'first'],
  });
  expect(services[1]).toMatchObject({ name: 'Second Remote', type: 'api', connected_nodes: ['second'] });
});

test('external service node lookup is local to each build', () => {
  const orchestrator = new AnalyzerOrchestrator() as any;
  const exits = [exit('call', 'reused')];
  const libraries = [library('openai')];
  expect(orchestrator.buildExternalServices([node('reused', ['openai'])], exits, libraries)).toHaveLength(1);
  expect(orchestrator.buildExternalServices([node('reused')], exits, libraries)).toHaveLength(2);
});

test('external service grouping preserves database and cache connection and exit order', () => {
  const database = { ...exit('db-1', 'a'), type: 'database', name: 'Orders', target: { service_id: 'orders' } } as CASExitPoint;
  const cache = { ...exit('cache-1', 'b'), type: 'cache' } as CASExitPoint;
  const services = build([], [database, cache, { ...database, id: 'db-2', source_node: 'c' }, database], []);
  expect(services.map((service: any) => service.id)).toEqual(['ext_orders', 'ext_redis_cache']);
  expect(services[0]).toMatchObject({ connected_nodes: ['a', 'c'], exit_points: ['db-1', 'db-2', 'db-1'] });
  expect(services[1]).toMatchObject({ connected_nodes: ['b'], exit_points: ['cache-1'] });
});
