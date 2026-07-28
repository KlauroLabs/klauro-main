jest.unmock('glob');
jest.unmock('fs');
jest.unmock('fs-extra');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { PHPAnalyzer } from '../../../analyzer/languages/php-analyzer';
import { CASNode } from '../../../types/cas.types';

/**
 * Regression (P0, silent data loss) for the truckspy false positive: 14
 * Symfony `src/Entity/*.php` files were flagged `PARTIAL_ANALYSIS` /
 * "unbalanced parentheses"/"brackets" on valid PHP. The syntax-degradation
 * heuristic's PHP line-comment pattern matched `#` unconditionally, so a
 * multi-line PHP 8 attribute (`#[ORM\Column(\n type: "string",\n)]`) was
 * truncated at its first newline and its closing `)`/`]` discarded from the
 * delimiter count. Fixed in syntax-degradation.ts by excluding `#[` from the
 * PHP line-comment match (see syntax-degradation.test.ts for the pure
 * heuristic regression).
 *
 * Separately, and independent of that heuristic, `PHPAnalyzer#isPropertyDeclaration`
 * excluded any line containing `=`, which silently dropped every typed
 * property declared with a default value — including `private ?int $id`,
 * the primary key on nearly every Doctrine entity — from the extracted
 * graph regardless of whether the false-positive warning fired. Fixed by
 * removing that exclusion; the existing structural regex in
 * extractProperties already distinguishes a real declaration from
 * incidental text.
 */
describe('PHPAnalyzer entity attributes and typed defaults', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'php-entity-'));
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  async function analyzePhp(fileName: string, source: string): Promise<{ nodes: CASNode[]; analyzer: PHPAnalyzer }> {
    const filePath = path.join(tmpDir, fileName);
    await fs.writeFile(filePath, source, 'utf-8');
    const analyzer = new PHPAnalyzer();
    const result = await analyzer.analyzeFileSingle!({
      projectPath: tmpDir,
      filePath,
      relativePath: fileName,
    });
    return { nodes: result.nodes, analyzer };
  }

  const entitySource = [
    '<?php',
    '',
    'namespace App\\Entity;',
    '',
    'use Doctrine\\ORM\\Mapping as ORM;',
    '',
    '#[ORM\\Entity(repositoryClass: UserRepository::class)]',
    "#[ORM\\Table(name: '`user`')]",
    'class User',
    '{',
    '    #[ORM\\Id]',
    '    #[ORM\\GeneratedValue]',
    '    #[ORM\\Column(',
    "        type: 'integer',",
    '    )]',
    '    private ?int $id = null;',
    '',
    '    #[ORM\\Column(',
    "        type: 'string',",
    '        length: 255,',
    '    )]',
    '    private string $email;',
    '',
    '    public function getId(): ?int',
    '    {',
    '        return $this->id;',
    '    }',
    '}',
    '',
  ].join('\n');

  it('extracts the entity with no PARTIAL_ANALYSIS delimiter warning', async () => {
    const { analyzer } = await analyzePhp('User.php', entitySource);
    const warnings: string[] = (analyzer as unknown as { analysisWarnings: string[] }).analysisWarnings || [];
    expect(warnings.filter(w => w.includes('unbalanced'))).toHaveLength(0);
  });

  it('extracts the id property even though it has a default value (`= null`)', async () => {
    const { nodes } = await analyzePhp('User.php', entitySource);
    const propertyNames = nodes.filter(n => n.type === 'property').map(n => n.name);
    expect(propertyNames).toContain('id');
    expect(propertyNames).toContain('email');
  });
});
