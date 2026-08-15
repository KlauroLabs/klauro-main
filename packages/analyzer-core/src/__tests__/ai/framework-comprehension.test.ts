import { selectProductFrameworkNames, analyzerTypeMap, FRAMEWORK_APPLICATION_SURFACE_TYPES } from '../../analyzer/core/framework-comprehension';

// Live dogfood defects this gate closes (v1.0.66 re-validation on hosted repos):
//  - Klauro (a TypeScript monorepo) described itself as "built with React, django,
//    and fastapi" — django/fastapi came from Python test FIXTURES and from the
//    klauro-sdk-py telemetry SDK's ADAPTER middleware, not from being a django/
//    fastapi app.
//  - Library-analyzer CATEGORY labels ("authentication and authorization",
//    "validation schema contract") leaked in as "frameworks".

const productPathPredicate = (node: any): boolean => {
  const file = String(node.source?.file || '').toLowerCase();
  if (/(^|\/)(fixtures?|__fixtures__|testdata|__tests__|tests?|spec|e2e)(\/|$)/.test(file)) return false;
  if (/\.(test|spec)\.[a-z0-9]+$/.test(file)) return false;
  return true;
};

const contributions = [
  { analyzer_id: 'react', analyzer_type: 'framework', analyzer_name: 'React Analyzer' },
  { analyzer_id: 'node-http', analyzer_type: 'framework', analyzer_name: 'Node.js Raw HTTP Analyzer' },
  { analyzer_id: 'django', analyzer_type: 'framework', analyzer_name: 'Django Framework Analyzer' },
  { analyzer_id: 'fastapi', analyzer_type: 'framework', analyzer_name: 'FastAPI Framework Analyzer' },
  { analyzer_id: 'jest', analyzer_type: 'framework', analyzer_name: 'Jest Analyzer' },
  { analyzer_id: 'ruby', analyzer_type: 'language', analyzer_name: 'Ruby Analyzer' },
  { analyzer_id: 'auth', analyzer_type: 'library', analyzer_name: 'Auth Library Analyzer' },
  { analyzer_id: 'validation-schema-contracts', analyzer_type: 'library', analyzer_name: 'Validation Schema Contracts' },
  { analyzer_id: 'cron', analyzer_type: 'library', analyzer_name: 'Cron Analyzer' },
];

describe('selectProductFrameworkNames — comprehension framework gate', () => {
  it('keeps framework-analyzer frameworks with a real application surface, drops adapter shims and category labels', () => {
    const nodes = [
      // React — real product surface (component + a react_app) → kept.
      { id: 'a', type: 'react_app', metadata: { framework: 'react' }, source: { file: 'apps/app/src/App.tsx' }, analyzers: ['react'] },
      { id: 'b', type: 'functional_component', metadata: { framework: 'react' }, source: { file: 'apps/app/src/Panel.tsx' }, analyzers: ['react'] },
      // node-http — application surface → kept.
      { id: 'c', type: 'application', metadata: { framework: 'node-http' }, source: { file: 'apps/site/server.mjs' }, analyzers: ['node-http'] },
      // django — product-path evidence but only an adapter MODULE shim → dropped.
      { id: 'd', type: 'module', metadata: { framework: 'django' }, source: { file: 'packages/sdk-py/src/telemetry' }, analyzers: ['django'] },
      // fastapi — product-path but only MIDDLEWARE shim → dropped.
      { id: 'e', type: 'middleware', metadata: { framework: 'fastapi' }, source: { file: 'packages/sdk-py/src/telemetry/middleware.py' }, analyzers: ['fastapi', 'django'] },
      // ruby — language analyzer, not a framework → dropped even on a class node.
      { id: 'f', type: 'class', metadata: { framework: 'ruby' }, source: { file: 'packages/sdk/ruby/mw.rb' }, analyzers: ['ruby'] },
      // library category label on a real route node → dropped (not a framework analyzer).
      { id: 'g', type: 'route', metadata: { framework: 'authentication and authorization' }, source: { file: 'src/auth/auth.controller.ts' }, analyzers: ['auth'] },
      { id: 'h', type: 'validation_contract', metadata: { framework: 'validation schema contract' }, source: { file: 'src/dto/x.dto.ts' }, analyzers: ['validation-schema-contracts'] },
      // scheduled library — library analyzer → dropped even though scheduled_job is a surface.
      { id: 'i', type: 'scheduled_job', metadata: { framework: 'nestjs-schedule' }, source: { file: 'src/jobs/scan.service.ts' }, analyzers: ['cron'] },
    ];
    const result = selectProductFrameworkNames(nodes, [], analyzerTypeMap(contributions), productPathPredicate);
    expect(result).toEqual(['node-http', 'react']);
  });

  it('excludes fixture-sourced framework apps even from a framework analyzer', () => {
    const nodes = [
      { id: 'real', type: 'route', metadata: { framework: 'fastapi' }, source: { file: 'services/api/app/main.py' }, analyzers: ['fastapi'] },
      { id: 'fixture', type: 'application', metadata: { framework: 'django' }, source: { file: 'apps/mcp-server/fixtures/framework-bench/django-routes/main.py' }, analyzers: ['django'] },
      { id: 'testfile', type: 'application', metadata: { framework: 'flask' }, source: { file: 'src/__tests__/flask-analyzer.test.ts' }, analyzers: ['flask'] },
    ];
    const contribs = [
      { analyzer_id: 'fastapi', analyzer_type: 'framework' },
      { analyzer_id: 'django', analyzer_type: 'framework' },
      { analyzer_id: 'flask', analyzer_type: 'framework' },
    ];
    const result = selectProductFrameworkNames(nodes, [], analyzerTypeMap(contribs), productPathPredicate);
    expect(result).toEqual(['fastapi']);
  });

  it('returns [] when no framework has product-path application-surface evidence', () => {
    const nodes = [
      { id: 'x', type: 'middleware', metadata: { framework: 'fastapi' }, source: { file: 'src/mw.py' }, analyzers: ['fastapi'] },
    ];
    expect(selectProductFrameworkNames(nodes, [], analyzerTypeMap([{ analyzer_id: 'fastapi', analyzer_type: 'framework' }]), productPathPredicate)).toEqual([]);
  });

  it('keeps a framework that owns a real product entry point backed by an existing file node', () => {
    const nodes = [
      { id: 'file_app_api_items_route_ts', type: 'file', source: { file: 'app/api/items/route.ts' }, analyzers: ['typescript-javascript'] },
    ];
    const contributions = [
      { analyzer_id: 'nextjs', analyzer_type: 'framework' },
      { analyzer_id: 'typescript-javascript', analyzer_type: 'language' },
    ];
    const entryPoints = [
      { source_node: 'file_app_api_items_route_ts', source_analyzer: 'nextjs', metadata: { framework: 'nextjs' } },
    ];
    expect(selectProductFrameworkNames(nodes, [], analyzerTypeMap(contributions), productPathPredicate, 10, entryPoints)).toEqual(['nextjs']);
  });

  it('surface set covers common web/UI surfaces and excludes shims', () => {
    expect(FRAMEWORK_APPLICATION_SURFACE_TYPES.has('component')).toBe(true);
    expect(FRAMEWORK_APPLICATION_SURFACE_TYPES.has('route')).toBe(true);
    expect(FRAMEWORK_APPLICATION_SURFACE_TYPES.has('application')).toBe(true);
    expect(FRAMEWORK_APPLICATION_SURFACE_TYPES.has('middleware')).toBe(false);
    expect(FRAMEWORK_APPLICATION_SURFACE_TYPES.has('module')).toBe(false);
  });

  it('indexes containment edges once for project-scale framework selection', () => {
    const nodes: any[] = [];
    const rawEdges: any[] = [];
    for (let index = 0; index < 500; index++) {
      nodes.push({ id: `owner-${index}`, type: 'class', role: 'controller', source: { file: `src/${index}.ts` } });
      nodes.push({
        id: `method-${index}`,
        type: 'method',
        metadata: { framework: 'nestjs' },
        source: { file: `src/${index}.ts` },
        analyzers: ['typescript-javascript'],
      });
      rawEdges.push({ type: 'contains', source: `owner-${index}`, target: `method-${index}` });
    }
    let numericReads = 0;
    const edges = new Proxy(rawEdges, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) numericReads++;
        return Reflect.get(target, property, receiver);
      },
    });
    const result = selectProductFrameworkNames(
      nodes,
      edges,
      analyzerTypeMap([{ analyzer_id: 'typescript-javascript', analyzer_type: 'language' }]),
      productPathPredicate,
    );
    expect(result).toEqual(['nestjs']);
    expect(numericReads).toBeLessThan(1000);
  });
});
