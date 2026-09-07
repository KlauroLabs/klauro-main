export type CASCoverageGapKind =
  | 'source-file-excluded'
  | 'unknown-dependency'
  | 'low-extraction-ratio'
  | 'zero-entry-points'
  | 'unhandled-node-type';
export interface CASCoverageGap {
  kind: CASCoverageGapKind;
  evidence: string;
  file?: string;
  severity: 'low' | 'medium' | 'high';
  key?: string;
  detail?: Record<string, unknown>;
}
