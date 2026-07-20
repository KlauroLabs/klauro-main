/**
 * The fixed exit-point kind vocabulary, grouped into families — the mirror
 * image of src/components/entryPointKinds.ts (entry points MIRROR: "ways-in
 * and ways-out together are the complete surface of contact between this
 * system and everything around it").
 *
 * Source of truth: packages/analyzer-core/src/types/cas.types.ts
 * `EXIT_POINT_TYPES` / `CASExitPointType`. This file adds ONLY presentation
 * metadata (family, label, one-line meaning) on top of that union — it does
 * not invent kinds the analyzer doesn't emit.
 *
 * LANE-COMMON.md's Dependencies-rung brief for this lane: "Exit points
 * grouped by family (db/sdk/api/messaging)". The vocabulary is FIXED and
 * COMPLETE, same discipline as entry points: a family with zero members for
 * this codebase simply doesn't render a section — it is never a surprise,
 * and it is never omitted from the type definition either.
 */

export type ExitPointFamily = 'db' | 'sdk' | 'api' | 'messaging' | 'device';

/** Mirrors CASExitPointType (EXIT_POINT_TYPES in cas.types.ts) exactly. */
export type ExitKind =
  | 'database'
  | 'cache'
  | 'sdk'
  | 'api'
  | 'webhook'
  | 'message'
  | 'event'
  | 'file'
  | 'navigation'
  | 'client_storage'
  | 'analytics';

export interface ExitFamilyMeta {
  id: ExitPointFamily;
  label: string;
  tagline: string;
}

export const EXIT_FAMILIES: Record<ExitPointFamily, ExitFamilyMeta> = {
  db: {
    id: 'db',
    label: 'Data stores',
    tagline: 'Where the system reads and writes its own state — databases and caches.',
  },
  sdk: {
    id: 'sdk',
    label: 'Libraries & SDKs',
    tagline: 'Third-party library calls that reach outside the process at runtime.',
  },
  api: {
    id: 'api',
    label: 'Outbound APIs',
    tagline: 'HTTP calls this system makes to another service, and webhooks it fires.',
  },
  messaging: {
    id: 'messaging',
    label: 'Messaging',
    tagline: 'Queues, topics, and events the system publishes or reacts to.',
  },
  device: {
    id: 'device',
    label: 'Device & client',
    tagline: 'Local files, browser storage, navigation, and analytics — client-side exits.',
  },
};

export interface ExitKindMeta {
  kind: ExitKind;
  family: ExitPointFamily;
  label: string;
  meaning: string;
}

export const EXIT_KIND_META: Record<ExitKind, ExitKindMeta> = {
  database: { kind: 'database', family: 'db', label: 'Database', meaning: 'A query or write against a relational or document store.' },
  cache: { kind: 'cache', family: 'db', label: 'Cache', meaning: 'A read, write, or invalidation against an in-memory store.' },
  sdk: { kind: 'sdk', family: 'sdk', label: 'Library / SDK', meaning: 'A call into a third-party library that itself reaches outside the process.' },
  api: { kind: 'api', family: 'api', label: 'Outbound API call', meaning: 'An HTTP/RPC request this system makes to another service.' },
  webhook: { kind: 'webhook', family: 'api', label: 'Webhook', meaning: 'An HTTP callback this system fires to notify another service.' },
  message: { kind: 'message', family: 'messaging', label: 'Message / queue', meaning: 'An item pushed onto a queue for another consumer.' },
  event: { kind: 'event', family: 'messaging', label: 'Event / topic', meaning: 'A published event or a subscription to one.' },
  file: { kind: 'file', family: 'device', label: 'File', meaning: 'A read or write against the local filesystem.' },
  navigation: { kind: 'navigation', family: 'device', label: 'Navigation', meaning: 'A client-side redirect or route change.' },
  client_storage: { kind: 'client_storage', family: 'device', label: 'Client storage', meaning: 'A browser storage read/write (localStorage, cookies, IndexedDB).' },
  analytics: { kind: 'analytics', family: 'device', label: 'Analytics', meaning: 'A tracking or telemetry call to an analytics provider.' },
};

export const EXIT_FAMILY_ORDER: ExitPointFamily[] = ['db', 'sdk', 'api', 'messaging', 'device'];

export function isKnownExitKind(value: string): value is ExitKind {
  return Object.prototype.hasOwnProperty.call(EXIT_KIND_META, value);
}
