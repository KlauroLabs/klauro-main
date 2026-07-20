import { describe, it, expect } from 'vitest';
import { isKnownExitKind, EXIT_KIND_META, EXIT_FAMILIES, EXIT_FAMILY_ORDER } from './exitPointFamilies';

describe('exitPointFamilies', () => {
  it('recognizes every kind the analyzer can emit', () => {
    expect(isKnownExitKind('database')).toBe(true);
    expect(isKnownExitKind('webhook')).toBe(true);
    expect(isKnownExitKind('made-up-kind')).toBe(false);
  });

  it('assigns every kind to exactly one of the fixed families', () => {
    for (const meta of Object.values(EXIT_KIND_META)) {
      expect(EXIT_FAMILY_ORDER).toContain(meta.family);
    }
  });

  it('folds database and cache into the db family', () => {
    expect(EXIT_KIND_META.database.family).toBe('db');
    expect(EXIT_KIND_META.cache.family).toBe('db');
  });

  it('folds message and event into the messaging family', () => {
    expect(EXIT_KIND_META.message.family).toBe('messaging');
    expect(EXIT_KIND_META.event.family).toBe('messaging');
  });

  it('defines a label and tagline for every family', () => {
    for (const family of EXIT_FAMILY_ORDER) {
      expect(EXIT_FAMILIES[family].label).toBeTruthy();
      expect(EXIT_FAMILIES[family].tagline).toBeTruthy();
    }
  });
});
