// Names are NOT unique (two workspaces/flows can share a display name), so
// the `~suffix` is load-bearing, not decorative — it's derived from the tail
// of the real id and is what actually disambiguates.

export interface Slugged {
  id: string;
  name: string;
}

const SUFFIX_LENGTH = 6;

export function kebabCase(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'item'
  );
}

export function idSuffix(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9]/g, '');
  return cleaned.slice(-SUFFIX_LENGTH).toLowerCase() || cleaned.toLowerCase();
}

export function encodeSlug(item: Slugged): string {
  return `${kebabCase(item.name)}~${idSuffix(item.id)}`;
}

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

export function legacyIdMatch<T extends Slugged>(param: string | undefined, candidates: T[]): T | undefined {
  if (!param) return undefined;
  const match = candidates.find(c => c.id === param);
  if (match && encodeSlug(match) !== param) return match;
  return undefined;
}
