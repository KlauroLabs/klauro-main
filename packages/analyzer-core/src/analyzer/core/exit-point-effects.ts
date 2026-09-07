import type { CASExitPoint, CASUserJourneyTerminalEntity } from '../../types/cas.types';

export interface TerminalEffects {
  entitiesWritten: string[];
  entitiesRead: string[];
  externalServices: string[];
  messagesEmitted: string[];
  terminalEntities: CASUserJourneyTerminalEntity[];
  exitPointIds: string[];
  unresolvedExitPointIds: string[];
  hasAnyEffect: boolean;
}

export function hasUnresolvedDependencyEffect(exitPoint: CASExitPoint): boolean {
  return exitPoint.type === 'sdk' && !exitPoint.target?.service_id;
}
