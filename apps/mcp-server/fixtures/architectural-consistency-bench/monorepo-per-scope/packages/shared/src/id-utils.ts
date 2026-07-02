// Pure, stateless helpers: no writes, no exit points, no outgoing calls.
// Widely reused (high fan-in) across both apps in this fixture — this is
// healthy reuse of a stable utility, NOT a coupling risk, and must not be
// flagged by the coupling-hotspot scan regardless of how many callers it has.
export function generateId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2)}`;
}

export function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9-]/g, '');
}
