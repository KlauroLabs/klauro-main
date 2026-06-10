import { PHPAnalyzer } from '../../analyzer/languages/php-analyzer';

describe('PHP analyzer classification', () => {
  it('does not classify methods, closures, or locals as top-level PHP symbols', () => {
    const analyzer = new PHPAnalyzer() as any;
    const content = [
      '<?php',
      'namespace App\\Service;',
      '',
      'const TOP_LEVEL_CONST = "ok";',
      '$topLevel = true;',
      '',
      'function topLevelFunction(): void {',
      '  $insideFunction = true;',
      '}',
      '',
      'class BillingManager {',
      '  const CLASS_CONST = "no";',
      '  private string $status;',
      '',
      '  public function charge(): void {',
      '    $local = true;',
      '    $callback = function () { return true; };',
      '  }',
      '}',
    ].join('\n');

    const functions = analyzer.extractFunctions(content, 'src/Service/BillingManager.php');
    const variables = analyzer.extractGlobalVariables(content);
    const constants = analyzer.extractGlobalConstants(content);

    expect(functions.map((item: any) => item.name)).toEqual(['topLevelFunction']);
    expect(variables.map((item: any) => item.name)).toEqual(['topLevel']);
    expect(constants.map((item: any) => item.name)).toEqual(['TOP_LEVEL_CONST']);
  });
});
