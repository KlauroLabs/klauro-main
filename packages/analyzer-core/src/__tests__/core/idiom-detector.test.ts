import { detectCodebaseIdioms, IdiomDetectionInput } from '../../analyzer/core/idiom-detector';
import { CASLibrary, CASNode } from '../../types/cas.types';

function node(partial: Partial<CASNode>): CASNode {
  return {
    id: partial.id || partial.name || 'node',
    name: partial.name || 'Node',
    type: partial.type || 'class',
    source: partial.source || { file: `src/${partial.name || 'node'}.ts`, line: 1 },
    metadata: partial.metadata || {},
  } as CASNode;
}

function baseInput(overrides: Partial<IdiomDetectionInput> = {}): IdiomDetectionInput {
  return {
    projectPath: '/nonexistent/idiom-detector-test',
    nodes: [],
    edges: [],
    entryPoints: [],
    exitPoints: [],
    testSuites: [],
    behavioralInvariants: [],
    decorators: [],
    patterns: [],
    libraries: [],
    analysisFacts: [],
    ...overrides,
  };
}

describe('detectCodebaseIdioms repo-derived statistics', () => {
  it('attaches provenance with evidence file counts to every idiom', async () => {
    const nodes = Array.from({ length: 6 }, (_, i) =>
      node({ id: `svc${i}`, name: `Billing${i}Service`, type: 'service', source: { file: `src/billing/billing${i}.service.ts`, line: 1 } }));
    const result = await detectCodebaseIdioms(baseInput({ nodes }));
    expect(result.idioms.length).toBeGreaterThan(0);
    for (const idiom of result.idioms) {
      expect(idiom.provenance).toBeDefined();
      expect(idiom.provenance!.evidence_files).toBeGreaterThanOrEqual(0);
      expect(idiom.provenance!.matching).toBeGreaterThan(0);
      expect(idiom.provenance!.population).toBeGreaterThanOrEqual(idiom.provenance!.matching);
      expect(idiom.provenance!.derivation.length).toBeGreaterThan(10);
    }
  });

  it('names the actual ORM library in the data-access idiom', async () => {
    const libraries = [{ name: 'prisma', version: '5.0.0' } as CASLibrary];
    const nodes = [
      node({ id: 'repo1', name: 'UserRepository', type: 'repository', source: { file: 'src/users/user.repository.ts', line: 1 } }),
      node({ id: 'repo2', name: 'OrderRepository', type: 'repository', source: { file: 'src/orders/order.repository.ts', line: 1 } }),
      node({ id: 'model1', name: 'UserModel', type: 'model', source: { file: 'src/users/user.model.ts', line: 1 } }),
    ];
    const result = await detectCodebaseIdioms(baseInput({ nodes, libraries }));
    const dataAccess = result.idioms.find(idiom => idiom.category === 'data-access');
    expect(dataAccess).toBeDefined();
    expect(dataAccess!.name).toContain('prisma');
    expect(dataAccess!.description).toContain('3 data-access node(s)');
  });

  it('names the dominant migration directory in the migrations idiom', async () => {
    const nodes = [
      node({ id: 'm1', name: 'CreateUsers', source: { file: 'db/migrate/20240101_create_users.rb', line: 1 } }),
      node({ id: 'm2', name: 'CreateOrders', source: { file: 'db/migrate/20240102_create_orders.rb', line: 1 } }),
      node({ id: 'model', name: 'User', type: 'model', source: { file: 'app/models/user.rb', line: 1 } }),
    ];
    const result = await detectCodebaseIdioms(baseInput({ nodes }));
    const migrations = result.idioms.find(idiom => idiom.category === 'migrations');
    expect(migrations).toBeDefined();
    expect(migrations!.name).toContain('db/migrate');
  });

  it('does not emit weak generic idioms below evidence thresholds', async () => {
    const nodes = [
      node({ id: 'log1', name: 'logger', type: 'function', source: { file: 'src/a.ts', line: 1, raw: 'this.logger.info("x")' } }),
      node({ id: 'log2', name: 'logHelper', type: 'function', source: { file: 'src/b.ts', line: 1, raw: 'this.logger.info("y")' } }),
      node({ id: 'val1', name: 'UserDto', type: 'class', source: { file: 'src/users/user.dto.ts', line: 1 } }),
      node({ id: 'val2', name: 'OrderDto', type: 'class', source: { file: 'src/orders/order.dto.ts', line: 1 } }),
    ];
    const result = await detectCodebaseIdioms(baseInput({ nodes }));
    expect(result.idioms.find(idiom => idiom.category === 'logging')).toBeUndefined();
    expect(result.idioms.find(idiom => idiom.category === 'validation')).toBeUndefined();
  });

  it('emits logging and validation idioms once evidence is substantial', async () => {
    const nodes = [
      ...Array.from({ length: 6 }, (_, i) =>
        node({ id: `log${i}`, name: `worker${i}`, type: 'function', source: { file: `src/workers/worker${i}.ts`, line: 1, raw: 'this.logger.info("ran")' } })),
      ...Array.from({ length: 6 }, (_, i) =>
        node({ id: `dto${i}`, name: `Entity${i}Dto`, type: 'class', source: { file: `src/dto/entity${i}.dto.ts`, line: 1 } })),
    ];
    const result = await detectCodebaseIdioms(baseInput({ nodes }));
    const logging = result.idioms.find(idiom => idiom.category === 'logging');
    const validation = result.idioms.find(idiom => idiom.category === 'validation');
    expect(logging).toBeDefined();
    expect(logging!.description).toContain('node(s)');
    expect(validation).toBeDefined();
    expect(validation!.name).toContain('DTO');
  });

  it('never leaks the workspace-absolute (hash-named snapshot dir) path into idiom evidence claim text', async () => {
    // Mirrors production: source is snapshotted to a dir named after the
    // analysisId hash (remote-analyzer-service.ts), so node.source.file can
    // arrive as an absolute path rooted under that hash dir, e.g. what a
    // local klauro-* temp dir looks like. The file-organization "feature
    // modules" idiom builds evidence.claim from node.source.file directly
    // (byFeatureDirs), bypassing the buildFileInventory relativization that
    // protects every other fileEvidence() call site — this is the one path
    // that needs its own claim-text scrub in normalizeDraftPaths.
    const hashRoot = '/var/folders/xy/T/klauro-b4d1b9a5fa2fab1c';
    const nodes = [
      node({ id: 'c1', name: 'UsersController', type: 'controller', source: { file: `${hashRoot}/users/users.controller.ts`, line: 1 } }),
      node({ id: 's1', name: 'UsersService', type: 'service', source: { file: `${hashRoot}/users/users.service.ts`, line: 1 } }),
      node({ id: 'r1', name: 'UsersRepository', type: 'repository', source: { file: `${hashRoot}/users/users.repository.ts`, line: 1 } }),
      node({ id: 'd1', name: 'UsersDto', type: 'dto', source: { file: `${hashRoot}/users/users.dto.ts`, line: 1 } }),
      node({ id: 'm1', name: 'UsersModule', type: 'module', source: { file: `${hashRoot}/users/users.module.ts`, line: 1 } }),
    ];
    const result = await detectCodebaseIdioms(baseInput({ projectPath: hashRoot, nodes }));
    const featureModules = result.idioms.find(idiom => idiom.category === 'file-organization' && idiom.name.toLowerCase().includes('feature'));
    expect(featureModules).toBeDefined();
    expect(featureModules!.evidence.length).toBeGreaterThan(0);

    for (const idiom of result.idioms) {
      for (const evidence of idiom.evidence) {
        expect(evidence.claim).not.toContain(hashRoot);
        expect(evidence.claim).not.toContain('klauro-b4d1b9a5fa2fab1c');
        if (evidence.file) expect(evidence.file).not.toContain(hashRoot);
      }
      for (const deviation of idiom.deviations || []) {
        expect(deviation.file || '').not.toContain(hashRoot);
        for (const evidence of deviation.evidence || []) {
          expect(evidence.claim).not.toContain(hashRoot);
        }
      }
    }
  });

  it('differentiates idioms between two structurally different repos', async () => {
    const railsInput = baseInput({
      nodes: [
        node({ id: 'm1', name: 'CreateUsers', source: { file: 'db/migrate/20240101_create_users.rb', line: 1 } }),
        node({ id: 'model', name: 'User', type: 'model', source: { file: 'app/models/user.rb', line: 1 } }),
        node({ id: 'model2', name: 'Order', type: 'model', source: { file: 'app/models/order.rb', line: 1 } }),
        node({ id: 'model3', name: 'Shift', type: 'model', source: { file: 'app/models/shift.rb', line: 1 } }),
      ],
    });
    const djangoInput = baseInput({
      nodes: [
        node({ id: 'm1', name: '0001_initial', source: { file: 'orders/migrations/0001_initial.py', line: 1 } }),
        node({ id: 'model', name: 'Order', type: 'model', source: { file: 'orders/models.py', line: 1 } }),
        node({ id: 'model2', name: 'Invoice', type: 'model', source: { file: 'invoices/models.py', line: 1 } }),
        node({ id: 'model3', name: 'Company', type: 'model', source: { file: 'companies/models.py', line: 1 } }),
      ],
    });
    const railsIdioms = await detectCodebaseIdioms(railsInput);
    const djangoIdioms = await detectCodebaseIdioms(djangoInput);
    const railsMigration = railsIdioms.idioms.find(idiom => idiom.category === 'migrations');
    const djangoMigration = djangoIdioms.idioms.find(idiom => idiom.category === 'migrations');
    expect(railsMigration!.id).not.toEqual(djangoMigration!.id);
  });
});
