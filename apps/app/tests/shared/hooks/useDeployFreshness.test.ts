import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useDeployFreshness } from '@/shared/hooks/useDeployFreshness';

describe('useDeployFreshness', () => {
  beforeEach(() => {
    vi.stubGlobal('__KLAURO_BUILD_ID__', 'abc123');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('stays false when the served build id matches the running one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve('<meta name="klauro-build-id" content="abc123" />') }),
    );
    const { result } = renderHook(() => useDeployFreshness());
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(result.current.updateAvailable).toBe(false);
  });

  it('flags an update when the served build id differs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve('<meta name="klauro-build-id" content="def456" />') }),
    );
    const { result } = renderHook(() => useDeployFreshness());
    await waitFor(() => expect(result.current.updateAvailable).toBe(true));
  });

  it('stays quiet on a fetch failure rather than flagging an update', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const { result } = renderHook(() => useDeployFreshness());
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(result.current.updateAvailable).toBe(false);
  });
});
