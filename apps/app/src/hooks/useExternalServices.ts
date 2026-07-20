import { useMemo } from 'react';
import { useProjectCas } from './useProjectCas';

/**
 * Local mirror of CASExternalService (packages/analyzer-core/src/types/cas.types.ts),
 * narrowed to the fields this lane renders.
 */
export interface ExternalService {
  id: string;
  name: string;
  type: string;
  purpose?: 'consumption' | 'production' | 'bidirectional';
  description?: string;
  endpoint?: string;
  provider?: string;
  connected_nodes?: string[];
  exit_points?: string[];
  entry_points?: string[];
}

/**
 * Reads external services out of the full CAS payload. Assumed shape:
 * `{ status, cas: { external_services?: ExternalService[] } }` — same
 * envelope convention as useExitPoints.ts / useEntryPoints.ts.
 */
export function useExternalServices(projectId: string | undefined) {
  const casQuery = useProjectCas(projectId);

  const externalServices = useMemo<ExternalService[]>(() => {
    const cas = casQuery.data?.status === 'ready' ? casQuery.data.cas : undefined;
    return (cas as { external_services?: ExternalService[] } | undefined)?.external_services ?? [];
  }, [casQuery.data]);

  return { ...casQuery, externalServices };
}
