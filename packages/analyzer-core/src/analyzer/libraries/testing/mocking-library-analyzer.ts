import { AnalysisContext, BaseAnalyzer, FileAnalysisContext, FileAnalysisResult } from '../../core/base-analyzer';
import { CASContribution, CASEdge, CASLibrary, CASNode } from '../../../types/cas.types';
import * as fs from 'fs-extra';
import * as path from 'path';
import { cachedGlob as glob } from '../../core/glob-cache';
import { createYieldBudget } from '../../core/event-loop-yield';

/**
 * Mocking / test-double + fixture-factory library analyzer.
 *
 * The architectural insight: a mock is not a test detail, it is a declaration of
 * a DEPENDENCY SEAM. When a test replaces a collaborator at the boundary, it is
 * naming the exact thing the system-under-test depends on at that seam. Assemble
 * those replacement targets across a suite and you have the set of collaborators
 * the system swaps out under test — its real injection/integration surface.
 *
 * Companion to the test-framework analyzers (JestAnalyzer/CypressAnalyzer own
 * SUITES and CASES; this analyzer owns MOCKS/DOUBLES and FIXTURES/FACTORIES).
 * We emit three node kinds and two seam edges:
 *   - `mock` / `test_double`  node per double, plus a `mocks` edge to the real
 *     module / type / dependency it replaces (the seam target).
 *   - `test_fixture` node per factory/builder, plus a `constructs` edge to the
 *     entity/type it produces.
 *
 * Every rule is gated on the mocking library's real import (or, for Java/Go/C#,
 * its annotation/import statement) — never a bare `mock(` / `fn(` symbol without
 * its import source, mirroring the requiresImportEvidence discipline in
 * architectural-library-analyzer.ts. The whole point is attributing a double to
 * the framework that actually created it, not to any file that says "mock".
 */

type MockingLibrary =
  | 'sinon'
  | 'jest'
  | 'vitest'
  | 'testdouble'
  | 'unittest-mock'
  | 'pytest-monkeypatch'
  | 'responses'
  | 'mockito'
  | 'easymock'
  | 'gomock'
  | 'testify-mock'
  | 'moq'
  | 'nsubstitute'
  | 'rspec-mocks';

type FixtureLibrary =
  | 'fishery'
  | 'factory-boy'
  | 'faker'
  | 'factory-bot';

/** A single test double: a stub/spy/mock/fake created by a mocking library. */
interface MockDouble {
  id: string;
  /** Short display label, e.g. `jest.mock('../api')` or `mock(PaymentGateway)`. */
  name: string;
  library: MockingLibrary;
  /** Fine-grained double kind for the node's subcategories. */
  doubleKind: 'stub' | 'spy' | 'mock' | 'module-mock' | 'fake';
  /** The collaborator this double replaces — a module path, type, or symbol. */
  seamTarget?: string;
  /** How the seam target was named: module import path, type reference, or symbol. */
  seamKind?: 'module' | 'type' | 'symbol';
  filePath: string;
  line: number;
  evidence: string;
}

/** A fixture factory / builder that constructs an entity or type for tests. */
interface FixtureFactory {
  id: string;
  name: string;
  library: FixtureLibrary;
  /** The entity/type the factory constructs (fishery Factory<User>, DjangoModelFactory Meta.model). */
  constructs?: string;
  filePath: string;
  line: number;
  evidence: string;
}

interface DependencyHit {
  name: string;
  version?: string;
  type: CASLibrary['type'];
  packageManager: string;
}

/**
 * Import/annotation sources that gate each mocking library. A file is only
 * mined for a library's doubles once we see it actually pull that library in.
 * `jest`/`vitest` are the exceptions the ecosystem treats as ambient globals
 * (no import needed), so they are gated on the manifest dependency instead of a
 * per-file import — handled explicitly in importedMockingLibraries().
 */
const MOCK_IMPORTS: Record<MockingLibrary, string[]> = {
  sinon: ['sinon'],
  jest: ['jest', '@jest/globals'],
  vitest: ['vitest'],
  testdouble: ['testdouble'],
  'unittest-mock': ['unittest.mock', 'mock'],
  'pytest-monkeypatch': ['_pytest.monkeypatch'],
  responses: ['responses', 'requests_mock', 'requests-mock'],
  mockito: ['org.mockito'],
  easymock: ['org.easymock'],
  gomock: ['github.com/golang/mock/gomock', 'go.uber.org/mock/gomock'],
  'testify-mock': ['github.com/stretchr/testify/mock'],
  moq: ['Moq'],
  nsubstitute: ['NSubstitute'],
  'rspec-mocks': ['rspec/mocks', 'rspec'],
};

const MOCK_PACKAGES: Record<MockingLibrary, string[]> = {
  sinon: ['sinon'],
  jest: ['jest', '@jest/core', '@jest/globals'],
  vitest: ['vitest'],
  testdouble: ['testdouble'],
  'unittest-mock': ['mock'],
  'pytest-monkeypatch': ['pytest'],
  responses: ['responses', 'requests-mock'],
  mockito: ['org.mockito:mockito-core', 'mockito-core', 'mockito-inline', 'mockito-junit-jupiter'],
  easymock: ['org.easymock:easymock', 'easymock'],
  gomock: ['github.com/golang/mock', 'go.uber.org/mock'],
  'testify-mock': ['github.com/stretchr/testify'],
  moq: ['Moq'],
  nsubstitute: ['NSubstitute'],
  'rspec-mocks': ['rspec', 'rspec-mocks'],
};

const FIXTURE_IMPORTS: Record<FixtureLibrary, string[]> = {
  fishery: ['fishery'],
  'factory-boy': ['factory'],
  faker: ['@faker-js/faker', 'faker', 'Faker', '@faker-ruby/faker'],
  'factory-bot': ['factory_bot', 'factory_bot_rails'],
};

const FIXTURE_PACKAGES: Record<FixtureLibrary, string[]> = {
  fishery: ['fishery'],
  'factory-boy': ['factory-boy'],
  faker: ['@faker-js/faker', 'faker'],
  'factory-bot': ['factory_bot', 'factory_bot_rails'],
};

const ALL_MOCK_PACKAGES = Object.values(MOCK_PACKAGES).flat();
const ALL_FIXTURE_PACKAGES = Object.values(FIXTURE_PACKAGES).flat();

export class MockingLibraryAnalyzer extends BaseAnalyzer {
  constructor() {
    super('mocking-test-double-fixtures', 'Mocking, Test Double and Fixture Analyzer', '1.0.0', 'library');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    const dependencies = await this.readDependencies(projectPath);
    if (dependencies.some(dep => [...ALL_MOCK_PACKAGES, ...ALL_FIXTURE_PACKAGES].some(pkg => this.packageMatches(dep.name, pkg)))) {
      return true;
    }
    for (const relativeFile of await this.testFiles(projectPath)) {
      const content = await this.safeRead(path.join(projectPath, relativeFile));
      if (!content) continue;
      if (this.importedMockingLibraries(content, dependencies, relativeFile).size > 0) return true;
      if (this.importedFixtureLibraries(content, relativeFile).size > 0) return true;
    }
    return false;
  }

  supportsIncrementalAnalysis(): boolean {
    return true;
  }

  async getRelevantFiles(projectPath: string): Promise<string[]> {
    const relevant: string[] = [];
    for (const relativeFile of await this.testFiles(projectPath)) {
      const content = await this.safeRead(path.join(projectPath, relativeFile));
      if (content && this.fileMayContainDoubles(content)) relevant.push(relativeFile);
    }
    return relevant.sort();
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const { nodes, edges, libraries, doubles, fixtures } = await this.analyzeDoubles(
      context.projectPath,
      await this.testFiles(context.projectPath),
      true
    );

    const seamTargets = new Set(doubles.map(double => double.seamTarget).filter(Boolean));
    const contribution = this.createContribution(nodes, edges, [], [], {
      library_family: 'test-doubles-and-fixtures',
      analyzer_family: 'mocking-fixture-dependency-seams',
      test_doubles: doubles.length,
      dependency_seams: seamTargets.size,
      fixture_factories: fixtures.length,
      libraries_detected: libraries.length,
      categories: ['testing', 'test-doubles', 'mocking', 'fixtures', 'dependency-seams'],
    });
    contribution.libraries = libraries;
    return contribution;
  }

  async analyzeFileSingle(context: FileAnalysisContext): Promise<FileAnalysisResult> {
    const content = await fs.readFile(context.filePath, 'utf8');
    const stat = await fs.stat(context.filePath);
    const { nodes, edges, doubles, fixtures } = await this.analyzeDoubles(
      context.projectPath,
      [context.relativePath],
      false
    );

    return this.createFileAnalysisResult(
      context.filePath,
      context.relativePath,
      context.contentHash || this.computeContentHash(content),
      stat.mtimeMs,
      nodes,
      edges,
      [],
      [],
      this.extractImports(content, context.relativePath),
      [...doubles.map(double => double.name), ...fixtures.map(fixture => fixture.name)]
    );
  }

  protected getCapabilities(): string[] {
    return [
      'test-double-detection',
      'mocking-library-attribution',
      'dependency-seam-mapping',
      'module-and-type-mock-target-extraction',
      'fixture-factory-and-builder-detection',
      'fixture-constructed-entity-linking',
      'import-gated-double-attribution',
    ];
  }

  protected getLevelName(level: number): string {
    return level <= 3 ? 'test double' : 'seam collaborator';
  }

  private async analyzeDoubles(
    projectPath: string,
    files: string[],
    includeLibraries: boolean
  ): Promise<{
    nodes: CASNode[];
    edges: CASEdge[];
    libraries: CASLibrary[];
    doubles: MockDouble[];
    fixtures: FixtureFactory[];
  }> {
    const dependencies = await this.readDependencies(projectPath);
    const doubles: MockDouble[] = [];
    const fixtures: FixtureFactory[] = [];

    // Budget-yield per file: with the shared file-read cache warm the await
    // resolves in a microtask (no event-loop hop), so this scan ran as one
    // multi-second synchronous block on a whale repo. Results unchanged.
    const maybeYield = createYieldBudget();
    for (const relativeFile of files) {
      await maybeYield();
      const absoluteFile = path.join(projectPath, relativeFile);
      const content = await this.safeRead(absoluteFile);
      if (!content || !this.fileMayContainDoubles(content)) continue;

      const mockLibs = this.importedMockingLibraries(content, dependencies, relativeFile);
      if (mockLibs.size > 0) doubles.push(...this.extractDoubles(content, relativeFile, mockLibs));

      const fixtureLibs = this.importedFixtureLibraries(content, relativeFile);
      if (fixtureLibs.size > 0) fixtures.push(...this.extractFixtures(content, relativeFile, fixtureLibs));
    }

    const nodes = [
      ...this.createDoubleNodes(doubles),
      ...this.createSeamNodes(doubles),
      ...this.createFixtureNodes(fixtures),
    ];
    const edges = [...this.createSeamEdges(doubles), ...this.createConstructsEdges(fixtures)];
    const libraries = includeLibraries ? this.createLibraries(dependencies, doubles, fixtures) : [];
    return { nodes, edges, libraries, doubles, fixtures };
  }

  private createDoubleNodes(doubles: MockDouble[]): CASNode[] {
    return doubles.map(double => this.createNode(
      double.id,
      double.name,
      double.doubleKind === 'stub' || double.doubleKind === 'fake' ? 'test_double' : 'mock',
      3,
      double.filePath,
      double.line,
      double.line,
      {
        library: double.library,
        double_kind: double.doubleKind,
        seam_target: double.seamTarget,
        seam_kind: double.seamKind,
        boundary_type: 'dependency-seam',
        architecture_category: 'test-double',
        evidence: double.evidence,
        tags: ['test-double', 'dependency-seam', double.library],
        subcategories: ['testing', 'test-double', double.doubleKind, double.library],
      }
    ));
  }

  private createFixtureNodes(fixtures: FixtureFactory[]): CASNode[] {
    return fixtures.map(fixture => this.createNode(
      fixture.id,
      fixture.name,
      'test_fixture',
      3,
      fixture.filePath,
      fixture.line,
      fixture.line,
      {
        library: fixture.library,
        constructs: fixture.constructs,
        boundary_type: 'fixture-factory',
        architecture_category: 'test-fixture',
        evidence: fixture.evidence,
        tags: ['test-fixture', 'factory', fixture.library],
        subcategories: ['testing', 'fixture', 'factory', fixture.library],
      }
    ));
  }

  /**
   * The seam nodes the `mocks` edges point at — one per distinct replaced
   * collaborator, so several doubles of the same collaborator collapse onto one
   * seam. These were referenced by every seam edge but never emitted, which
   * left the graph asserting targets that existed in no collection; the
   * relationship is real, so the row it names has to exist. Located at the
   * first observation site, which is the only evidence the seam has.
   */
  private createSeamNodes(doubles: MockDouble[]): CASNode[] {
    const firstObservation = new Map<string, MockDouble>();
    for (const double of doubles) {
      if (!double.seamTarget) continue;
      const seamId = `seam_${this.sanitizeId(double.seamTarget)}`;
      if (!firstObservation.has(seamId)) firstObservation.set(seamId, double);
    }

    return [...firstObservation].map(([seamId, double]) => this.createNode(
      seamId,
      double.seamTarget!,
      'dependency_seam',
      4,
      double.filePath,
      double.line,
      double.line,
      {
        seam_target: double.seamTarget,
        seam_kind: double.seamKind,
        boundary_type: 'dependency-seam',
        architecture_category: 'dependency-seam',
        evidence: double.evidence,
        tags: ['dependency-seam', 'test-seam'],
        subcategories: ['testing', 'dependency-seam'],
      }
    ));
  }

  /**
   * The seam map: one `mocks` edge per double that names a real collaborator.
   * source = the double node, target = the seam node keyed by the replaced
   * module/type so multiple doubles of the same collaborator collapse onto one
   * seam. This is the artifact that reveals the integration surface.
   */
  private createSeamEdges(doubles: MockDouble[]): CASEdge[] {
    const edges: CASEdge[] = [];
    for (const double of doubles) {
      if (!double.seamTarget) continue;
      const seamId = `seam_${this.sanitizeId(double.seamTarget)}`;
      edges.push(this.createEdge(
        `mocks_${double.id}`,
        double.id,
        seamId,
        'mocks',
        'dependency-seam',
        {
          confidence: 0.85,
          attributes: {
            seam_target: double.seamTarget,
            seam_kind: double.seamKind,
            library: double.library,
            boundary_type: 'dependency-seam',
            evidence: double.evidence,
          },
          locations: [{ file: double.filePath, line: double.line }],
        }
      ));
    }
    return edges;
  }

  private createConstructsEdges(fixtures: FixtureFactory[]): CASEdge[] {
    const edges: CASEdge[] = [];
    for (const fixture of fixtures) {
      if (!fixture.constructs) continue;
      const entityId = `fixture_entity_${this.sanitizeId(fixture.constructs)}`;
      edges.push(this.createEdge(
        `constructs_${fixture.id}`,
        fixture.id,
        entityId,
        'constructs',
        'fixture-factory',
        {
          confidence: 0.8,
          attributes: {
            entity: fixture.constructs,
            library: fixture.library,
            boundary_type: 'fixture-factory',
            evidence: fixture.evidence,
          },
          locations: [{ file: fixture.filePath, line: fixture.line }],
        }
      ));
    }
    return edges;
  }

  private createLibraries(dependencies: DependencyHit[], doubles: MockDouble[], fixtures: FixtureFactory[]): CASLibrary[] {
    const libraries: CASLibrary[] = [];
    const mockCounts = new Map<MockingLibrary, number>();
    for (const double of doubles) mockCounts.set(double.library, (mockCounts.get(double.library) || 0) + 1);
    const fixtureCounts = new Map<FixtureLibrary, number>();
    for (const fixture of fixtures) fixtureCounts.set(fixture.library, (fixtureCounts.get(fixture.library) || 0) + 1);

    for (const [library, packages] of Object.entries(MOCK_PACKAGES) as Array<[MockingLibrary, string[]]>) {
      for (const hit of dependencies.filter(dep => packages.some(pkg => this.packageMatches(dep.name, pkg)))) {
        const count = mockCounts.get(library) || 0;
        libraries.push({
          id: `lib_${this.sanitizeId(hit.name)}`,
          name: hit.name,
          version: hit.version,
          type: hit.type,
          package_manager: hit.packageManager,
          category: 'testing',
          description: `${hit.name} creates test doubles that mark the dependency seams of the system under test.`,
          usage_statistics: {
            import_count: count,
            usage_frequency: count > 10 ? 'high' : count > 3 ? 'medium' : count > 0 ? 'low' : 'declared-only',
            critical_path: false,
          },
          connected_nodes: doubles.filter(double => double.library === library).map(double => double.id),
          metadata: { breaking_changes_risk: 'low' },
        });
      }
    }

    for (const [library, packages] of Object.entries(FIXTURE_PACKAGES) as Array<[FixtureLibrary, string[]]>) {
      for (const hit of dependencies.filter(dep => packages.some(pkg => this.packageMatches(dep.name, pkg)))) {
        const count = fixtureCounts.get(library) || 0;
        libraries.push({
          id: `lib_${this.sanitizeId(hit.name)}`,
          name: hit.name,
          version: hit.version,
          type: hit.type,
          package_manager: hit.packageManager,
          category: 'testing',
          description: `${hit.name} builds test fixtures/factories that construct domain entities for tests.`,
          usage_statistics: {
            import_count: count,
            usage_frequency: count > 10 ? 'high' : count > 3 ? 'medium' : count > 0 ? 'low' : 'declared-only',
            critical_path: false,
          },
          connected_nodes: fixtures.filter(fixture => fixture.library === library).map(fixture => fixture.id),
          metadata: { breaking_changes_risk: 'low' },
        });
      }
    }
    return libraries;
  }

  private extractDoubles(content: string, filePath: string, libraries: Set<MockingLibrary>): MockDouble[] {
    const doubles: MockDouble[] = [];
    const lines = this.sourceLines(content);

    lines.forEach((line, index) => {
      const lineNumber = index + 1;

      // jest.mock('module') / vi.mock('module') — a whole-module replacement.
      // The single richest seam signal: the argument IS the replaced module path.
      if (libraries.has('jest') || libraries.has('vitest')) {
        const moduleMock = line.match(/\b(?:jest|vi)\.mock\s*\(\s*['"]([^'"]+)['"]/);
        if (moduleMock) {
          doubles.push(this.double('jest-vitest', 'module-mock', line, filePath, lineNumber,
            libraries.has('vitest') && /\bvi\.mock/.test(line) ? 'vitest' : 'jest', moduleMock[1], 'module'));
        }
        // jest.spyOn(obj, 'method') / jest.fn() — spies and inline stubs.
        const spy = line.match(/\b(?:jest|vi)\.spyOn\s*\(\s*([A-Za-z_$][\w$.]*)\s*,\s*['"]([^'"]+)['"]/);
        if (spy) {
          const lib = /\bvi\.spyOn/.test(line) ? 'vitest' : 'jest';
          doubles.push(this.double(lib, 'spy', line, filePath, lineNumber, lib, `${spy[1]}.${spy[2]}`, 'symbol'));
        }
      }

      // Sinon: sinon.stub(obj, 'method') / sinon.spy(...) / sinon.mock(...).
      if (libraries.has('sinon')) {
        const sinon = line.match(/\bsinon\.(stub|spy|mock|fake)\s*\(\s*([A-Za-z_$][\w$.]*)?(?:\s*,\s*['"]([^'"]+)['"])?/);
        if (sinon) {
          const kind = sinon[1] === 'fake' ? 'fake' : sinon[1] === 'spy' ? 'spy' : sinon[1] === 'mock' ? 'mock' : 'stub';
          const target = sinon[3] ? `${sinon[2]}.${sinon[3]}` : sinon[2];
          doubles.push(this.double('sinon', kind, line, filePath, lineNumber, 'sinon', target, target ? 'symbol' : undefined));
        }
      }

      // testdouble.js: td.replace('module') / td.object() / td.func().
      if (libraries.has('testdouble')) {
        const replace = line.match(/\btd\.replace\s*\(\s*['"]([^'"]+)['"]/);
        if (replace) doubles.push(this.double('testdouble', 'module-mock', line, filePath, lineNumber, 'testdouble', replace[1], 'module'));
        else if (/\btd\.(object|func|replace)\s*\(/.test(line)) {
          doubles.push(this.double('testdouble', 'stub', line, filePath, lineNumber, 'testdouble'));
        }
      }

      // Python unittest.mock: @patch('pkg.target') / patch('pkg.target') /
      // MagicMock() / Mock(). The patch string is a dotted seam path.
      if (libraries.has('unittest-mock')) {
        const patch = line.match(/(?:@)?(?:mock\.)?patch(?:\.object)?\s*\(\s*['"]([^'"]+)['"]/);
        if (patch) doubles.push(this.double('unittest.mock', 'mock', line, filePath, lineNumber, 'unittest-mock', patch[1], 'symbol'));
        else if (/\b(MagicMock|AsyncMock|Mock)\s*\(/.test(line)) {
          doubles.push(this.double('unittest.mock', 'mock', line, filePath, lineNumber, 'unittest-mock'));
        }
      }

      // pytest monkeypatch: monkeypatch.setattr('pkg.target', ...).
      if (libraries.has('pytest-monkeypatch')) {
        const setattr = line.match(/\bmonkeypatch\.(setattr|setitem|delattr)\s*\(\s*['"]([^'"]+)['"]/);
        if (setattr) doubles.push(this.double('monkeypatch', 'stub', line, filePath, lineNumber, 'pytest-monkeypatch', setattr[2], 'symbol'));
      }

      // responses / requests-mock: HTTP-boundary doubles keyed by URL.
      if (libraries.has('responses')) {
        const resp = line.match(/\b(?:responses\.(?:add|get|post|put|delete)|requests_mock\.\w+)\s*\(\s*[^,'"]*['"]([^'"]+)['"]/);
        if (resp) doubles.push(this.double('responses', 'mock', line, filePath, lineNumber, 'responses', resp[1], 'module'));
      }

      // Mockito: mock(Type.class) / @Mock Type field / when(...)/verify(...).
      if (libraries.has('mockito')) {
        const mock = line.match(/\bmock\s*\(\s*([A-Za-z_$][\w$.]*)\.class\s*\)/) || line.match(/@Mock\b[^;]*\b([A-Z][\w$.]*)\s+\w+\s*;/);
        if (mock) doubles.push(this.double('mockito', 'mock', line, filePath, lineNumber, 'mockito', mock[1], 'type'));
        else if (/@(Mock|Spy|InjectMocks)\b/.test(line)) doubles.push(this.double('mockito', 'mock', line, filePath, lineNumber, 'mockito'));
      }

      // EasyMock: createMock(Type.class) / createNiceMock(...).
      if (libraries.has('easymock')) {
        const em = line.match(/\bcreate(?:Nice|Strict)?Mock\s*\(\s*([A-Za-z_$][\w$.]*)\.class\s*\)/);
        if (em) doubles.push(this.double('easymock', 'mock', line, filePath, lineNumber, 'easymock', em[1], 'type'));
      }

      // gomock: NewMockXxx(ctrl) generated mocks name the mocked interface.
      if (libraries.has('gomock')) {
        const gm = line.match(/\bNewMock([A-Z][\w]*)\s*\(/);
        if (gm) doubles.push(this.double('gomock', 'mock', line, filePath, lineNumber, 'gomock', gm[1], 'type'));
      }

      // testify/mock: new(mocks.Xxx) / &mocks.Xxx{} / m.On("Method", ...).
      if (libraries.has('testify-mock')) {
        const tf = line.match(/\bnew\(\s*[A-Za-z_][\w]*\.([A-Z][\w]*)\s*\)/) || line.match(/&\s*[A-Za-z_][\w]*\.([A-Z][\w]*)\{\s*\}/);
        if (tf) doubles.push(this.double('testify', 'mock', line, filePath, lineNumber, 'testify-mock', tf[1], 'type'));
      }

      // Moq (C#): new Mock<Type>() / Mock.Of<Type>().
      if (libraries.has('moq')) {
        const moq = line.match(/\b(?:new\s+Mock<|Mock\.Of<)\s*([A-Za-z_][\w.]*)\s*>/);
        if (moq) doubles.push(this.double('moq', 'mock', line, filePath, lineNumber, 'moq', moq[1], 'type'));
      }

      // NSubstitute (C#): Substitute.For<Type>().
      if (libraries.has('nsubstitute')) {
        const ns = line.match(/\bSubstitute\.For<\s*([A-Za-z_][\w.]*)\s*>/);
        if (ns) doubles.push(this.double('nsubstitute', 'mock', line, filePath, lineNumber, 'nsubstitute', ns[1], 'type'));
      }

      // RSpec mocks: instance_double('Type') / double('name') / allow(obj).to.
      if (libraries.has('rspec-mocks')) {
        const idbl = line.match(/\b(?:instance_double|class_double|object_double)\s*\(\s*['"]?([A-Za-z_][\w:]*)/);
        if (idbl) doubles.push(this.double('rspec', 'mock', line, filePath, lineNumber, 'rspec-mocks', idbl[1], 'type'));
        else if (/\b(double|spy|instance_double)\s*\(/.test(line) || /\ballow\s*\([^)]*\)\.to\b/.test(line)) {
          doubles.push(this.double('rspec', 'stub', line, filePath, lineNumber, 'rspec-mocks'));
        }
      }
    });

    return this.dedupe(doubles);
  }

  private extractFixtures(content: string, filePath: string, libraries: Set<FixtureLibrary>): FixtureFactory[] {
    const fixtures: FixtureFactory[] = [];
    const lines = this.sourceLines(content);

    lines.forEach((line, index) => {
      const lineNumber = index + 1;

      // fishery (TS): Factory.define<User>(...) / const userFactory = Factory.define(...).
      if (libraries.has('fishery')) {
        const fish = line.match(/\bFactory\.define<\s*([A-Za-z_$][\w$.]*)\s*[>,]/);
        const assigned = this.findFixtureAssignment(line);
        if (fish || /\bFactory\.define\s*[(<]/.test(line)) {
          fixtures.push(this.fixture('fishery', assigned || fish?.[1] || 'fishery-factory', line, filePath, lineNumber, fish?.[1]));
        }
      }

      // Factory Boy (Py): class UserFactory(factory.Factory): with Meta.model.
      if (libraries.has('factory-boy')) {
        const cls = line.match(/^class\s+([A-Za-z_][\w]*)\s*\([^)]*\b(?:factory\.)?(?:Factory|DjangoModelFactory|SQLAlchemyModelFactory)\b[^)]*\)\s*:/);
        if (cls) {
          const model = this.findFactoryBoyModel(lines, index);
          fixtures.push(this.fixture('factory-boy', cls[1], line, filePath, lineNumber, model));
        }
      }

      // factory_bot (Ruby): factory :user do ... / factory :user, class: 'User'.
      if (libraries.has('factory-bot')) {
        const fb = line.match(/\bfactory\s+:([A-Za-z_][\w]*)(?:\s*,\s*class:\s*['"]([^'"]+)['"])?/);
        if (fb) fixtures.push(this.fixture('factory-bot', fb[1], line, filePath, lineNumber, fb[2] || this.rubyConstant(fb[1])));
      }

      // Faker: usage only marks presence; not a factory boundary on its own, so
      // we record a Faker fixture node only where it seeds a named builder.
      if (libraries.has('faker')) {
        const seed = this.findFixtureAssignment(line);
        if (seed && /\b(?:faker|Faker)\.[A-Za-z]/.test(line)) {
          fixtures.push(this.fixture('faker', seed, line, filePath, lineNumber));
        }
      }
    });

    return this.dedupe(fixtures);
  }

  private double(
    _label: string,
    doubleKind: MockDouble['doubleKind'],
    line: string,
    filePath: string,
    lineNumber: number,
    library: MockingLibrary,
    seamTarget?: string,
    seamKind?: MockDouble['seamKind']
  ): MockDouble {
    const trimmed = line.trim();
    const name = seamTarget
      ? `${this.libraryLabel(library)} ${doubleKind}: ${seamTarget}`
      : `${this.libraryLabel(library)} ${doubleKind}`;
    return {
      id: `mock_${this.sanitizeId(library)}_${this.sanitizeId(filePath)}_${lineNumber}`,
      name,
      library,
      doubleKind,
      seamTarget,
      seamKind: seamTarget ? seamKind : undefined,
      filePath,
      line: lineNumber,
      evidence: trimmed.slice(0, 180),
    };
  }

  private fixture(
    library: FixtureLibrary,
    name: string,
    line: string,
    filePath: string,
    lineNumber: number,
    constructs?: string
  ): FixtureFactory {
    return {
      id: `fixture_${this.sanitizeId(library)}_${this.sanitizeId(filePath)}_${this.sanitizeId(name)}_${lineNumber}`,
      name,
      library,
      constructs,
      filePath,
      line: lineNumber,
      evidence: line.trim().slice(0, 180),
    };
  }

  private libraryLabel(library: MockingLibrary): string {
    const labels: Record<MockingLibrary, string> = {
      sinon: 'Sinon',
      jest: 'jest',
      vitest: 'vitest',
      testdouble: 'testdouble',
      'unittest-mock': 'unittest.mock',
      'pytest-monkeypatch': 'monkeypatch',
      responses: 'responses',
      mockito: 'Mockito',
      easymock: 'EasyMock',
      gomock: 'gomock',
      'testify-mock': 'testify',
      moq: 'Moq',
      nsubstitute: 'NSubstitute',
      'rspec-mocks': 'RSpec',
    };
    return labels[library];
  }

  private importedMockingLibraries(content: string, dependencies: DependencyHit[], filePath: string): Set<MockingLibrary> {
    const imports = this.extractImports(content, filePath);
    const found = new Set<MockingLibrary>();
    for (const [library, sources] of Object.entries(MOCK_IMPORTS) as Array<[MockingLibrary, string[]]>) {
      if (imports.some(source => sources.some(pkg => source === pkg || source.startsWith(`${pkg}/`) || source.startsWith(`${pkg}.`)))) {
        found.add(library);
      }
    }
    // jest/vitest are ambient in their test envs (no import needed), so gate them
    // on the manifest dependency plus first-party API surface in the file.
    if (dependencies.some(dep => MOCK_PACKAGES.jest.some(pkg => this.packageMatches(dep.name, pkg))) && /\bjest\.(mock|fn|spyOn)\s*\(/.test(content)) {
      found.add('jest');
    }
    if (dependencies.some(dep => this.packageMatches(dep.name, 'vitest')) && /\bvi\.(mock|fn|spyOn)\s*\(/.test(content)) {
      found.add('vitest');
    }
    return found;
  }

  private importedFixtureLibraries(content: string, filePath: string): Set<FixtureLibrary> {
    const imports = this.extractImports(content, filePath);
    const found = new Set<FixtureLibrary>();
    for (const [library, sources] of Object.entries(FIXTURE_IMPORTS) as Array<[FixtureLibrary, string[]]>) {
      if (imports.some(source => sources.some(pkg => source === pkg || source.startsWith(`${pkg}/`) || source.startsWith(`${pkg}.`)))) {
        found.add(library);
      }
    }
    return found;
  }

  private extractImports(content: string, filePath: string): string[] {
    const flavor = this.sourceImportFlavor(filePath);
    const corpusImports = flavor ? this.sourceImports(content, flavor) : undefined;
    if (corpusImports) return [...corpusImports];
    const imports = new Set<string>();
    for (const line of this.sourceLines(content)) {
      const importMatch = line.match(/^\s*import\s+(?:.+?\s+from\s+)?['"]([^'"]+)['"]/);
      const requireMatch = line.match(/\brequire\(['"]([^'"]+)['"]\)/);
      const pythonMatch = line.match(/^\s*(?:from\s+([a-zA-Z0-9_.]+)\s+import|import\s+([a-zA-Z0-9_.]+))/);
      const javaMatch = line.match(/^\s*import\s+(?:static\s+)?([a-zA-Z0-9_.]+)\s*;/);
      const goMatch = line.match(/^\s*(?:[a-zA-Z0-9_]+\s+)?["]([a-zA-Z0-9_./-]+)["]/);
      const csharpMatch = line.match(/^\s*using\s+(?:static\s+)?([A-Za-z0-9_.]+)\s*;/);
      const rubyMatch = line.match(/^\s*require\s+['"]([^'"]+)['"]/);
      const value = importMatch?.[1] || requireMatch?.[1] || pythonMatch?.[1] || pythonMatch?.[2] ||
        javaMatch?.[1] || goMatch?.[1] || csharpMatch?.[1] || rubyMatch?.[1];
      if (value) imports.add(value);
    }
    return [...imports];
  }

  private fileMayContainDoubles(content: string): boolean {
    return /(jest\.(mock|fn|spyOn)|vi\.(mock|fn|spyOn)|sinon\.|td\.(replace|object|func)|MagicMock|AsyncMock|\bMock\s*\(|monkeypatch\.|responses\.|requests_mock|@Mock\b|mock\s*\([A-Za-z_$][\w$.]*\.class|NewMock[A-Z]|new\s+Mock<|Substitute\.For<|instance_double|\bdouble\s*\(|\ballow\s*\(|Factory\.define|factory\.(Factory|DjangoModelFactory)|\bfactory\s+:[A-Za-z_]|faker\.|Faker\.)/.test(content);
  }

  private findFixtureAssignment(line: string): string | undefined {
    const match = line.match(/(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/);
    return match?.[1];
  }

  private findFactoryBoyModel(lines: readonly string[], classLine: number): string | undefined {
    for (let i = classLine + 1; i < Math.min(lines.length, classLine + 25); i++) {
      const line = lines[i];
      if (line.trim() && !/^\s/.test(line)) break;
      const model = line.match(/\bmodel\s*=\s*([A-Za-z_][\w.]*)/);
      if (model) return model[1];
    }
    return undefined;
  }

  private rubyConstant(name: string): string {
    return name.split('_').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('');
  }

  private dedupe<T extends { id: string }>(items: T[]): T[] {
    const seen = new Map<string, T>();
    for (const item of items) if (!seen.has(item.id)) seen.set(item.id, item);
    return [...seen.values()];
  }

  private async testFiles(projectPath: string): Promise<string[]> {
    return this.capAndPrioritizeSourceFiles(await glob([
      '**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs}',
      '**/{__tests__,test,tests,spec,e2e}/**/*.{ts,tsx,js,jsx,mjs,cjs}',
      '**/test_*.py',
      '**/*_test.py',
      '**/tests/**/*.py',
      '**/conftest.py',
      '**/factories.py',
      '**/*Test.java',
      '**/*Tests.java',
      '**/*_test.go',
      '**/*Test.cs',
      '**/*Tests.cs',
      '**/*_spec.rb',
      '**/spec/**/*.rb',
      '**/factories/**/*.rb',
      '**/__mocks__/**/*.{ts,js}',
    ], {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath }).filter(pattern =>
        !pattern.includes('fixtures') &&
        !pattern.includes('testdata') &&
        !pattern.includes('cas-tests') &&
        !pattern.includes('__tests__')),
      nodir: true,
      absolute: false,
    }), 'mocking and fixture candidate files');
  }

  private async readDependencies(projectPath: string): Promise<DependencyHit[]> {
    return [
      ...await this.readPackageJsonDependencies(projectPath),
      ...await this.readPythonDependencies(projectPath),
      ...await this.readGemfileDependencies(projectPath),
      ...await this.readJavaDependencies(projectPath),
      ...await this.readGoDependencies(projectPath),
      ...await this.readDotnetDependencies(projectPath),
    ];
  }

  private async readPackageJsonDependencies(projectPath: string): Promise<DependencyHit[]> {
    const packageJsonPath = path.join(projectPath, 'package.json');
    if (!await fs.pathExists(packageJsonPath)) return [];
    const pkg = await this.readSourceJson<any>(packageJsonPath).catch(() => undefined);
    if (!pkg) return [];
    const hits: DependencyHit[] = [];
    const add = (deps: Record<string, string> | undefined, type: CASLibrary['type']) => {
      for (const [name, version] of Object.entries(deps || {})) {
        hits.push({ name, version: String(version).replace(/^[\^~>=<]/, ''), type, packageManager: 'npm' });
      }
    };
    add(pkg.dependencies, 'production');
    add(pkg.devDependencies, 'development');
    add(pkg.peerDependencies, 'peer');
    add(pkg.optionalDependencies, 'optional');
    return hits;
  }

  private async readPythonDependencies(projectPath: string): Promise<DependencyHit[]> {
    const hits: DependencyHit[] = [];
    for (const file of ['requirements.txt', 'requirements/base.txt', 'requirements/dev.txt', 'requirements/test.txt', 'pyproject.toml', 'Pipfile']) {
      const reqPath = path.join(projectPath, file);
      if (!await fs.pathExists(reqPath)) continue;
      const content = await fs.readFile(reqPath, 'utf8');
      for (const pkg of ['mock', 'pytest', 'responses', 'requests-mock', 'factory-boy', 'faker']) {
        const match = new RegExp(`(?:^|["'\\s])${this.escapeRegExp(pkg)}\\b\\s*(?:[><=!~]+\\s*([^,;"'\\s]+))?`, 'im').exec(content);
        if (match) hits.push({ name: pkg, version: match[1], type: 'development', packageManager: 'pip' });
      }
    }
    return hits;
  }

  private async readGemfileDependencies(projectPath: string): Promise<DependencyHit[]> {
    const gemfile = path.join(projectPath, 'Gemfile');
    if (!await fs.pathExists(gemfile)) return [];
    const content = await fs.readFile(gemfile, 'utf8');
    return content.split(/\r?\n/)
      .map(line => line.match(/^\s*gem\s+['"]([^'"]+)['"](?:,\s*['"]([^'"]+)['"])?/))
      .filter((match): match is RegExpMatchArray => Boolean(match))
      .map(match => ({ name: match[1], version: match[2], type: 'development' as const, packageManager: 'bundler' }));
  }

  private async readJavaDependencies(projectPath: string): Promise<DependencyHit[]> {
    const hits: DependencyHit[] = [];
    const pomPath = path.join(projectPath, 'pom.xml');
    if (await fs.pathExists(pomPath)) {
      const content = await fs.readFile(pomPath, 'utf8');
      const dependencyRegex = /<dependency>[\s\S]*?<groupId>([^<]+)<\/groupId>[\s\S]*?<artifactId>([^<]+)<\/artifactId>[\s\S]*?<\/dependency>/g;
      let match: RegExpExecArray | null;
      while ((match = dependencyRegex.exec(content)) !== null) {
        hits.push({ name: `${match[1]}:${match[2]}`, type: 'development', packageManager: 'maven' });
        hits.push({ name: match[2], type: 'development', packageManager: 'maven' });
      }
    }
    const gradleFiles = await glob(['build.gradle', 'build.gradle.kts', '**/build.gradle', '**/build.gradle.kts'], {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath }),
      nodir: true,
    });
    for (const relativeFile of gradleFiles) {
      const content = await fs.readFile(path.join(projectPath, relativeFile), 'utf8');
      const dependencyRegex = /(?:testImplementation|testCompile|implementation)\s*(?:\(?\s*)['"]([^:'"]+):([^:'"]+):?([^'"]*)['"]/g;
      let match: RegExpExecArray | null;
      while ((match = dependencyRegex.exec(content)) !== null) {
        hits.push({ name: `${match[1]}:${match[2]}`, type: 'development', packageManager: 'gradle' });
        hits.push({ name: match[2], type: 'development', packageManager: 'gradle' });
      }
    }
    return hits;
  }

  private async readGoDependencies(projectPath: string): Promise<DependencyHit[]> {
    const goMod = path.join(projectPath, 'go.mod');
    if (!await fs.pathExists(goMod)) return [];
    const content = await fs.readFile(goMod, 'utf8');
    return content.split(/\r?\n/)
      .map(line => line.trim().match(/^([a-zA-Z0-9_.\/-]+)\s+v[\d].*/))
      .filter((match): match is RegExpMatchArray => Boolean(match))
      .map(match => ({ name: match[1], type: 'development' as const, packageManager: 'go' }));
  }

  private async readDotnetDependencies(projectPath: string): Promise<DependencyHit[]> {
    const csprojFiles = await glob('**/*.csproj', {
      cwd: projectPath,
      ignore: this.getIgnorePatterns({ projectPath }),
      nodir: true,
    });
    const hits: DependencyHit[] = [];
    for (const relativeFile of csprojFiles) {
      const content = await fs.readFile(path.join(projectPath, relativeFile), 'utf8');
      const packageRegex = /<PackageReference\s+Include="([^"]+)"(?:\s+Version="([^"]+)")?/g;
      let match: RegExpExecArray | null;
      while ((match = packageRegex.exec(content)) !== null) {
        hits.push({ name: match[1], version: match[2], type: 'development', packageManager: 'nuget' });
      }
    }
    return hits;
  }

  private packageMatches(name: string, expected: string): boolean {
    const normalized = name.toLowerCase();
    const target = expected.toLowerCase();
    return normalized === target || normalized.startsWith(`${target}/`) || normalized.startsWith(`${target}:`);
  }

  private async safeRead(filePath: string): Promise<string | undefined> {
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch {
      return undefined;
    }
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
