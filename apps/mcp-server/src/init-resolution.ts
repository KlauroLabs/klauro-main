/**
 * Pure resolution helpers for `klauro init` onboarding. Kept free of TTY and
 * network concerns so the recognition / name-based-selection logic is unit
 * testable. The CLI (`cli.ts`) wires these to prompts and the hosted API.
 */

export interface NamedChoice {
  id: string;
  name: string;
}

/**
 * Resolve a user's typed answer to one of the named choices. Accepts (in order):
 *   1. a 1-based list number ("2"),
 *   2. an exact case-insensitive name,
 *   3. a unique case-insensitive prefix or substring match.
 * Returns the match, or a `{ ambiguous }` / `{ notFound }` result the caller can
 * turn into a re-prompt. Never asks for a bare number — numbers are merely one
 * accepted shorthand, names are the primary path.
 */
export function resolveNamedChoice<T extends NamedChoice>(
  choices: readonly T[],
  rawInput: string,
): { match: T } | { ambiguous: T[] } | { notFound: true } {
  const input = rawInput.trim();
  if (!input) return { notFound: true };

  // 1-based number shorthand (only when it lands in range).
  if (/^\d+$/.test(input)) {
    const index = Number(input) - 1;
    if (index >= 0 && index < choices.length) return { match: choices[index] };
  }

  const lower = input.toLowerCase();

  const exact = choices.filter(choice => choice.name.trim().toLowerCase() === lower);
  if (exact.length === 1) return { match: exact[0] };
  if (exact.length > 1) return { ambiguous: exact };

  const prefix = choices.filter(choice => choice.name.trim().toLowerCase().startsWith(lower));
  if (prefix.length === 1) return { match: prefix[0] };
  if (prefix.length > 1) return { ambiguous: prefix };

  const substring = choices.filter(choice => choice.name.trim().toLowerCase().includes(lower));
  if (substring.length === 1) return { match: substring[0] };
  if (substring.length > 1) return { ambiguous: substring };

  return { notFound: true };
}

/** Normalize a Git remote for identity matching: scheme, `.git`, and case ignored. */
export function normalizeRepoIdentity(value: string | undefined, canonicalUrl?: string): string | undefined {
  const raw = String(canonicalUrl || value || '').trim();
  if (!raw) return undefined;
  return raw.replace(/\.git$/i, '').toLowerCase();
}

export interface RecognizedRemote {
  project: { id: string; name: string };
  workspace: { id: string; name: string };
}

/**
 * Decide the init flow from the recognition-lookup result. When the current
 * remote is already connected, the flow is "recommend reconnect" (default yes);
 * otherwise it is a fresh placement flow. This is the single branch point the
 * CLI keys off of, isolated here so both branches are covered by tests.
 */
export function decideInitFlow(recognized: RecognizedRemote | null): {
  mode: 'reconnect' | 'fresh';
  recommendation?: string;
} {
  if (recognized) {
    return {
      mode: 'reconnect',
      recommendation: `We recognized this repo is already connected to project "${recognized.project.name}" in workspace "${recognized.workspace.name}"`,
    };
  }
  return { mode: 'fresh' };
}
