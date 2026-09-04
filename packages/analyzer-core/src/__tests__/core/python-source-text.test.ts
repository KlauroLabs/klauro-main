import { maskPythonTripleQuotedStrings } from '../../analyzer/frameworks/web/python-source-text';

describe('maskPythonTripleQuotedStrings', () => {
  it('blanks docstring bodies while keeping every line in place', () => {
    const source = [
      'def get(self, path):',
      '    """Add a path operation.',
      '',
      '    @app.get("/items/")',
      '    def read_items(): ...',
      '    """',
      '    return path',
      '@router.get("/real")',
      'def real(): ...',
    ].join('\n');
    const masked = maskPythonTripleQuotedStrings(source);
    expect(masked.split('\n')).toHaveLength(9);
    expect(masked).not.toContain('@app.get("/items/")');
    expect(masked).toContain('@router.get("/real")');
    expect(masked.split('\n')[0]).toBe('def get(self, path):');
  });

  it('handles single-line docstrings, single-quoted triples, and code after a closing quote', () => {
    const source = ['x = """one line"""; y = 1', "s = '''a", "@app.get('/hidden')", "'''", '@app.post("/seen")'].join('\n');
    const masked = maskPythonTripleQuotedStrings(source);
    expect(masked.split('\n')[0]).toBe('x = ; y = 1');
    expect(masked).not.toContain('/hidden');
    expect(masked).toContain('@app.post("/seen")');
  });
});
