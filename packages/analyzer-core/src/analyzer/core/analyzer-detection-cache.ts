export interface AnalyzerDetectionEvidence {
  registryFingerprint: string;
  analyzerIds: string[];
  projectRoots: string[];
  manifestOwningProjectRoots: string[];
  analyzerRootEntries: Array<[string, string]>;
  expiresAt: number;
}

const MAX_ENTRIES = 64;
const cache = new Map<string, AnalyzerDetectionEvidence>();

export function getAnalyzerDetectionEvidence(projectPath: string, registryFingerprint: string): AnalyzerDetectionEvidence | undefined {
  const evidence = cache.get(projectPath);
  if (!evidence || evidence.registryFingerprint !== registryFingerprint || evidence.expiresAt <= Date.now()) return undefined;
  cache.delete(projectPath);
  cache.set(projectPath, evidence);
  return evidence;
}

export function setAnalyzerDetectionEvidence(projectPath: string, evidence: AnalyzerDetectionEvidence): void {
  cache.delete(projectPath);
  cache.set(projectPath, evidence);
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
}

export function refreshAnalyzerDetectionEvidence(projectPath: string, registryFingerprint: string, expiresAt: number): void {
  const evidence = cache.get(projectPath);
  if (!evidence || evidence.registryFingerprint !== registryFingerprint) return;
  evidence.expiresAt = expiresAt;
}

export function invalidateAnalyzerDetectionEvidence(projectPath: string): void {
  cache.delete(projectPath);
}
