jest.unmock('glob');
jest.unmock('fs');
jest.unmock('fs-extra');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { PythonAnalyzer } from '../../../analyzer/languages/python-analyzer';
import { CASNode } from '../../../types/cas.types';

/**
 * Regression (P0, silent data loss): hercules/portals-backend GraphQL schema.py
 * files were flagged `PARTIAL_ANALYSIS` / "contains declaration keywords but no
 * code elements could be extracted" on real, valid Django/Graphene code. Root
 * cause was in the extractor, not a heuristic: extractClasses/extractFunctions
 * matched `class X(...):` / `def f(...):` against a single physical line only.
 * Graphene "combine every resolver mixin" Query classes and typed Django
 * views routinely wrap their signature across multiple lines (black/yapf
 * formatting), so the regex never matched and the file's classes/functions
 * were silently dropped from the graph even though the file parses cleanly.
 * Fixed via PythonAnalyzer#collectLogicalStatement, which joins a multi-line
 * class/def signature before matching.
 */
describe('PythonAnalyzer multi-line class/def signatures', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'python-multiline-'));
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  async function analyzePython(fileName: string, source: string): Promise<CASNode[]> {
    const filePath = path.join(tmpDir, fileName);
    await fs.writeFile(filePath, source, 'utf-8');
    const analyzer = new PythonAnalyzer();
    const result = await analyzer.analyzeFileSingle({
      projectPath: tmpDir,
      filePath,
      relativePath: fileName,
    });
    return result.nodes;
  }

  it('extracts a Graphene Query class whose base-class list wraps across lines', async () => {
    const source = [
      'import graphene',
      'from modules.companies.schema import CompanyQuery',
      'from modules.products.schema import ProductQuery',
      '',
      'class Query(',
      '    CompanyQuery,',
      '    ProductQuery,',
      '    graphene.ObjectType,',
      '):',
      '    """Root schema query combining every module mixin."""',
      '',
      '    pass',
      '',
    ].join('\n');

    const nodes = await analyzePython('schema.py', source);
    const classNode = nodes.find(n => n.type === 'class' && n.name === 'Query');
    expect(classNode).toBeDefined();
  });

  it('does not emit a PARTIAL_ANALYSIS warning for the wrapped Query class file', async () => {
    const source = [
      'import graphene',
      '',
      'class Query(',
      '    graphene.ObjectType,',
      '):',
      '    pass',
      '',
      '',
      '',
      '# padding to make the file non-trivial for the degradation heuristic',
      '# line 1',
      '# line 2',
      '# line 3',
      '# line 4',
      '# line 5',
      '# line 6',
      '# line 7',
      '',
    ].join('\n');

    const filePath = path.join(tmpDir, 'schema.py');
    await fs.writeFile(filePath, source, 'utf-8');
    const analyzer = new PythonAnalyzer();
    await analyzer.analyzeFileSingle({
      projectPath: tmpDir,
      filePath,
      relativePath: 'schema.py',
    });

    const warnings: string[] = (analyzer as unknown as { analysisWarnings: string[] }).analysisWarnings || [];
    const partial = warnings.filter(w => w.includes('broken syntax') || w.includes('no code elements'));
    expect(partial).toHaveLength(0);
  });

  it('extracts a multiline function with nested calls in parameter defaults', async () => {
    const source = [
      'from fastapi import Depends, Path',
      '',
      'async def get_article(',
      '    slug: str = Path(..., min_length=1),',
      '    user = Depends(get_current_user(required=False)),',
      ') -> Article:',
      '    return await load_article(slug, user)',
      '',
    ].join('\n');

    const nodes = await analyzePython('dependencies.py', source);
    const functionNode = nodes.find(n => n.type === 'function' && n.name === 'get_article');
    expect(functionNode).toBeDefined();
    expect(functionNode?.source?.line).toBe(6);
  });

  it('extracts a function whose typed parameter list wraps across lines', async () => {
    const source = [
      'def resolve_orders(',
      '    self,',
      '    info,',
      '    status: str = "open",',
      '):',
      '    return []',
      '',
    ].join('\n');

    const nodes = await analyzePython('tasks.py', source);
    const fnNode = nodes.find(n => n.type === 'function' && n.name === 'resolve_orders');
    expect(fnNode).toBeDefined();
  });

  it('extracts a method whose typed parameter list wraps across lines', async () => {
    const source = [
      'class Resolver:',
      '    def resolve_orders(',
      '        self,',
      '        info,',
      '        status: str = "open",',
      '    ):',
      '        return []',
      '',
    ].join('\n');

    const nodes = await analyzePython('resolver.py', source);
    const methodNode = nodes.find(n => n.type === 'method' && n.name === 'resolve_orders');
    expect(methodNode).toBeDefined();
  });
});
