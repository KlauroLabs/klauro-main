jest.unmock('fs');
jest.unmock('fs-extra');
jest.unmock('glob');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { MockingLibraryAnalyzer } from '../../analyzer/libraries/testing/mocking-library-analyzer';
import { CASContribution, CASEdge, CASNode } from '../../types/cas.types';

describe('MockingLibraryAnalyzer', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-mocking-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function analyzeProject(
    manifests: Record<string, unknown | string>,
    files: Record<string, string>
  ): Promise<CASContribution> {
    for (const [relativePath, content] of Object.entries(manifests)) {
      const fullPath = path.join(tempDir, relativePath);
      await fs.ensureDir(path.dirname(fullPath));
      if (typeof content === 'string') {
        await fs.writeFile(fullPath, content);
      } else {
        await fs.writeJson(fullPath, content);
      }
    }
    for (const [relativePath, content] of Object.entries(files)) {
      const fullPath = path.join(tempDir, relativePath);
      await fs.ensureDir(path.dirname(fullPath));
      await fs.writeFile(fullPath, content);
    }
    const analyzer = new MockingLibraryAnalyzer();
    return analyzer.analyze({ projectPath: tempDir } as any);
  }

  function doubleNodes(contribution: CASContribution): CASNode[] {
    return (contribution.nodes || []).filter(node => node.type === 'mock' || node.type === 'test_double');
  }
  function fixtureNodes(contribution: CASContribution): CASNode[] {
    return (contribution.nodes || []).filter(node => node.type === 'test_fixture');
  }
  function seamEdges(contribution: CASContribution): CASEdge[] {
    return (contribution.edges || []).filter(edge => edge.type === 'mocks');
  }

  it('maps jest.mock() to the module it replaces as a dependency-seam edge', async () => {
    const contribution = await analyzeProject(
      { 'package.json': { devDependencies: { jest: '^29.0.0' } } },
      {
        'src/user.service.test.ts': [
          "import { UserService } from './user.service';",
          "jest.mock('../gateways/payment-gateway');",
          "jest.mock('axios');",
          "describe('UserService', () => {",
          "  it('charges', () => {",
          "    const spy = jest.spyOn(UserService.prototype, 'save');",
          "    expect(spy).toBeDefined();",
          "  });",
          "});",
        ].join('\n'),
      }
    );

    const doubles = doubleNodes(contribution);
    // two module mocks + one spy
    expect(doubles.length).toBeGreaterThanOrEqual(3);

    const seams = seamEdges(contribution);
    const seamTargets = seams.map(edge => edge.metadata?.attributes?.seam_target);
    expect(seamTargets).toContain('../gateways/payment-gateway');
    expect(seamTargets).toContain('axios');
    expect(seamTargets).toContain('UserService.prototype.save');

    // each seam edge points from a double to a synthetic seam node
    for (const edge of seams) {
      expect(edge.target.startsWith('seam_')).toBe(true);
      expect(edge.category).toBe('dependency-seam');
    }
  });

  it('attributes Python unittest.mock @patch targets to the mocked symbol', async () => {
    const contribution = await analyzeProject(
      { 'requirements/test.txt': 'mock==5.1.0\npytest==8.0.0\n' },
      {
        'tests/test_billing.py': [
          'from unittest.mock import patch, MagicMock',
          '',
          "@patch('billing.services.stripe_client')",
          'def test_charge(mock_stripe):',
          '    mock_stripe.return_value = MagicMock()',
          '    assert True',
        ].join('\n'),
      }
    );

    const seamTargets = seamEdges(contribution).map(edge => edge.metadata?.attributes?.seam_target);
    expect(seamTargets).toContain('billing.services.stripe_client');
  });

  it('detects Mockito mock(Type.class) and names the mocked type as the seam', async () => {
    const contribution = await analyzeProject(
      { 'pom.xml': '<project><dependencies><dependency><groupId>org.mockito</groupId><artifactId>mockito-core</artifactId></dependency></dependencies></project>' },
      {
        'src/test/java/PaymentServiceTest.java': [
          'import org.mockito.Mockito;',
          'import static org.mockito.Mockito.mock;',
          'public class PaymentServiceTest {',
          '  private final PaymentGateway gateway = mock(PaymentGateway.class);',
          '}',
        ].join('\n'),
      }
    );

    const seamTargets = seamEdges(contribution).map(edge => edge.metadata?.attributes?.seam_target);
    expect(seamTargets).toContain('PaymentGateway');
  });

  it('detects fishery factories and links them to the constructed entity', async () => {
    const contribution = await analyzeProject(
      { 'package.json': { devDependencies: { fishery: '^2.2.2', jest: '^29.0.0' } } },
      {
        'src/factories/user.factory.test.ts': [
          "import { Factory } from 'fishery';",
          'interface User { id: string; name: string; }',
          'export const userFactory = Factory.define<User>(() => ({ id: "1", name: "x" }));',
        ].join('\n'),
      }
    );

    const fixtures = fixtureNodes(contribution);
    expect(fixtures.length).toBeGreaterThanOrEqual(1);
    const constructsEdges = (contribution.edges || []).filter(edge => edge.type === 'constructs');
    expect(constructsEdges.some(edge => edge.metadata?.attributes?.entity === 'User')).toBe(true);
  });

  it('does not attribute doubles when the mocking library is not imported (evidence-gated)', async () => {
    const contribution = await analyzeProject(
      {},
      {
        // "mock" appears but no mocking library is imported/declared
        'src/plain.test.ts': [
          'const mock = { value: 1 };',
          'function build() { return mock; }',
          'build();',
        ].join('\n'),
      }
    );
    expect(doubleNodes(contribution)).toHaveLength(0);
    expect(seamEdges(contribution)).toHaveLength(0);
  });
});
