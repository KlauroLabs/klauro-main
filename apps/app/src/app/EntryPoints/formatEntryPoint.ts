import type { EntryPoint } from '@/shared/hooks/useEntryPoints';

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
