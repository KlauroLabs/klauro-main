import { CAS_VERSION } from '../../../packages/analyzer-core/src/types/cas.types';

export const MINIMUM_COMPATIBLE_CAS_VERSION = '1.6.0';

export type AnalysisVersionStatus = 'current' | 'older-compatible' | 'newer-compatible' | 'unsupported' | 'newer-major';

export interface AnalysisVersionInfo {
  stored_version: string;
  current_version: string;
  minimum_compatible_version: string;
  status: AnalysisVersionStatus;
}

export function parseCasVersion(version: string | undefined): [number, number, number] | null {
  if (!version) return null;
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareCasVersions(a: string | undefined, b: string | undefined): number {
  const left = parseCasVersion(a) || [0, 0, 0];
  const right = parseCasVersion(b) || [0, 0, 0];
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

export function describeAnalysisVersion(storedVersion: string | undefined): AnalysisVersionInfo {
  const stored = parseCasVersion(storedVersion) ? (storedVersion as string).trim() : '0.0.0';
  const current = parseCasVersion(CAS_VERSION) || [0, 0, 0];
  const parsed = parseCasVersion(stored) || [0, 0, 0];
  const status: AnalysisVersionStatus = parsed[0] > current[0]
    ? 'newer-major'
    : compareCasVersions(stored, MINIMUM_COMPATIBLE_CAS_VERSION) < 0
      ? 'unsupported'
      : compareCasVersions(stored, CAS_VERSION) === 0
        ? 'current'
        : compareCasVersions(stored, CAS_VERSION) > 0
          ? 'newer-compatible'
          : 'older-compatible';

  return {
    stored_version: stored,
    current_version: CAS_VERSION,
    minimum_compatible_version: MINIMUM_COMPATIBLE_CAS_VERSION,
    status,
  };
}

export function requiresExplicitAnalysisLayers(storedVersion: string | undefined): boolean {
  const status = describeAnalysisVersion(storedVersion).status;
  return status === 'current' ||
    status === 'newer-compatible' ||
    status === 'newer-major';
}

export function hasFailedStructuralAnalysisLayer(entry: {
  cas_version?: string;
  layers_ready?: { layers?: Array<{ layer: string; status: string }> };
}): boolean {
  if (!entry.layers_ready?.layers?.length) return requiresExplicitAnalysisLayers(entry.cas_version);
  return entry.layers_ready.layers.some(layer => ['L0', 'L1', 'L2', 'L3'].includes(layer.layer) && layer.status === 'error');
}
