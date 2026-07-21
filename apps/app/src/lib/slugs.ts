// Shared human-readable route slug codec — ONE codec for every route param
// that used to be a raw internal id (`wsp_PWXpXfnPgDnf6lBC`, `flow::chain:
// entry_event_...`, `das:container:services-api:api`, ...). Binding user
// directive: top-level AND nested routes must emit `kebab-name~suffix` URLs,
// never a bare internal id, while still ACCEPTING an old-style raw-id link
// (deep links / bookmarks must not break) — callers redirect those to the
// canonical slug once the candidate list has loaded (see resolveSlug +
// isLegacyIdParam below; every *Page component that owns a route param does
// this redirect itself, since only it knows when its candidate list is
// ready).
//
// Names are NOT unique (two workspaces/flows can share a display name), so
// the `~suffix` is load-bearing, not decorative — it's derived from the tail
// of the real id and is what actually disambiguates.

export interface Slugged {
  id: string;
  name: string;
}

const SUFFIX_LENGTH = 6;

/** kebab-case a display name for the readable half of the slug. Never empty
 *  — an all-symbol/empty name falls back to "item" so encodeSlug always
 *  produces a valid path segment. */
export function kebabCase(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'item'
  );
}

/** The disambiguating half: the last SUFFIX_LENGTH alphanumeric characters of
 *  the real id, lowercased. Stable for a given id regardless of punctuation
 *  scheme (`wsp_PWXpXfnPgDnf6lBC`, `flow::chain:entry_event_x`, `das:...` all
 *  reduce to a plain alnum tail). */
export function idSuffix(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9]/g, '');
  return cleaned.slice(-SUFFIX_LENGTH).toLowerCase() || cleaned.toLowerCase();
}

/** Encode one item's canonical slug: `kebab-name~suffix`. */
export function encodeSlug(item: Slugged): string {
  return `${kebabCase(item.name)}~${idSuffix(item.id)}`;
}

/**
 * Resolve a route param (canonical slug, legacy raw id, or a stale/partial
 * slug) to the matching candidate. Priority:
 *   1. Exact id match — back-compat for a bookmarked/shared raw-id link.
 *   2. Exact canonical-slug match — the normal case once links emit slugs.
 *   3. Suffix-only match — a candidate whose id ends in the param's `~`
 *      suffix, so a renamed item (name changed since the link was copied)
 *      still resolves via the id-derived, stable half of the slug.
 * Returns undefined when nothing matches (also the correct "still loading"
 * result before the candidate list has arrived).
 */
export function resolveSlug<T extends Slugged>(param: string | undefined, candidates: T[]): T | undefined {
  if (!param) return undefined;
  const byId = candidates.find(c => c.id === param);
  if (byId) return byId;
  const bySlug = candidates.find(c => encodeSlug(c) === param);
  if (bySlug) return bySlug;
  const tildeIndex = param.lastIndexOf('~');
  if (tildeIndex === -1) return undefined;
  const suffix = param.slice(tildeIndex + 1).toLowerCase();
  if (!suffix) return undefined;
  return candidates.find(c => idSuffix(c.id) === suffix);
}

/**
 * True (and returns the match) when `param` is a raw internal id that a
 * candidate list resolves, but is NOT already the canonical slug form for
 * that candidate — the signal a route should `navigate(canonical, {replace:
 * true})` so old-style `/flows/flow::chain:entry_event_...` links converge
 * onto the slug URL instead of staying live forever.
 */
export function legacyIdMatch<T extends Slugged>(param: string | undefined, candidates: T[]): T | undefined {
  if (!param) return undefined;
  const match = candidates.find(c => c.id === param);
  if (match && encodeSlug(match) !== param) return match;
  return undefined;
}
