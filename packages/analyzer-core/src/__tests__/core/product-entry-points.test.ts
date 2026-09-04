import { libraryApiEvidenceExamples, productEntryPoints } from '../../analyzer/core/product-entry-points';
import type { CASEntryPoint, CASNode } from '../../types/cas.types';

function node(id: string, file: string, extra: Partial<CASNode> = {}): CASNode {
  return { id, name: id, type: 'function', level: 2, source: { file, line: 1 }, ...extra } as CASNode;
}
function entry(id: string, type: CASEntryPoint['type'], sourceNode: string, handlerFile?: string): CASEntryPoint {
  return { id, type, name: id, source_node: sourceNode, source_analyzer: 't', ...(handlerFile ? { handler: { node_id: sourceNode, file: handlerFile } } : {}) } as CASEntryPoint;
}

describe('productEntryPoints', () => {
  it('keeps entry points whose source node and handler file are product members and drops the rest', () => {
    const nodes = [node('lib_use', 'lib/application.js'), node('ci', '.github/workflows/ci.yml'), node('example', 'examples/hello.js')];
    const entries = [
      entry('api_use', 'api', 'lib_use', 'lib/application.js'),
      entry('ci_pull', 'schedule', 'ci'),
      entry('example_route', 'http', 'example', 'examples/hello.js'),
    ];
    const isProduct = (file: string) => file.startsWith('lib/');
    const kept = productEntryPoints(entries, nodes, n => isProduct(n.source?.file || ''), isProduct);
    expect(kept.map(ep => ep.id)).toEqual(['api_use']);
  });
});

describe('libraryApiEvidenceExamples', () => {
  it('carries the handler\'s name words, parameter names, return type, and doc summary as evidence', () => {
    const accepts = node('accepts', 'lib/request.js', {
      name: 'acceptsEncodings',
      signature: { parameters: [{ name: 'encoding' }, { name: 'preferredCharsets' }], return_type: 'string[]' },
      documentation: { raw: 'Check if the given encodings are acceptable for the request.', summary: 'Check if the given encodings are acceptable for the request.' },
    } as Partial<CASNode>);
    const examples = libraryApiEvidenceExamples([entry('api_accepts', 'api', 'accepts', 'lib/request.js')], new Map([['accepts', accepts]]));
    expect(examples).toHaveLength(1);
    for (const word of ['accepts', 'encodings', 'encoding', 'preferred', 'charsets', 'string', 'acceptable', 'request']) {
      expect(examples[0]).toContain(word);
    }
  });

  it('reads parameter names and return annotations kept under metadata attributes (Python shape)', () => {
    const route = node('route', 'pkg/routing.py', {
      name: 'add_api_route',
      metadata: { attributes: { parameters: [{ name: 'path', annotation: 'str' }, { name: 'endpoint' }], returnAnnotation: 'APIRoute' } },
      documentation: { raw: 'Add a path operation.', summary: 'Add a path operation.' },
    } as unknown as Partial<CASNode>);
    const [example] = libraryApiEvidenceExamples([entry('api_route', 'api', 'route', 'pkg/routing.py')], new Map([['route', route]]));
    for (const word of ['add', 'api', 'route', 'path', 'str', 'endpoint', 'operation']) expect(example).toContain(word);
  });

  it('ignores non-API entry points and handlers without a node', () => {
    expect(libraryApiEvidenceExamples([entry('http_x', 'http', 'missing')], new Map())).toEqual([]);
  });
});
