/**
 * Local mirror of the analyzer-core DAS-adjacent CAS shapes (apps/app does
 * not depend on packages/analyzer-core — see api.ts / useEntryPoints.ts for
 * the same convention). Narrowed to only the fields this lane's picker and
 * per-unit slice actually read.
 */

export interface DeployableEvidence {
  root_path: string;
  name: string;
  tier: 1 | 2 | 3;
  kind: 'container' | 'compose-service' | 'k8s' | 'serverless' | 'installer' | 'ci-deploy' | 'bin' | 'server-entry' | 'package' | 'build-image';
  evidence: string[];
  ships_paths?: string[];
  ports?: number[];
  entrypoint_member?: string;
  base_images?: string[];
  bundled_into?: string;
}

export interface CasNode {
  id: string;
  source?: { file?: string };
}

export interface DataEntity {
  id: string;
  name: string;
  kind?: string;
  description?: string;
  lifecycle: {
    created_by: string[];
    read_by: string[];
    updated_by: string[];
    deleted_by: string[];
  };
}
