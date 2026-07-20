import { useMemo } from 'react';
import { useProjectCas } from './useProjectCas';

/**
 * Local mirrors of CASLibrary and CASDependencyManifest/CASDeclaredDependency
 * (packages/analyzer-core/src/types/cas.types.ts), narrowed to the fields
 * this lane renders.
 *
 * Two distinct facts live under "libraries" and are kept separate rather
 * than merged, per the data model's own split: `libraries` is the subset
 * framework/library detectors recognized and interpreted (usage patterns,
 * criticality); `dependency_manifest` is the COMPLETE raw declared-dependency
 * list straight out of every package.json/requirements.txt/etc — a fact
 * bundle with no interpretation. A dependency can appear in the manifest
 * with zero library-detector coverage (small, well-behaved libraries with no
 * detected usage pattern); that is a real, honest case, not a bug.
 */
export interface Library {
  id: string;
  name: string;
  version?: string;
  type?: 'production' | 'development' | 'peer' | 'optional';
  category?: string;
  package_manager?: string;
  description?: string;
  usage_patterns?: Array<{ pattern?: string; occurrences?: number }>;
  usage_statistics?: { import_count?: number; usage_frequency?: string; critical_path?: boolean };
}

export interface DeclaredDependency {
  name: string;
  ecosystem: 'npm' | 'pypi' | 'cargo' | 'go' | 'unknown';
  version?: string;
  scopes: Array<'runtime' | 'dev' | 'peer' | 'optional' | 'build'>;
  declared_in: string[];
}

export interface DependencyManifest {
  manifests: string[];
  dependencies: DeclaredDependency[];
  total: number;
}

/**
 * Reads library + declared-dependency facts out of the full CAS payload.
 * Assumed shape: `{ status, cas: { libraries?: Library[], dependency_manifest?:
 * DependencyManifest } }` — same envelope convention as the lane's other
 * hooks.
 */
export function useLibraries(projectId: string | undefined) {
  const casQuery = useProjectCas(projectId);

  const libraries = useMemo<Library[]>(() => {
    const cas = casQuery.data?.status === 'ready' ? casQuery.data.cas : undefined;
    return (cas as { libraries?: Library[] } | undefined)?.libraries ?? [];
  }, [casQuery.data]);

  const dependencyManifest = useMemo<DependencyManifest | undefined>(() => {
    const cas = casQuery.data?.status === 'ready' ? casQuery.data.cas : undefined;
    return (cas as { dependency_manifest?: DependencyManifest } | undefined)?.dependency_manifest;
  }, [casQuery.data]);

  return { ...casQuery, libraries, dependencyManifest };
}
