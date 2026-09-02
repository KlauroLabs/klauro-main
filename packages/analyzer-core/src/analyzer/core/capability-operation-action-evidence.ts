import type { CASEntryPoint, SystemCapability } from '../../types/cas.types';
import { canonicalCapabilityLifecycleAction } from './capability-lifecycle-actions';
import { semanticActions } from './capability-operation-language';

interface CapabilityOperationActionEvidenceArgs {
  operation: SystemCapability['operations'][number];
  entry?: CASEntryPoint;
  declarationActions?: string[];
  operationText: string;
  hasTerminalEffects: boolean;
  hasDirectSignature: boolean;
}

export function capabilityOperationActionEvidence(
  args: CapabilityOperationActionEvidenceArgs,
): { operationActions: string[]; routeFallbackActions: string[] } {
  const method = String(args.operation.trigger?.method || args.entry?.trigger?.method || '').toUpperCase();
  const genericAction = canonicalCapabilityLifecycleAction({
    action: args.operation.action,
    trigger: { method },
  });
  const routeAction = canonicalCapabilityLifecycleAction({
    action: args.operation.action,
    path_or_command: args.operation.path_or_command,
    trigger: { method, path: args.operation.trigger?.path || args.entry?.trigger?.path },
  });
  const routeSpecificAction = routeAction && routeAction !== genericAction;
  const operationActions = routeSpecificAction
    ? [routeAction]
    : [...new Set([
      ...(args.declarationActions || semanticActions(args.operationText)),
      ...(!args.hasTerminalEffects && args.hasDirectSignature && method === 'GET' ? ['read'] : []),
    ])];
  return { operationActions, routeFallbackActions: routeSpecificAction ? [routeAction] : semanticActions(args.operation.action) };
}
