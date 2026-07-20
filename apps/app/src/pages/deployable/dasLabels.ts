import type { DeployableEvidence } from './dasTypes';

/** Plain-language labels for the raw evidence vocabulary — construction
 *  terms (container, compose-service, k8s...) read fine to an engineer but
 *  the tier number needs unpacking every time, so it's spelled out once. */
export const TIER_LABEL: Record<1 | 2 | 3, string> = {
  1: 'Ship declaration',
  2: 'Runnable entry',
  3: 'Package identity',
};

export const KIND_LABEL: Record<DeployableEvidence['kind'], string> = {
  container: 'Container (Dockerfile)',
  'compose-service': 'Compose service',
  k8s: 'Kubernetes manifest',
  serverless: 'Serverless function',
  installer: 'Installer',
  'ci-deploy': 'CI/CD deploy step',
  bin: 'Binary',
  'server-entry': 'Server entry',
  package: 'Package',
  'build-image': 'Build image',
};
