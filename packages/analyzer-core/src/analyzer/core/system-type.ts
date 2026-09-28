import { CASEntryPoint, DeployableEvidence } from '../../types/cas.types';

const NETWORK_ENTRY_TYPES = new Set<CASEntryPoint['type']>(['http', 'websocket', 'rpc', 'graphql', 'api', 'tool']);
const NON_INVOCATION_ENTRY_TYPES = new Set<CASEntryPoint['type']>(['test', 'lifecycle']);

const isIndependentlyDeployable = (evidence: DeployableEvidence): boolean =>
  evidence.tier === 1 && evidence.kind !== 'build-image' && !evidence.bundled_into;

const isInvocable = (entryPoint: CASEntryPoint): boolean =>
  !NON_INVOCATION_ENTRY_TYPES.has(entryPoint.type);

const isNetworkFacing = (entryPoint: CASEntryPoint): boolean =>
  NETWORK_ENTRY_TYPES.has(entryPoint.type);

const shipsOrRuns = (evidence: DeployableEvidence): boolean =>
  evidence.tier === 1 || evidence.tier === 2;

const declaresPackageIdentity = (evidence: DeployableEvidence): boolean => evidence.tier === 3;

export function determineSystemType(
  entryPoints: CASEntryPoint[],
  deployableEvidence: DeployableEvidence[],
): string {
  if (deployableEvidence.filter(isIndependentlyDeployable).length > 1) return 'monorepo';

  const invocableEntryPoints = entryPoints.filter(isInvocable);
  if (invocableEntryPoints.some(isNetworkFacing)) return 'service';
  if (invocableEntryPoints.length > 0 || deployableEvidence.some(shipsOrRuns)) return 'application';
  if (deployableEvidence.some(declaresPackageIdentity)) return 'library';

  return 'application';
}
