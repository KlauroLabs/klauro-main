import type { CASExitPoint, CASEntryPointFlowTerminalEntity } from '../../types/cas.types';

export interface TerminalEffects {
  entitiesWritten: string[];
  entitiesRead: string[];
  externalServices: string[];
  messagesEmitted: string[];
  terminalEntities: CASEntryPointFlowTerminalEntity[];
  exitPointIds: string[];
  unresolvedExitPointIds: string[];
  hasAnyEffect: boolean;
}

export function hasUnresolvedDependencyEffect(exitPoint: CASExitPoint): boolean {
  return exitPoint.type === 'sdk' && !exitPoint.target?.service_id;
}
