import { describe, it, expect, afterEach, vi } from 'vitest';
import { recordProjectOpened, getLastOpenedAt } from './useRecentProjectViews';

describe('useRecentProjectViews', () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('returns undefined for a project that has never been recorded', () => {
    expect(getLastOpenedAt('never-opened')).toBeUndefined();
  });

  it('records and reads back a project open, keyed per project id', () => {
    recordProjectOpened('p1');
    const recorded = getLastOpenedAt('p1');
    expect(recorded).toBeDefined();
    expect(getLastOpenedAt('p2')).toBeUndefined();
    // Round-trips as a valid ISO timestamp close to "now".
    expect(Date.now() - new Date(recorded!).getTime()).toBeLessThan(5000);
  });

  it('degrades to an honest no-op when localStorage is unavailable', () => {
    const getItemSpy = vi.spyOn(window.localStorage.__proto__, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    expect(() => recordProjectOpened('p1')).not.toThrow();
    expect(getLastOpenedAt('p1')).toBeUndefined();
    getItemSpy.mockRestore();
  });
});
