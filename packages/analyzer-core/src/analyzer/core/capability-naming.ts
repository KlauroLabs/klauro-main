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
