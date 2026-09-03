import type { CASEntryPoint, SystemCapability } from '../../types/cas.types';
import type { CapabilityCatalogProjectSignal } from './capability-catalog-evidence';
import { firstPartySupportsIdentityProduct } from './capability-catalog-metrics';

function capabilityIsIdentityMechanism(
  capability: SystemCapability,
  entryPointById: Map<string, CASEntryPoint>,
): boolean {
  const operations = capability.operations || [];
  if (operations.length === 0) return false;
  const identityPattern = /\b(?:auth(?:enticate|entication|orize|orization)?|credentials?|log[ -]?in|log[ -]?out|password|register|registration|session|sign[ -]?in|sign[ -]?out|sign[ -]?up|tokens?)\b/i;
  const identityOperations = operations.filter(operation => {
    const entryPoint = entryPointById.get(operation.entry_point_id);
    return identityPattern.test([
      operation.action,
      operation.path_or_command,
      operation.trigger?.path,
      entryPoint?.name,
      entryPoint?.trigger?.path,
    ].filter(Boolean).join(' '));
  });
  const capabilityIdentity = `${capability.name} ${capability.structural_label || ''}`
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return identityPattern.test(capabilityIdentity) && identityOperations.length === operations.length;
}

export function capabilityIsSupportingIdentityMechanism(
  capability: SystemCapability,
  entryPointById: Map<string, CASEntryPoint>,
  projectTextSignal?: CapabilityCatalogProjectSignal,
): boolean {
  return capabilityIsIdentityMechanism(capability, entryPointById) &&
    !firstPartySupportsIdentityProduct(projectTextSignal);
}
