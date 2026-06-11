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

describe('PHP external call classification', () => {
  const analyzer = new PHPAnalyzer() as any;

  it('does not classify pure language builtins as external library calls', () => {
    for (const builtin of ['array_filter', 'array_map', 'isset', 'empty', 'json_encode', 'json_decode', 'str_replace', 'count', 'implode', 'usort', 'preg_match', 'sprintf']) {
      expect(analyzer.isExternalLibraryCall(builtin, builtin, 'App\\Service')).toBe(false);
    }
  });

  it('keeps boundary-crossing builtins as external calls', () => {
    for (const builtin of ['curl_exec', 'file_get_contents', 'mysqli_connect', 'mail', 'shell_exec']) {
      expect(analyzer.isExternalLibraryCall(builtin, builtin, 'App\\Service')).toBe(true);
    }
  });

  it('keeps framework facade and namespaced calls as external calls', () => {
    expect(analyzer.isExternalLibraryCall('DB', 'table', 'App\\Service')).toBe(true);
    expect(analyzer.isExternalLibraryCall('PDO', 'query', 'App\\Service')).toBe(true);
    expect(analyzer.isExternalLibraryCall('\\Stripe\\Charge', 'create', 'App\\Service')).toBe(true);
  });
});
