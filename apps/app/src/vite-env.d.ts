/// <reference types="vite/client" />

/** Deploy-freshness build id, baked in by vite.config.ts's `define` — see
 *  src/hooks/useDeployFreshness.ts. */
declare const __KLAURO_BUILD_ID__: string;
