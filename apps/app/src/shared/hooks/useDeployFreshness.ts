import { useCallback, useEffect, useState } from 'react';

const CHECK_INTERVAL_MS = 5 * 60 * 1000;

function extractBuildId(html: string): string | null {
  const match = /<meta\s+name="klauro-build-id"\s+content="([^"]+)"/i.exec(html);
  return match ? match[1] : null;
}

export function useDeployFreshness() {
  const [updateAvailable, setUpdateAvailable] = useState(false);

  const check = useCallback(async () => {
    if (updateAvailable) return;
    try {
      const response = await fetch(`/index.html?_=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) return;
      const html = await response.text();
      const servedBuildId = extractBuildId(html);
      if (servedBuildId && servedBuildId !== __KLAURO_BUILD_ID__) {
        setUpdateAvailable(true);
      }
    } catch {
      // no-op
    }
  }, [updateAvailable]);

  useEffect(() => {
    check();
    const onFocus = () => check();
    window.addEventListener('focus', onFocus);
    const interval = window.setInterval(check, CHECK_INTERVAL_MS);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.clearInterval(interval);
    };
  }, [check]);

  return { updateAvailable, refresh: () => window.location.reload() };
}
