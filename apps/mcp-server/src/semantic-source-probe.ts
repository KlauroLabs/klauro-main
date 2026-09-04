import * as path from 'path';

const SEMANTIC_SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rb', '.php', '.java', '.cs', '.go', '.rs', '.dart',
  '.sh', '.bash', '.zsh', '.ksh', '.sol',
  '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx',
  '.swift', '.kt', '.kts', '.ex', '.exs', '.proto', '.tf', '.tfvars',
  '.sql', '.ddl',
]);

export function supportsSemanticSourceProbe(file: string): boolean {
  return SEMANTIC_SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase());
}

export function semanticProbeForExtension(extension: string, index: number): string | null {
  const suffix = Math.abs(Math.trunc(index));
  switch (extension.toLowerCase()) {
    case '.ts':
    case '.tsx':
    case '.mts':
    case '.cts':
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return `function analysisBenchmarkProbe${suffix}() { return ${suffix}; }`;
    case '.php':
      return `function analysis_benchmark_probe_${suffix}(): int { return ${suffix}; }`;
    case '.java':
      return `class AnalysisBenchmarkProbe${suffix} { int value() { return ${suffix}; } }`;
    case '.cs':
      return `internal sealed class AnalysisBenchmarkProbe${suffix} { internal int Value() => ${suffix}; }`;
    case '.go':
      return `func analysisBenchmarkProbe${suffix}() int { return ${suffix} }`;
    case '.rs':
      return `fn analysis_benchmark_probe_${suffix}() -> usize { ${suffix} }`;
    case '.dart':
      return `int _analysisBenchmarkProbe${suffix}() => ${suffix};`;
    case '.py':
      return `def analysis_benchmark_probe_${suffix}():\n    return ${suffix}`;
    case '.rb':
      return `def analysis_benchmark_probe_${suffix}\n  ${suffix}\nend`;
    case '.sh':
    case '.bash':
    case '.zsh':
    case '.ksh':
      return `analysis_benchmark_probe_${suffix}() { printf '%s\\n' '${suffix}'; }`;
    case '.sol':
      return `contract AnalysisBenchmarkProbe${suffix} { function value() external pure returns (uint256) { return ${suffix}; } }`;
    case '.c':
    case '.h':
    case '.cpp':
    case '.cc':
    case '.cxx':
    case '.hpp':
    case '.hh':
    case '.hxx':
      return `static int analysis_benchmark_probe_${suffix}(void) { return ${suffix}; }`;
    case '.swift':
      return `private func analysisBenchmarkProbe${suffix}() -> Int { ${suffix} }`;
    case '.kt':
    case '.kts':
      return `private fun analysisBenchmarkProbe${suffix}(): Int = ${suffix}`;
    case '.ex':
    case '.exs':
      return `defmodule AnalysisBenchmarkProbe${suffix} do\n  def value, do: ${suffix}\nend`;
    case '.proto':
      return `message AnalysisBenchmarkProbe${suffix} { int32 value = 1; }`;
    case '.tf':
      return `variable "analysis_benchmark_probe_${suffix}" {\n  default = ${suffix}\n}`;
    case '.tfvars':
      return `analysis_benchmark_probe_${suffix} = ${suffix}`;
    case '.sql':
    case '.ddl':
      return `CREATE TABLE analysis_benchmark_probe_${suffix} (value INTEGER);`;
    default:
      return null;
  }
}

export function semanticProbeForSource(file: string, content: string, index: number): string | null {
  const extension = path.extname(file).toLowerCase();
  const probe = semanticProbeForExtension(extension, index);
  if (!probe) return null;
  if (extension === '.php' && content.trimEnd().endsWith('?>')) return `<?php\n${probe}`;
  return probe;
}

export function appendSemanticSourceProbe(file: string, content: string, index: number): string | null {
  const probe = semanticProbeForSource(file, content, index);
  if (!probe) return null;
  return `${content.replace(/\s+$/u, '')}\n\n${probe}\n`;
}
