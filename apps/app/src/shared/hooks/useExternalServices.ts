import { useMemo } from 'react';
import { useProjectCas } from './useProjectCas';

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

export function useExternalServices(projectId: string | undefined) {
  const casQuery = useProjectCas(projectId);

  const externalServices = useMemo<ExternalService[]>(() => {
    const cas = casQuery.data?.status === 'ready' ? casQuery.data.cas : undefined;
    return (cas as { external_services?: ExternalService[] } | undefined)?.external_services ?? [];
  }, [casQuery.data]);

  return { ...casQuery, externalServices };
}
