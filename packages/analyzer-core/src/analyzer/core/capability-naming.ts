/**
 * Shared capability naming/description vocabulary — ONE implementation used
 * by BOTH the producer (CapabilityDetector, which builds
 * flow_graph.capabilities from entry-point groupings) and the final-assembly
 * backstop (AnalyzerOrchestrator.finalizeFlowGraphCapabilities). The producer
 * derives evidence-grounded names/descriptions up front; the backstop repairs
 * anything that still slips through (e.g. capabilities merged in from other
 * sources). Keeping the logic here prevents the two from drifting into two
 * copies with different notions of "bare noun" or "placeholder".
 *
 * Everything below is generic English / structural — never project-specific
 * or brand vocabulary.
 */

/**
 * Purpose-verb vocabulary used only to test whether a capability label OPENS
 * with an action ("Manage sessions") vs. is a bare module/type noun echoed
 * as-is ("Session"). Generic English verbs only.
 */
export const CAPABILITY_PURPOSE_VERBS = new Set<string>([
  'get', 'set', 'fetch', 'list', 'find', 'load', 'show', 'view', 'read',
  'create', 'add', 'new', 'update', 'edit', 'delete', 'remove', 'save',
  'submit', 'send', 'sync', 'run', 'execute', 'process', 'handle', 'make',
  'build', 'init', 'initialize', 'validate', 'check', 'resolve', 'generate',
  'start', 'stop', 'open', 'close', 'enable', 'disable', 'apply', 'compute',
  'manage', 'provide', 'support', 'expose', 'monitor', 'track',
  'secure', 'detect', 'analyze', 'analyse', 'orchestrate', 'coordinate',
  'schedule', 'transform', 'render', 'display', 'authenticate', 'authorize',
  'notify', 'report', 'export', 'import', 'connect', 'synchronize',
  'discover', 'configure', 'deploy', 'migrate', 'ingest', 'stream', 'route',
  'dispatch', 'reconcile', 'audit', 'log', 'cache', 'queue', 'persist',
  'store', 'serve', 'correlate', 'collect', 'record',
  'search', 'index',
]);

// ---------------------------------------------------------------------------
// PATH HYGIENE — a capability name may never carry filesystem vocabulary.
//
// Two measured live defects (audit on the deployed build, 2026-07-28):
//  1. A source FILE PATH was used as a naming subject and its extension became
//     an English word: `nat.rs` -> "Manage Nat R", `x.sh` -> "… Sh",
//     `flake.nix` -> "… Nix". 39 shipped capability names carried an extension
//     fragment as a word.
//  2. The SERVER'S OWN STORAGE ROOT reached a name verbatim: an absolute
//     analyzed-source path under the hosted storage root humanized into
//     "Workspaces Prj … Web Tsx" — internal infrastructure geography shipped
//     to a customer as a product capability.
//
// Both are the same class: path text entering the naming ladder. The vocabulary
// below is generic filesystem/language vocabulary — never project, brand or
// corpus specific — and is applied at BOTH ends: at every point a path is
// turned into naming tokens, and as a final-assembly guard that refuses to ship
// a name still carrying it.
// ---------------------------------------------------------------------------

/**
 * Source/config FILE EXTENSIONS. Anything after the last `.` of a path segment
 * that matches one of these is a file-type marker, never a domain noun, so it
 * is stripped before the segment can become naming tokens.
 */
export const SOURCE_FILE_EXTENSION_TOKENS = new Set<string>([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'd',
  'py', 'pyi', 'rb', 'rake', 'php', 'go', 'rs', 'java', 'kt', 'kts', 'scala',
  'swift', 'm', 'mm', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'cs', 'fs',
  'ex', 'exs', 'erl', 'hrl', 'clj', 'cljs', 'cljc', 'edn', 'lisp', 'el',
  'dart', 'vue', 'svelte', 'astro', 'sol', 'lua', 'pl', 'pm', 'r', 'jl',
  'groovy', 'gradle', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd',
  'sql', 'graphql', 'gql', 'proto', 'thrift', 'nix', 'tf', 'tfvars', 'hcl',
  'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env',
  'xml', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'styl',
  'md', 'mdx', 'rst', 'txt', 'lock', 'snap', 'map', 'wasm', 'vhd', 'vhdl', 'sv',
  'zig', 'nim', 'cr', 'hs', 'ml', 'mli', 'vb', 'pas', 'asm', 's',
]);

/**
 * FILESYSTEM / HOSTING geography. Directory vocabulary that describes WHERE a
 * file sits on a machine (including the hosted analyzer's own storage layout:
 * `<data-root>/workspaces/<project-id>/…`) rather than WHAT the code does.
 * A capability name containing any of these was derived from a path.
 *
 * Generic filesystem + hosting vocabulary only — no product or client names.
 *
 * Deliberately EXCLUDES words that are ordinary product English even though
 * they also name directories — data, user(s), project(s), analysis, build,
 * cache, storage, upload, snapshot, repo, root, home, index, out, target. A
 * live scan of 966 stored analyses flagged real capabilities ("Secure user
 * data", "Surfaces user data") on `user`+`data` adjacency; product vocabulary
 * must win over filesystem vocabulary whenever a word is genuinely both.
 */
export const STORAGE_PATH_NOISE_TOKENS = new Set<string>([
  'var', 'tmp', 'temp', 'opt', 'usr', 'srv', 'mnt', 'etc', 'proc',
  'private', 'volumes', 'workspace', 'workspaces', 'workdir', 'checkout',
  'prj', 'proj', 'bin', 'obj', 'dist', 'node_modules', 'vendor',
]);

/**
 * Extensions that are ALSO plausible standalone product vocabulary — a
 * capability legitimately named "Render HTML", "Generate SQL", "Manage Go
 * Workers" or "Export JSON" must never be flagged. These are still stripped
 * when they trail a filename (`schema.sql` -> `schema`), but they never make a
 * finished name suspicious on their own.
 */
const AMBIGUOUS_EXTENSION_WORDS = new Set<string>([
  'go', 'java', 'swift', 'sql', 'html', 'htm', 'css', 'xml', 'json', 'md',
  'env', 'map', 'lock', 'proto', 'graphql', 'dart', 'vue', 'svelte', 'astro',
  'sol', 'lua', 'txt', 'conf', 'cache', 'index', 'wasm',
]);

/**
 * File-type markers that are meaningless as the trailing word of a product
 * capability name — seeing one there proves the name was derived from a
 * filename rather than from behavior.
 */
export const FILE_EXTENSION_TAIL_TOKENS = new Set<string>(
  [...SOURCE_FILE_EXTENSION_TOKENS].filter(token => !AMBIGUOUS_EXTENSION_WORDS.has(token))
);

/**
 * True when `token` (already lowercased, punctuation-free) is filesystem
 * geography rather than a domain noun.
 */
export function isStoragePathToken(token: string): boolean {
  const normalized = String(token || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return Boolean(normalized) && STORAGE_PATH_NOISE_TOKENS.has(normalized);
}

/**
 * True when a token is an OPAQUE IDENTIFIER — a generated project/analysis id,
 * hash or uuid fragment — that carries no meaning to a reader. Shape-based:
 * long alphanumeric runs that mix letters and digits, or long hex runs.
 */
export function isOpaqueIdentifierToken(token: string): boolean {
  const normalized = String(token || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (normalized.length < 6) return false;
  if (/^[0-9a-f]{8,}$/.test(normalized)) return true;
  return /^(?=.*[a-z])(?=.*[0-9])[a-z0-9]{8,}$/.test(normalized);
}

/**
 * Strips a trailing FILE EXTENSION from one path segment: `nat.rs` -> `nat`,
 * `analysis.store.ts` -> `analysis.store`. Only a recognized source/config
 * extension is removed, so a domain noun that happens to follow a dot
 * (`v1.orders`) survives untouched.
 */
export function stripSourceFileExtension(segment: string): string {
  const value = String(segment || '');
  const match = /^(.*)\.([A-Za-z0-9]+)$/.exec(value);
  if (!match) return value;
  return SOURCE_FILE_EXTENSION_TOKENS.has(match[2].toLowerCase()) ? match[1] : value;
}

/**
 * Reduces any path-shaped text to the ONE naming-relevant segment: the
 * basename with its file extension removed. `/data/workspaces/prj_x/bin/
 * sample-service-host/web/App.tsx` -> `App`; `src/nat.rs` -> `nat`. Text
 * with no path separator is returned unchanged (minus a file extension).
 *
 * This is the STRUCTURAL half of the storage-path fix: a naming subject can no
 * longer contain the analysis root because it can no longer contain a
 * directory at all. Nothing about the server's storage layout survives it, so
 * it holds for any root the hosted service ever uses.
 */
export function namingSubjectFromPath(value: string): string {
  const normalized = String(value || '').replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  const basename = segments.length > 0 ? segments[segments.length - 1] : normalized;
  return stripSourceFileExtension(basename);
}

/**
 * FINAL-ASSEMBLY GUARD: true when a shipped capability name still reads as
 * filesystem text. Three high-precision signatures, each measured live:
 *  - the TRAILING word is an unambiguous file-type marker ("Manage Nat R",
 *    "… Sh", "… Web Tsx");
 *  - two ADJACENT words are storage geography ("Workspaces Prj …") — one alone
 *    is not enough, because "Manage Project Members" and "Manage Data Exports"
 *    are real capabilities;
 *  - any word is an opaque generated id (project id / hash fragment).
 *
 * Word-exact throughout: a domain word that merely CONTAINS one of these
 * substrings ("Datasets", "Bindings", "Reprocessing") is unaffected.
 */
export function isPathDerivedCapabilityName(name: string): boolean {
  const words = String(name || '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(word => word.toLowerCase());
  if (words.length === 0) return false;
  const tail = words[words.length - 1];
  if (words.length > 1 && FILE_EXTENSION_TAIL_TOKENS.has(tail)) return true;
  if (words.some(word => isOpaqueIdentifierToken(word))) return true;
  for (let index = 1; index < words.length; index++) {
    if (isStoragePathToken(words[index - 1]) && isStoragePathToken(words[index])) return true;
  }
  return false;
}

/**
 * Humanizes a raw code-shaped label (snake_case, kebab-case, or camelCase)
 * into Title-Cased words: "get_hot_spots" / "getHotSpots" -> "Get Hot Spots".
 */
export function humanizeCapabilityLabel(label: string): string {
  return String(label || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, char => char.toUpperCase());
}

/**
 * True when `name` is a BARE NOUN label — a single module/type token
 * ("Gateway", "Wizard", "Exec") or a two-word noun phrase with no leading
 * purpose verb ("Exec Approval") — rather than a purpose-headed capability
 * name ("Manage Gateway Connections", "Detect patterns"). The capability
 * doctrine requires every name to read as a PURPOSE, never a type/module
 * identifier surfaced verbatim.
 *
 * Deliberately narrow (only 1 token, or 2 tokens both non-verb-headed) so a
 * legitimate short label like "Detect patterns" (verb + object) — or any
 * 3+ word phrase — is never rejected. A single word IS always flagged
 * regardless of whether it happens to be verb-shaped ("Connect", "Poll"):
 * a lone word with no object is not a purpose statement.
 */
export function isBareNounCapabilityLabel(name: string): boolean {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 2) return false;
  if (words.length === 1) return true;
  const first = words[0].toLowerCase().replace(/[^a-z]/g, '');
  if (CAPABILITY_PURPOSE_VERBS.has(first)) return false;
  // Strip a common inflection (managing/manages/managed) so the base verb
  // still registers without a project-specific inflection table.
  const stem = first.replace(/(ing|ed|es|s)$/, '');
  if (CAPABILITY_PURPOSE_VERBS.has(stem)) return false;
  return true;
}

/**
 * True when `description` is the structural grouping template
 * ("<Label>: <pattern> operation via <type>" / "<Label>: N operations
 * (crud, query)") rather than authored prose. Template-shaped only — a real
 * sentence that happens to contain "operation" never matches.
 */
export function isStructuralPlaceholderCapabilityDescription(description: string): boolean {
  const trimmed = String(description || '').trim();
  if (!trimmed) return false;
  return /^[^:]{1,80}:\s+(?:[a-z]+\s+operation\s+via\s+\S+\s*$|\d+\s+operations?\s*\()/i.test(trimmed);
}

/** The minimal operation shape both producer and backstop can supply. */
export interface CapabilityOperationEvidence {
  name?: string;
  action?: string;
  entry_point_type?: string;
  trigger?: { type?: string; method?: string; path?: string };
}

/**
 * Derives an evidence-grounded capability NAME from the capability's real
 * operations (the adopt-humanized-operation-label logic the ba7f915a finalize
 * sweep introduced, now shared):
 *  1. If any operation label humanizes into a verb-headed multi-word phrase
 *     ("get_hot_spots" -> "Get Hot Spots"), adopt it.
 *  2. Otherwise "Manage <subject>" when operations/entry points ground the
 *     subject as a real capability.
 *  3. Otherwise undefined — the caller keeps (or drops) its own label.
 */
export function deriveCapabilityNameFromOperations(
  subject: string,
  operations: CapabilityOperationEvidence[],
  hasAnchorEvidence: boolean
): string | undefined {
  const opLabels = (operations || [])
    .map(op => String(op.name || op.action || '').trim())
    .filter(Boolean)
    .map(label => humanizeCapabilityLabel(label));
  const verbHeaded = opLabels.find(label => {
    const words = label.split(/\s+/);
    return words.length >= 2 && !isBareNounCapabilityLabel(label);
  });
  if (verbHeaded) return verbHeaded;
  const trimmed = String(subject || '').trim();
  if (!trimmed || !hasAnchorEvidence) return undefined;
  return `Manage ${trimmed}`;
}

/**
 * Deterministic evidence-grounded capability DESCRIPTION: names the
 * capability's REAL operations (entry-point names, humanized) and entry
 * kinds. Facts only — no interpretive claim, never a fill-in template.
 * Returns undefined when there are no operations to ground a sentence in.
 */
export function buildCapabilityDescriptionFromOperations(
  operations: CapabilityOperationEvidence[]
): string | undefined {
  const labels = Array.from(new Set(
    (operations || [])
      .map(op => String(op.name || op.action || '').trim())
      .filter(Boolean)
      .map(label => humanizeCapabilityLabel(label))
  ));
  if (labels.length === 0) return undefined;
  const kinds = Array.from(new Set(
    (operations || []).map(op => String(op.entry_point_type || op.trigger?.type || '').trim()).filter(Boolean)
  ));
  const kindLabel = kinds.length === 1 ? ` ${kinds[0]}` : '';
  const sample = labels.slice(0, 3).join(', ');
  const suffix = labels.length > 3 ? ` and ${labels.length - 3} more` : '';
  return `Covers ${labels.length}${kindLabel} operation${labels.length === 1 ? '' : 's'}: ${sample}${suffix}.`;
}
