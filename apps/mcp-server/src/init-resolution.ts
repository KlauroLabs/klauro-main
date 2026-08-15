





export interface NamedChoice {
  id: string;
  name: string;
}










export function resolveNamedChoice<T extends NamedChoice>(
  choices: readonly T[],
  rawInput: string,
): { match: T } | { ambiguous: T[] } | { notFound: true } {
  const input = rawInput.trim();
  if (!input) return { notFound: true };


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


export function normalizeRepoIdentity(value: string | undefined, canonicalUrl?: string): string | undefined {
  const raw = String(canonicalUrl || value || '').trim();
  if (!raw) return undefined;
  return raw.replace(/\.git$/i, '').toLowerCase();
}

export interface RecognizedRemote {
  project: { id: string; name: string };
  workspace: { id: string; name: string };
}







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
