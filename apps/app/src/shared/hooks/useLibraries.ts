import { useMemo } from 'react';
import { useProjectCas } from './useProjectCas';

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
