jest.unmock('fs');
jest.unmock('fs-extra');
jest.unmock('glob');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';
import { TypeScriptJavaScriptAnalyzer } from '../../analyzer/languages/typescript-javascript-analyzer';

/**
 * Loop-closure regression for the generic decorator-argument capture (2026-07-05).
 *
 * A hand-rolled route decorator `@Endpoint('/orders', 'GET')` is NOT recognized as a
 * known framework, so before this fix the TS analyzer captured only the bare name
 * (`metadata.attributes.decorators: ["Endpoint"]`) with zero argument text. The
 * `.klaurorc` `conventions.routes` applier then correctly reported `matched: false`
 * ("no argument capture is available for this decorator shape") — it refused to
 * fabricate a path/method it could not see.
 *
 * With generic literal-argument capture, the analyzer now also carries
 * `metadata.attributes.decoratorArgs`, buildAllDecorators lifts it into
 * CASDecorator.parameters, and the applier resolves path_arg/method_arg — so the
 * declared route flips to `matched: true` and a real http entry_point / route_table
 * row is emitted, rooted at the actual handler node. This test runs the REAL
 * orchestrator pipeline (extractor -> language analyzer -> buildAllDecorators ->
 * applyConventions) end to end against an on-disk fixture.
 */
function createOrchestrator(): AnalyzerOrchestrator {
  const orchestrator = new AnalyzerOrchestrator();
  orchestrator.registerAnalyzer({
    id: 'typescript-javascript',
    name: 'TypeScript/JavaScript Analyzer',
    type: 'language',
    version: '1.0.0',
    detectPatterns: {
      files: ['package.json', 'tsconfig.json'],
      content: [/\.ts$/, /\.js$/],
    },
    analyzer: new TypeScriptJavaScriptAnalyzer(),
  });
  return orchestrator;
}

describe('custom @Endpoint route convention resolves its arguments end to end', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-custom-decorator-route-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const write = async (relative: string, content: string) => {
    const full = path.join(root, relative);
    await fs.ensureDir(path.dirname(full));
    await fs.writeFile(full, content);
  };

  it('flips matched:false -> true and emits a route with the resolved path/method', async () => {
    await write('package.json', JSON.stringify({ name: 'custom-router-app', version: '1.0.0' }));
    // A proprietary decorator router — no framework the auto-detectors recognize.
    await write('src/orders.controller.ts', [
      "import { Endpoint } from './framework';",
      '',
      'export class OrdersController {',
      "  @Endpoint('/orders', 'GET')",
      '  listOrders() {',
      "    return [];",
      '  }',
      '}',
    ].join('\n'));
    await write('src/framework.ts', [
      'export function Endpoint(path: string, method: string): MethodDecorator {',
      '  return () => {};',
      '}',
    ].join('\n'));

    const conventions = {
      routes: [{ decorator: '@Endpoint', path_arg: 0, method_arg: 1 }],
    };

    const output = await createOrchestrator().orchestrateAnalysis(root, { conventions });

    // The declared route convention now RESOLVES its arguments (matched: true).
    const routeMatch = (output as any).conventions_applied?.find(
      (m: any) => m.convention_kind === 'route',
    );
    expect(routeMatch).toBeDefined();
    expect(routeMatch.matched).toBe(true);

    // A real http entry_point is emitted with the path/method lifted from the
    // decorator's literal call arguments — not fabricated, not defaulted.
    const httpEntry = (output.entry_points || []).find(
      ep => ep.type === 'http' && ep.trigger?.path === '/orders',
    );
    expect(httpEntry).toBeDefined();
    expect(httpEntry?.trigger?.method).toBe('GET');

    // The handler resolves to the real controller method node.
    const handlerNodeId = httpEntry?.handler?.node_id || (httpEntry as any)?.source_node;
    const handlerNode = (output.nodes || []).find(n => n.id === handlerNodeId);
    expect(handlerNode).toBeDefined();
    expect(['method', 'function']).toContain(handlerNode?.type);

    // route_table is bridged from entry_points and should include the resolved route.
    const routeTableEntry = (output as any).route_table?.find(
      (r: any) => r.path === '/orders' && r.method === 'GET',
    );
    expect(routeTableEntry).toBeDefined();
  }, 30_000);

  it('still refuses to fabricate when the declared arg index is a non-literal (evidence-gated)', async () => {
    await write('package.json', JSON.stringify({ name: 'custom-router-app', version: '1.0.0' }));
    // Path argument is an identifier (a route constant) — not statically evaluable.
    await write('src/orders.controller.ts', [
      "import { Endpoint } from './framework';",
      "import { ORDERS_PATH } from './routes';",
      '',
      'export class OrdersController {',
      '  @Endpoint(ORDERS_PATH, "GET")',
      '  listOrders() {',
      '    return [];',
      '  }',
      '}',
    ].join('\n'));
    await write('src/routes.ts', "export const ORDERS_PATH = '/orders';\n");
    await write('src/framework.ts', 'export function Endpoint(p: string, m: string): MethodDecorator { return () => {}; }\n');

    const conventions = { routes: [{ decorator: '@Endpoint', path_arg: 0, method_arg: 1 }] };
    const output = await createOrchestrator().orchestrateAnalysis(root, { conventions });

    // Decorator present, but path_arg (index 0) is a non-literal identifier — no path
    // resolvable, so NO route is emitted and the match reports it, never fabricated.
    const httpEntry = (output.entry_points || []).find(
      ep => ep.type === 'http' && ep.trigger?.path === '/orders',
    );
    expect(httpEntry).toBeUndefined();
    const routeMatch = (output as any).conventions_applied?.find(
      (m: any) => m.convention_kind === 'route',
    );
    expect(routeMatch).toBeDefined();
    expect(routeMatch.matched).toBe(false);
  }, 30_000);
});
