
import { CASEntryPoint, DeployableEvidence } from '../../types/cas.types';

export function determineSystemType(
  entryPoints: CASEntryPoint[],
  deployableEvidence: DeployableEvidence[]
): string {
  const topLevelShipUnits = deployableEvidence.filter(
    e => e.tier === 1 && e.kind !== 'build-image' && !e.bundled_into
  );
  if (topLevelShipUnits.length > 1) return 'monorepo';

  const NETWORK_ENTRY_TYPES = new Set<CASEntryPoint['type']>([
    'http', 'websocket', 'rpc', 'graphql', 'api'
  ]);
  const NON_INVOCATION_ENTRY_TYPES = new Set<CASEntryPoint['type']>(['test', 'lifecycle']);
  const realEntryPoints = entryPoints.filter(e => !NON_INVOCATION_ENTRY_TYPES.has(e.type));
  const hasNetworkEntryPoint = realEntryPoints.some(e => NETWORK_ENTRY_TYPES.has(e.type));
  if (hasNetworkEntryPoint) return 'service';

  const hasRuntimeEntryPoint = realEntryPoints.length > 0;
  const hasShipOrRunnableEvidence = deployableEvidence.some(e => e.tier === 1 || e.tier === 2);
  if (hasRuntimeEntryPoint || hasShipOrRunnableEvidence) {
    return 'application';
  }
  if (deployableEvidence.some(e => e.tier === 3)) return 'library';

  return 'application';
}
