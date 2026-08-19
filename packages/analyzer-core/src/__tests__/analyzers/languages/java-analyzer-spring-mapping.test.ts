jest.unmock('fs');
jest.unmock('fs-extra');
jest.unmock('glob');

import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { JavaAnalyzer } from '../../../analyzer/languages/java-analyzer';

describe('JavaAnalyzer Spring mapping ownership', () => {
  let projectPath: string;

  beforeEach(async () => {
    projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'java-spring-mapping-'));
  });

  afterEach(async () => {
    await fs.remove(projectPath);
  });

  it('emits endpoint edges only for method-level mappings with real entry sources', async () => {
    const relativePath = 'OwnerResource.java';
    const filePath = path.join(projectPath, relativePath);
    await fs.writeFile(filePath, [
      '/** Base class for owner endpoints. */',
      '@RequestMapping("/owners")',
      '@RestController',
      'class OwnerResource {',
      '  private static final Logger log = LoggerFactory.getLogger(OwnerResource.class);',
      '  @PostMapping("/{id}")',
      '  public Owner create(',
      '      int id,',
      '      String name) {',
      '    return repository.findById(id)',
      '      .orElseThrow(() -> new ResourceNotFoundException());',
      '  }',
      '  private void verify() {',
      '    assertNotNull(name, "source property toString() returned null");',
      '  }',
      '  static class Nested {',
      '    void nested() {',
      '      verify();',
      '    }',
      '  }',
      '}',
    ].join('\n'));

    const result = await new JavaAnalyzer().analyzeFileSingle({ projectPath, filePath, relativePath });
    const entryIds = new Set(result.entryPoints.map(entry => entry.id));
    const exposedMethods = result.edges
      .filter(edge => edge.type === 'exposes')
      .map(edge => result.nodes.find(node => node.id === edge.target)?.name);
    const endpoint = result.entryPoints.find(entry => entry.type === 'http');

    expect(exposedMethods).toEqual(['create']);
    expect(result.edges.filter(edge => edge.type === 'exposes').every(edge => entryIds.has(edge.source))).toBe(true);
    expect(endpoint?.trigger).toEqual({ method: 'POST', path: '/owners/:id' });
    expect(endpoint?.handler?.method_name).toBe('create');
    expect(result.nodes.filter(node => node.type === 'method' && node.name === 'nested')).toHaveLength(1);
    expect(result.nodes.some(node => node.type === 'method' && node.name === 'assertNotNull')).toBe(false);
    expect(result.nodes.some(node => node.type === 'class' && node.name === 'for')).toBe(false);
  });
});
