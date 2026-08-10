import { describe, it, expect } from 'vitest';
import { buildSubCasNodeIndex, tierQualifiedShipUnits } from '@/app/Deployable/subCasNodeIndex';
import type { DeployableEvidence } from '@/app/Deployable/dasTypes';

const container: DeployableEvidence = {
  root_path: 'services/api',
  name: 'api',
  tier: 1,
  kind: 'container',
  evidence: ['services/api/Dockerfile'],
  ships_paths: ['bin/api'],
};

const worker: DeployableEvidence = {
  root_path: 'services/worker',
  name: 'worker',
  tier: 1,
  kind: 'container',
  evidence: ['services/worker/Dockerfile'],
};

const bundledBin: DeployableEvidence = {
  root_path: 'services/api/bin',
  name: 'bin/api',
  tier: 2,
  kind: 'bin',
  evidence: ['services/api/bin/main.go'],
  bundled_into: 'api',
};

describe('tierQualifiedShipUnits', () => {
  it('counts standalone tier-1 rows and folds bundled members out', () => {
    const result = tierQualifiedShipUnits([container, worker, bundledBin]);
    expect(result).toEqual([container, worker]);
  });

  it('exempts a sole standalone tier-2/3 runnable when no tier-1 exists', () => {
    const solo: DeployableEvidence = { root_path: 'cmd/tool', name: 'tool', tier: 2, kind: 'bin', evidence: ['cmd/tool/main.go'] };
    expect(tierQualifiedShipUnits([solo])).toEqual([solo]);
  });

  it('excludes server-entry kind even when sole-runnable', () => {
    const route: DeployableEvidence = { root_path: 'src/routes', name: 'route', tier: 2, kind: 'server-entry', evidence: [] };
    expect(tierQualifiedShipUnits([route])).toEqual([]);
  });
});

describe('buildSubCasNodeIndex', () => {
  it('does not promote below 2 tier-qualified units', () => {
    expect(buildSubCasNodeIndex([container])).toEqual({ promoted: false, units: [] });
    expect(buildSubCasNodeIndex(undefined)).toEqual({ promoted: false, units: [] });
  });

  it('promotes at 2+ units and folds bundled members under their owner', () => {
    const result = buildSubCasNodeIndex([container, worker, bundledBin]);
    expect(result.promoted).toBe(true);
    expect(result.units).toHaveLength(2);
    const apiUnit = result.units.find(u => u.name === 'api')!;
    expect(apiUnit.member_root_paths).toEqual(['services/api/bin']);
    expect(apiUnit.member_deployable_ids).toHaveLength(2);
    expect(apiUnit.id).toMatch(/^das:container:services-api:api/);
  });

  it('derives ids deterministically for the same input', () => {
    const a = buildSubCasNodeIndex([container, worker]);
    const b = buildSubCasNodeIndex([container, worker]);
    expect(a.units.map(u => u.id)).toEqual(b.units.map(u => u.id));
  });
});
