import { partitionAnalysisDiagnostics } from '../../analyzer/core/analysis-diagnostics';

describe('analysis diagnostics', () => {
  it('separates fatal errors from tier warnings and information', () => {
    const diagnostics = partitionAnalysisDiagnostics([
      { severity: 'error', code: 'PARSE_FAILED', message: 'Parser failed' },
      { severity: 'warning', code: 'PARTIAL_ANALYSIS', message: 'Tier cap applied' },
      { severity: 'info', code: 'OPTIONAL_ANALYZER_SKIPPED', message: 'Optional analyzer skipped' },
    ]);

    expect(diagnostics.errors.map(item => item.code)).toEqual(['PARSE_FAILED']);
    expect(diagnostics.warnings.map(item => item.code)).toEqual(['PARTIAL_ANALYSIS']);
    expect(diagnostics.information.map(item => item.code)).toEqual(['OPTIONAL_ANALYZER_SKIPPED']);
  });
});
