import { describe, it, expect } from 'vitest';
import { describeFreshness, STALE_SOURCE_DAYS } from './freshness';

const NOW = new Date('2026-07-20T12:00:00Z').getTime();

describe('describeFreshness', () => {
  it('returns undefined when there is no analysis timestamp at all', () => {
    expect(describeFreshness(undefined, undefined, NOW)).toBeUndefined();
  });

  it('shows only the analysis age when no source timestamp is available', () => {
    const result = describeFreshness('2026-07-18T12:00:00Z', undefined, NOW);
    expect(result?.label).toBe('Updated 2d ago');
    expect(result?.stale).toBe(false);
  });

  it('shows both analysis age and source age when they diverge — the honest-but-deceptive case', () => {
    // Analysis ran 2 days ago (Jul 18) but the snapshot it analyzed was last
    // committed 13 days ago (Jul 7) — the real incident this fixes.
    const result = describeFreshness('2026-07-18T12:00:00Z', '2026-07-07T12:00:00Z', NOW);
    expect(result?.label).toBe('Updated 2d ago · source as of 13d ago');
    expect(result?.stale).toBe(true);
    expect(result?.staleNotice).toMatch(/Re-Analyze/);
  });

  it('omits the source clause when the two timestamps are identical', () => {
    const result = describeFreshness('2026-07-18T12:00:00Z', '2026-07-18T12:00:00Z', NOW);
    expect(result?.label).toBe('Updated 2d ago');
  });

  it('is not flagged stale at exactly the threshold boundary', () => {
    const boundary = new Date(NOW - STALE_SOURCE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const result = describeFreshness('2026-07-20T11:00:00Z', boundary, NOW);
    expect(result?.stale).toBe(false);
  });

  it('flags stale just past the threshold', () => {
    const pastBoundary = new Date(NOW - (STALE_SOURCE_DAYS * 24 * 60 * 60 * 1000 + 1000)).toISOString();
    const result = describeFreshness('2026-07-20T11:00:00Z', pastBoundary, NOW);
    expect(result?.stale).toBe(true);
  });
});
