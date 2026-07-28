import { detectSyntaxDegradation } from '../../analyzer/core/syntax-degradation';

describe('detectSyntaxDegradation', () => {
  it('flags a Java file with heavily unbalanced braces', () => {
    const content = 'public class Broken {\n  void a() {\n  void b() {\n  void c() {\n';
    const warning = detectSyntaxDegradation({
      relativePath: 'src/Broken.java',
      content,
      language: 'java',
      extractedNodeCount: 1,
    });
    expect(warning).toContain('src/Broken.java');
    expect(warning).toContain('broken syntax');
    expect(warning).toContain('braces');
  });

  it('does not flag a healthy Java file', () => {
    const content = 'public class Fine {\n  void a() { int x = 1; }\n  void b() { int y = (2 + 3); }\n}\n';
    expect(detectSyntaxDegradation({
      relativePath: 'src/Fine.java',
      content,
      language: 'java',
      extractedNodeCount: 1,
    })).toBeUndefined();
  });

  it('ignores braces inside strings and comments', () => {
    const content = [
      'public class Fine {',
      '  // comment with stray braces {{{',
      '  /* block comment {{{ */',
      '  String s = "{{{ not real {{{";',
      '  void a() { }',
      '}',
    ].join('\n');
    expect(detectSyntaxDegradation({
      relativePath: 'src/Fine.java',
      content,
      language: 'java',
      extractedNodeCount: 1,
    })).toBeUndefined();
  });

  it('flags a Python file with heavily unbalanced parentheses', () => {
    const content = 'def a(:\n    print((((\n\ndef b(((\n    pass\n';
    const warning = detectSyntaxDegradation({
      relativePath: 'app/broken.py',
      content,
      language: 'python',
      extractedNodeCount: 2,
    });
    expect(warning).toContain('app/broken.py');
    expect(warning).toContain('parentheses');
  });

  it('does not count delimiters inside Python triple-quoted strings', () => {
    const content = 'SQL = """\nSELECT ((( FROM (((\n"""\n\ndef ok():\n    return 1\n';
    expect(detectSyntaxDegradation({
      relativePath: 'app/ok.py',
      content,
      language: 'python',
      extractedNodeCount: 1,
    })).toBeUndefined();
  });

  it('does not count delimiters inside Ruby heredocs', () => {
    const content = [
      'class Report',
      '  QUERY = <<~SQL',
      '    SELECT ((( FROM (((',
      '  SQL',
      '  def run; end',
      'end',
    ].join('\n');
    expect(detectSyntaxDegradation({
      relativePath: 'app/report.rb',
      content,
      language: 'ruby',
      extractedNodeCount: 1,
    })).toBeUndefined();
  });

  it('flags a non-trivial file whose declarations produced zero extracted nodes', () => {
    const lines = ['class Broken:'];
    for (let i = 0; i < 12; i++) lines.push(`    value_${i} = ${i}`);
    const warning = detectSyntaxDegradation({
      relativePath: 'app/zero.py',
      content: lines.join('\n'),
      language: 'python',
      extractedNodeCount: 0,
    });
    expect(warning).toContain('app/zero.py');
    expect(warning).toContain('no code elements could be extracted');
  });

  it('does not flag a trivial file with zero extracted nodes', () => {
    expect(detectSyntaxDegradation({
      relativePath: 'app/tiny.py',
      content: 'x = 1\n',
      language: 'python',
      extractedNodeCount: 0,
    })).toBeUndefined();
  });

  it('does not flag an empty file', () => {
    expect(detectSyntaxDegradation({
      relativePath: 'app/empty.php',
      content: '   \n',
      language: 'php',
      extractedNodeCount: 0,
    })).toBeUndefined();
  });

  it('flags a PHP file with heavily unbalanced braces', () => {
    const content = '<?php\nclass Broken {\n  function a() {\n  function b() {\n  function c() {\n';
    const warning = detectSyntaxDegradation({
      relativePath: 'src/Broken.php',
      content,
      language: 'php',
      extractedNodeCount: 1,
    });
    expect(warning).toContain('braces');
  });

  it('does not flag a valid PHP 8 entity using multi-line attributes and constructor promotion', () => {
    // Regression for the truckspy false positive: `#[ORM\Column(...)]` was
    // matched by the PHP line-comment pattern (`#`), which truncated each
    // multi-line attribute at its first newline and discarded the closing
    // `)`/`]`, making a perfectly valid entity look delimiter-imbalanced.
    const content = [
      '<?php',
      'namespace App\\Entity;',
      '',
      'use Doctrine\\ORM\\Mapping as ORM;',
      '',
      '#[ORM\\Entity]',
      '#[ORM\\Table(name: "users")]',
      'class User',
      '{',
      '    #[ORM\\Id]',
      '    #[ORM\\GeneratedValue]',
      '    #[ORM\\Column(',
      '        type: "integer",',
      '    )]',
      '    private ?int $id = null;',
      '',
      '    #[ORM\\Column(',
      '        type: "string",',
      '        length: 255,',
      '    )]',
      '    private string $name;',
      '',
      '    public function __construct(',
      '        private readonly string $email,',
      '    ) {',
      '    }',
      '',
      '    public function getId(): ?int',
      '    {',
      '        return $this->id;',
      '    }',
      '}',
      '',
    ].join('\n');

    expect(detectSyntaxDegradation({
      relativePath: 'src/Entity/User.php',
      content,
      language: 'php',
      extractedNodeCount: 1,
    })).toBeUndefined();
  });

  it('still flags a PHP attribute-bearing file that is genuinely unbalanced', () => {
    const content = [
      '<?php',
      'class Broken',
      '{',
      '    #[ORM\\Column(',
      '        type: "string"',
      '    private string $name;',
      '',
      '    function a() {',
      '    function b() {',
      '    function c() {',
      '}',
    ].join('\n');

    const warning = detectSyntaxDegradation({
      relativePath: 'src/Entity/Broken.php',
      content,
      language: 'php',
      extractedNodeCount: 1,
    });
    expect(warning).toBeDefined();
  });

  it('flags a Dart file with heavily unbalanced braces', () => {
    const content = 'class Broken {\n  void a() {\n  void b() {\n  void c() {\n';
    const warning = detectSyntaxDegradation({
      relativePath: 'lib/broken.dart',
      content,
      language: 'dart',
      extractedNodeCount: 1,
    });
    expect(warning).toContain('braces');
  });
});
