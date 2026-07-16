import type { CASEntryPoint, CASNode, DeployableEvidence } from '../../types/cas.types';

/**
 * Entry Point <-> Deployable attribution + description backfill.
 *
 * Two pure, deterministic passes over `CASEntryPoint[]`:
 *
 *  1. `attachDeployable` — attribute each entry point to the deployable
 *     artifact that owns it, by longest-path-prefix matching the entry
 *     point's file against each deployable's `root_path` (from
 *     `CASOutput.deployable_evidence`, see deployable-evidence.ts). No
 *     match is left unset rather than guessed.
 *
 *  2. `ensureEntryPointDescription` — every entry point gets a
 *     `description` + `description_source`. Existing descriptions are
 *     preserved and tagged (source defaults to 'deterministic' if untagged,
 *     since analyzers author these from structural facts, not AI). Missing
 *     descriptions are synthesized ONLY from the entry point's own
 *     structural fields (type/trigger/name) — never domain vocabulary.
 *
 * Both functions return NEW arrays/objects (entry points are not mutated
 * in place) so callers can diff before/after if needed.
 */

/** A deployable candidate reduced to what attribution needs. */
export interface DeployableRoot {
  deployable_id: string;
  deployable_name: string;
  rootPath: string;
}

/**
 * `CASEntryPoint` does not (yet) declare `deployable_id`/`deployable_name` —
 * see the PROPOSED type addition in this module's usage notes / the task
 * report. This local extension lets `attachDeployable` be fully typed
 * without editing `cas.types.ts`. Once those two optional fields land on
 * `CASEntryPoint` itself, this type becomes a no-op alias.
 */
export interface CASEntryPointWithDeployable extends CASEntryPoint {
  deployable_id?: string;
  deployable_name?: string;
}

/**
 * Build a deterministic, stably-ordered list of deployable roots from
 * `CASOutput.deployable_evidence`.
 *
 * `DeployableEvidence` carries no id of its own (see cas.types.ts) — it is
 * identified structurally by `(kind, root_path, name)`. We synthesize a
 * `deployable_id` slug from that triple, and disambiguate collisions
 * (e.g. two `bin` targets that happen to share root_path + name — should
 * not happen in practice, but the collector is data, not a guarantee) by
 * appending the array index. This keeps the id stable across re-runs as
 * long as the evidence content itself doesn't change, without depending on
 * array position for the common case.
 */
export function buildDeployableRoots(deployableEvidence: DeployableEvidence[] | undefined): DeployableRoot[] {
  if (!deployableEvidence || deployableEvidence.length === 0) {
    return [];
  }

  const seenIds = new Set<string>();
  const roots: DeployableRoot[] = [];

  deployableEvidence.forEach((evidence, index) => {
    const rootPath = normalizePath(evidence.root_path);
    const baseId = `dep:${evidence.kind}:${slug(rootPath)}:${slug(evidence.name)}`;
    let deployable_id = baseId;
    if (seenIds.has(deployable_id)) {
      deployable_id = `${baseId}:${index}`;
    }
    seenIds.add(deployable_id);

    roots.push({
      deployable_id,
      deployable_name: evidence.name,
      rootPath,
    });
  });

  return roots;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'root';
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
}

/**
 * Extract the best-effort source file path for an entry point.
 *
 * Prefers `handler.file` (already a clean repo-relative path emitted by the
 * analyzers) — but `handler.file` is sometimes recorded relative to the
 * sub-package/app scan root that produced it rather than the full
 * monorepo-relative path (e.g. a per-package analysis pass merged into a
 * wider workspace CAS: `src/routes/auth.ts` instead of
 * `packages/analyzer-core/src/routes/auth.ts`). When `nodesById` is supplied
 * and the entry's handler/source node carries a `source.file` that is a
 * proper path-segment superset of `handler.file` (same evidence, missing
 * prefix — not an unrelated path), that corrected path is preferred so it
 * stays consistent with `deployable-evidence.ts`'s root_path correction (see
 * `bin-targets.ts`'s `resolveHandlerFile`); this keeps root-prefix matching
 * below working against the SAME path both evidence and attribution use.
 * Falls back to parsing a real, slash-delimited path with a recognizable
 * file extension out of `source_node` or `id` — several analyzers (rust,
 * cli-frameworks) embed the untouched path there. If no real path can be
 * recovered (e.g. ids that mangle path separators into underscores, with no
 * way to reliably reverse that), returns undefined — callers must not guess
 * a path in that case.
 */
export function extractEntryPointFilePath(ep: CASEntryPoint, nodesById?: Map<string, CASNode>): string | undefined {
  if (ep.handler?.file) {
    const handlerFile = ep.handler.file;
    if (nodesById) {
      const nodeId = ep.handler.node_id || ep.source_node;
      const node = nodeId ? nodesById.get(nodeId) : undefined;
      const nodeFile = node?.source?.file;
      if (nodeFile && nodeFile !== handlerFile && nodeFile.endsWith(`/${handlerFile}`)) {
        return normalizePath(nodeFile);
      }
    }
    return normalizePath(handlerFile);
  }

  const candidates = [ep.source_node, ep.id];
  // A real (non-mangled) path: contains at least one '/', and ends in a
  // dotted extension of 1-10 word characters (e.g. .ts, .rs, .tsx, .mjs).
  const pathPattern = /([\w.-]+\/)+[\w.-]+\.\w{1,10}/;
  for (const candidate of candidates) {
    if (!candidate) continue;
    const match = candidate.match(pathPattern);
    if (match) {
      return normalizePath(match[0]);
    }
  }

  return undefined;
}

/**
 * Longest-path-prefix match a file path against a list of deployable roots.
 * Returns the root whose `rootPath` is a directory-boundary-respecting
 * prefix of `filePath` and is the longest such match. Returns undefined if
 * no root matches (including the case where a root_path of '.' would match
 * everything — see `isPathPrefix`, which requires a real path segment).
 */
export function matchDeployableRoot(filePath: string, roots: DeployableRoot[]): DeployableRoot | undefined {
  let best: DeployableRoot | undefined;
  let bestLength = -1;

  for (const root of roots) {
    if (isPathPrefix(root.rootPath, filePath) && root.rootPath.length > bestLength) {
      best = root;
      bestLength = root.rootPath.length;
    }
  }

  return best;
}

function isPathPrefix(rootPath: string, filePath: string): boolean {
  if (!rootPath || rootPath === '.') {
    // '.' (repo root) is a valid but maximally-weak match: only used when
    // nothing more specific matches, and only if it's the sole candidate
    // that isn't degenerate. Treated as prefix-of-everything at the lowest
    // priority via its length (0) losing to any real root.
    return true;
  }
  if (filePath === rootPath) return true;
  return filePath.startsWith(`${rootPath}/`);
}

/**
 * Attribute each entry point to the deployable that owns it (longest
 * matching root_path prefix on the entry point's resolved file path).
 * Entry points whose file can't be resolved, or that match no root, are
 * returned unchanged (deployable_id / deployable_name left unset) — this
 * function never guesses.
 *
 * `nodes` is optional and additive (existing callers are unaffected): when
 * supplied, it lets `extractEntryPointFilePath` correct a `handler.file`
 * that was recorded relative to a sub-package scan root instead of the full
 * monorepo-relative path, keeping this matcher in sync with the same
 * correction `deployable-evidence.ts` applies to `root_path` (see
 * `bin-targets.ts`'s `resolveHandlerFile`). Without it, attribution still
 * works exactly as before.
 */
export function attachDeployable(
  entryPoints: CASEntryPoint[],
  deployableEvidence: DeployableEvidence[] | undefined,
  nodes?: CASNode[],
): CASEntryPointWithDeployable[] {
  const roots = buildDeployableRoots(deployableEvidence);
  if (roots.length === 0) {
    return entryPoints.map(ep => ({ ...ep }));
  }
  const nodesById = nodes ? new Map(nodes.map(n => [n.id, n])) : undefined;

  return entryPoints.map(ep => {
    const filePath = extractEntryPointFilePath(ep, nodesById);
    if (!filePath) {
      return { ...ep };
    }

    const match = matchDeployableRoot(filePath, roots);
    if (!match) {
      return { ...ep };
    }

    return {
      ...ep,
      deployable_id: match.deployable_id,
      deployable_name: match.deployable_name,
    };
  });
}

/**
 * Synthesize a deterministic, evidence-grounded description string from an
 * entry point's own structural fields only (type + trigger + name). Never
 * invents domain meaning. Returns undefined if the entry point's type
 * doesn't carry enough structural information to say anything more useful
 * than a generic fallback (the fallback is still returned, never undefined,
 * so every entry point ends up with SOME description).
 */
export function synthesizeEntryPointDescription(ep: CASEntryPoint): string {
  const name = ep.name || ep.id;

  switch (ep.type) {
    case 'http': {
      const method = ep.trigger?.method && ep.trigger.method !== 'ALL' ? ep.trigger.method : 'HTTP';
      const path = ep.trigger?.path || ep.trigger?.pattern;
      return path
        ? `${method} ${path} endpoint — ${name}`
        : `${method} endpoint — ${name}`;
    }
    case 'schedule': {
      const schedule = ep.trigger?.schedule;
      return schedule
        ? `Scheduled job (${schedule}) — ${name}`
        : `Scheduled job — ${name}`;
    }
    case 'message': {
      return `Handles the ${name} message`;
    }
    case 'event': {
      const event = ep.trigger?.event;
      return event
        ? `Handles the ${event} event — ${name}`
        : `Handles the ${name} event`;
    }
    case 'cli': {
      return `CLI command ${name}`;
    }
    case 'test': {
      return `Test entry point ${name}`;
    }
    default: {
      return `${ep.type} entry point — ${name}`;
    }
  }
}

/**
 * Ensure every entry point has a `description` + `description_source`.
 *
 *  - Existing description, already tagged: left as-is.
 *  - Existing description, untagged: tagged 'deterministic' (analyzers
 *    author these from structural facts, not AI — 'reused' is reserved for
 *    descriptions carried over unchanged from a prior CAS revision, which
 *    this function has no way to distinguish and therefore does not claim).
 *  - Missing description: synthesized via `synthesizeEntryPointDescription`
 *    and tagged 'deterministic'.
 */
export function ensureEntryPointDescription(entryPoints: CASEntryPoint[]): CASEntryPoint[] {
  return entryPoints.map(ep => {
    const hasDescription = typeof ep.description === 'string' && ep.description.trim().length > 0;

    if (hasDescription) {
      if (ep.description_source) {
        return { ...ep };
      }
      return { ...ep, description_source: 'deterministic' as const };
    }

    return {
      ...ep,
      description: synthesizeEntryPointDescription(ep),
      description_source: 'deterministic' as const,
    };
  });
}
