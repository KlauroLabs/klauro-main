export interface CASSourceInputIdentity {
  path: string;
  status: 'captured' | 'conflicting' | 'unavailable';
  representation?: 'utf8-text' | 'bytes';
  sha256?: string;
  bytes?: number;
  reason?: string;
  error_code?: string;
}

export interface CASAnalyzerSourceInputs {
  version: 1;
  coverage: 'observed-reads' | 'unavailable';
  reason?: string;
  digest_algorithm: 'sha256';
  files: CASSourceInputIdentity[];
  outside_root_reads: number;
}

export interface CASAnalyzerSourceInputReferences extends Omit<CASAnalyzerSourceInputs, 'version' | 'files'> {
  version: 2;
  identity_indices: number[];
}

export type CASAnalyzerSourceInputEvidence = CASAnalyzerSourceInputs | CASAnalyzerSourceInputReferences;

export interface CASSourceInputCatalog {
  source_input_identities?: CASSourceInputIdentity[];
  source_input_root?: string;
  source_input_catalog?: { status: 'shared' | 'not-recorded' | 'unnormalized'; reason?: string };
}
