import type { CASAnalysisError } from '../../types/cas.types';

export interface CASAnalysisDiagnostics {
  errors: CASAnalysisError[];
  warnings: CASAnalysisError[];
  information: CASAnalysisError[];
}

export function partitionAnalysisDiagnostics(
  diagnostics: CASAnalysisError[] | undefined,
): CASAnalysisDiagnostics {
  const errors: CASAnalysisError[] = [];
  const warnings: CASAnalysisError[] = [];
  const information: CASAnalysisError[] = [];
  for (const diagnostic of diagnostics || []) {
    if ((diagnostic.severity || 'error') === 'error') errors.push(diagnostic);
    else if (diagnostic.severity === 'warning') warnings.push(diagnostic);
    else information.push(diagnostic);
  }
  return { errors, warnings, information };
}
