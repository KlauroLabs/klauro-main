import { appendAll, replaceArrayContents } from '../../analyzer/core/bulk-array-ops';

/**
 * `target.push(...source)` passes one argument per element and throws a RangeError
 * past the engine's argument limit. The bulk array helpers must work at a size
 * above that limit.
 */

const EDGE_COUNT = 250_000;

describe('bulk array operations', () => {
  it('appends past the argument limit', () => {
    const target: number[] = [];
    const source = Array.from({ length: EDGE_COUNT }, (_, i) => i);
    expect(() => appendAll(target, source)).not.toThrow();
    expect(target.length).toBe(EDGE_COUNT);
    expect(target[EDGE_COUNT - 1]).toBe(EDGE_COUNT - 1);
  });

  it('replaces past the argument limit, preserving order', () => {
    const target = [1, 2, 3];
    const source = Array.from({ length: EDGE_COUNT }, (_, i) => i);
    expect(() => replaceArrayContents(target, source)).not.toThrow();
    expect(target.length).toBe(EDGE_COUNT);
    expect(target[0]).toBe(0);
    expect(target[EDGE_COUNT - 1]).toBe(EDGE_COUNT - 1);
  });

  it('is a no-op when replacing an array with itself rather than emptying it', () => {
    const target = [1, 2, 3];
    replaceArrayContents(target, target);
    expect(target).toEqual([1, 2, 3]);
  });

  it('demonstrates the construct it replaces actually fails at this size', () => {
    const source = Array.from({ length: EDGE_COUNT }, (_, i) => i);
    // This is the shape that shipped. Kept as an executable statement of WHY the
    // helpers exist, so nobody "simplifies" them back into a spread.
    expect(() => {
      const target: number[] = [];
      target.push(...source);
    }).toThrow(RangeError);
  });
});
