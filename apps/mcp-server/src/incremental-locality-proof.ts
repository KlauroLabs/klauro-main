export interface IncrementalLocalityEvidence {
  strategy: string;
  directChangedFiles: number;
  graphAffectedFiles: number;
  analyzedFiles: number;
  reusedFiles: number;
}

export function provesIncrementalLocality(locality: IncrementalLocalityEvidence | undefined): boolean {
  if (!locality || locality.strategy === 'full-rebuild') return false;
  if (locality.reusedFiles > 0) return true;
  const affectedScopeSize = locality.directChangedFiles + locality.graphAffectedFiles;
  return affectedScopeSize > 0 && locality.analyzedFiles <= affectedScopeSize;
}
