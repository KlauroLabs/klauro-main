import { describe, it, expect } from 'vitest';
import { KIND_META, FAMILIES, FAMILY_ORDER, isKnownKind, kindsInFamily } from './entryPointKinds';

describe('entryPointKinds', () => {
  it('excludes test from the known-kind vocabulary', () => {
    expect(isKnownKind('test')).toBe(false);
    expect(isKnownKind('http')).toBe(true);
  });

  it('every kind belongs to exactly one of the four families', () => {
    const allKinds = Object.keys(KIND_META);
    const kindsAcrossFamilies = FAMILY_ORDER.flatMap(f => kindsInFamily(f));
    expect(new Set(kindsAcrossFamilies).size).toBe(allKinds.length);
    expect(kindsAcrossFamilies.sort()).toEqual(allKinds.sort());
  });

  it('every family has display metadata', () => {
    for (const family of FAMILY_ORDER) {
      expect(FAMILIES[family].label).toBeTruthy();
      expect(FAMILIES[family].modality).toBeTruthy();
    }
  });

  it('rejects an unrecognized kind string', () => {
    expect(isKnownKind('graphql-subscription')).toBe(false);
  });
});
