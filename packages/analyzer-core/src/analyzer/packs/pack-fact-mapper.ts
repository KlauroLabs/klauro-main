/**
 * Maps a query match's tree-sitter captures to real CAS facts, following the
 * rule's `emit` template. Evidence-based: a template field referencing
 * `@capture` that the query didn't actually capture for this match resolves
 * to undefined and the fact is DROPPED (never fabricated) rather than emitted
 * with a placeholder. Literal (non-`@capture`) strings pass through unchanged.
 */
import { QueryMatch } from './pack-query-runner';
import { Emit } from './pack-schema';

const CAPTURE_REF = /^@([A-Za-z_][A-Za-z0-9_]*)$/;

/** Resolve one template field: "@name" -> that capture's text, "literal" -> itself. */
export function resolveField(template: string | undefined, match: QueryMatch): string | undefined {
  if (template === undefined) return undefined;
  const m = CAPTURE_REF.exec(template.trim());
  if (!m) return template;
  const capture = match.captures[m[1]];
  return capture ? capture.text : undefined;
}

export interface MappedEntryPointFact {
  kind: 'entry_point';
  entryKind: string;
  method?: string;
  path?: string;
  handler?: string;
  name: string;
  file: string;
  line: number;
}

export interface MappedEntityFact {
  kind: 'entity';
  name: string;
  nodeType: string;
  file: string;
  line: number;
}

export interface MappedEdgeFact {
  kind: 'edge';
  from: string;
  to: string;
  edgeType: string;
  file: string;
  line: number;
}

export interface MappedBindingFact {
  kind: 'binding';
  token: string;
  implementation: string;
  file: string;
  line: number;
}

export interface MappedRoleFact {
  kind: 'role';
  target: string;
  role: string;
  file: string;
  line: number;
}

export type MappedFact = MappedEntryPointFact | MappedEntityFact | MappedEdgeFact | MappedBindingFact | MappedRoleFact;

/** Map every `emit` entry for one query match into zero-or-more facts.
 *  An emit whose REQUIRED fields don't resolve (missing capture) is skipped
 *  — evidence-gated, matching the .klaurorc conventions applier's contract
 *  ("a declared convention that matches nothing real emits nothing"). */
export function mapMatchToFacts(emits: Emit[], match: QueryMatch, filePath: string): MappedFact[] {
  const facts: MappedFact[] = [];

  for (const emit of emits) {
    switch (emit.fact) {
      case 'entry_point': {
        const method = resolveField(emit.method, match);
        const path_ = resolveField(emit.path, match);
        const handler = resolveField(emit.handler, match);
        const explicitName = resolveField(emit.name, match);
        // Need at least a path or a handler to have real evidence of an endpoint.
        if (!path_ && !handler) continue;
        const name = explicitName || [method?.toUpperCase(), path_].filter(Boolean).join(' ') || handler || 'entry point';
        facts.push({
          kind: 'entry_point', entryKind: emit.kind, method, path: path_, handler,
          name, file: filePath, line: match.line,
        });
        break;
      }
      case 'entity': {
        const name = resolveField(emit.name, match);
        if (!name) continue;
        facts.push({ kind: 'entity', name, nodeType: emit.node_type || 'entity', file: filePath, line: match.line });
        break;
      }
      case 'edge': {
        const from = resolveField(emit.from, match);
        const to = resolveField(emit.to, match);
        if (!from || !to) continue;
        facts.push({ kind: 'edge', from, to, edgeType: emit.type, file: filePath, line: match.line });
        break;
      }
      case 'binding': {
        const token = resolveField(emit.token, match);
        const implementation = resolveField(emit.implementation, match);
        if (!token || !implementation) continue;
        facts.push({ kind: 'binding', token, implementation, file: filePath, line: match.line });
        break;
      }
      case 'role': {
        const target = resolveField(emit.target, match);
        if (!target) continue;
        facts.push({ kind: 'role', target, role: emit.role, file: filePath, line: match.line });
        break;
      }
    }
  }

  return facts;
}
