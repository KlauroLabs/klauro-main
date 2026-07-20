import type { EntryPoint } from '../../hooks/useEntryPoints';

/**
 * The address ("trigger") has no single shape — a verb + web path, a tool
 * name, a full command line, a schedule in words, or an event name. Per the
 * brief's "Its address" section, whatever holds it can't assume a fixed
 * shape, so this formats whichever fields are present rather than reading
 * one canonical field.
 */
export function formatTrigger(ep: EntryPoint): string | null {
  const t = ep.trigger;
  if (!t) return null;
  if (t.method && t.path) return `${t.method.toUpperCase()} ${t.path}`;
  if (t.path) return t.path;
  if (t.pattern) return t.pattern;
  if (t.schedule) return t.schedule;
  if (t.event) return `on "${t.event}"`;
  return null;
}

/** Roughly a third of entry points are labeled with raw code tokens
 *  (main, handleRequest, do_thing) rather than clean phrases — the name has
 *  to hold a tidy sentence AND a terse code token without looking broken. */
export function looksLikeRawToken(name: string): boolean {
  if (!name) return true;
  const hasSpace = /\s/.test(name);
  const isCodeCase = /^[a-z0-9]+(_[a-z0-9]+)+$/i.test(name) || /^[a-z][a-zA-Z0-9]*$/.test(name) && /[a-z][A-Z]/.test(name);
  return !hasSpace && (isCodeCase || /^[a-z_][a-zA-Z0-9_]*$/.test(name));
}

export function securityLabel(ep: EntryPoint): { label: string; open: boolean } {
  if (ep.security?.authenticated) return { label: 'Protected', open: false };
  if (ep.security?.authenticated === false) return { label: 'Open to anyone', open: true };
  return { label: 'Unknown', open: true };
}
