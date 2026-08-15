import type { CASExitPoint, CASNode, CASOutput, DeployableEvidence } from '../../../types/cas.types';












export interface EvidenceCollectionContext {
  cas: Partial<CASOutput>;
  projectPath: string;
  nodes: CASNode[];
  exitPoints: CASExitPoint[];








  displayName?: string;
}


export interface EvidenceProvider {
  id: string;
  tier: 1 | 2 | 3;
  collect(ctx: EvidenceCollectionContext): DeployableEvidence[];
}

export type { DeployableEvidence };
