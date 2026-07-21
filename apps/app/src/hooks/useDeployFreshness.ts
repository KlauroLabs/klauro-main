// Deploy freshness: detect that a NEWER build has been deployed to
// app.klauro.com while this tab is still running the old one, without any
// server-pushed signal — infrastructure/vps/deploy.sh just overwrites the
// static bundle in place, so a long-lived tab has no other way to find out.
// vite.config.ts stamps the same build id in two places: `__KLAURO_BUILD_ID__`
// (baked into this tab's running JS) and a `<meta name="klauro-build-id">`
// tag in index.html (baked into the SERVED html at build time). Re-fetching
// index.html (cache-busted, cheap — a few KB of markup, not a JS bundle) and
// comparing its meta tag against the constant this tab is already running
// tells us whether a newer deploy has landed, checked on window focus (the
// common "I tabbed back in" moment) plus a bounded interval so a tab left
// open in the background eventually notices too.
import { useCallback, useEffect, useState } from 'react';

const CHECK_INTERVAL_MS = 5 * 60 * 1000;

function extractBuildId(html: string): string | null {
  const match = /<meta\s+name="klauro-build-id"\s+content="([^"]+)"/i.exec(html);
  return match ? match[1] : null;
}

export function useDeployFreshness() {
  const [updateAvailable, setUpdateAvailable] = useState(false);

  const check = useCallback(async () => {
    if (updateAvailable) return; // already known stale — no need to keep polling
    try {
      const response = await fetch(`/index.html?_=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) return;
      const html = await response.text();
      const servedBuildId = extractBuildId(html);
      if (servedBuildId && servedBuildId !== __KLAURO_BUILD_ID__) {
        setUpdateAvailable(true);
      }
    } catch {
      // Offline or a transient network blip — not a signal either way, stay quiet.
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
