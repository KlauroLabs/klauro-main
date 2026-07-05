/**
 * Declarative analyzer-pack schema (Zod) — YAML packs are pure data, validated
 * against this schema before any tree-sitter query runs. A malformed pack must
 * produce a clear, field-specific error, never a crash mid-analysis (same
 * posture as `validateConventions` in apps/mcp-server/src/klauro-config.ts for
 * the .klaurorc local tier of this same declarative model).
 *
 * See docs/SPEC-ANALYZER-PACKS.md for the full format + safety model.
 */
import { z } from 'zod';
import { ENTRY_POINT_TYPES } from '../../types/cas.types';

/** Entry-point `kind` values a pack may declare, derived from the single source
 *  of truth (ENTRY_POINT_TYPES in cas.types.ts) so this enum can never drift
 *  from the union / `isValidEntryPoint` allowlist downstream. A pack declaring a
 *  novel/typo kind FAILS LOUDLY here at load time (a scoped Zod error surfaced in
 *  the pack's error list) instead of being silently dropped later. If exit-point
 *  emits gain their own kinds, gate them the same way against EXIT_POINT_TYPES. */
const EntryPointKindSchema = z.enum(
  ENTRY_POINT_TYPES as unknown as [string, ...string[]],
  { message: `entry-point "kind" must be one of: ${ENTRY_POINT_TYPES.join(', ')}` },
);

/** One capture→fact emit mapping. `as` selects which CAS fact this rule
 *  produces; the other fields say which query captures fill which fact
 *  fields. Every field value is either a literal string or `@captureName`
 *  (substituted with that capture's matched text at emit time). */
const EmitEntryPointSchema = z.object({
  fact: z.literal('entry_point'),
  kind: EntryPointKindSchema,
  method: z.string().optional(),      // literal or "@capture"
  path: z.string().optional(),        // literal or "@capture"
  handler: z.string().optional(),     // literal or "@capture"
  name: z.string().optional(),        // literal or "@capture"; defaults to "<method> <path>" or handler
});

const EmitEntitySchema = z.object({
  fact: z.literal('entity'),
  name: z.string(),                   // literal or "@capture"
  node_type: z.string().optional(),   // CAS node "type", default "entity"
});

const EmitEdgeSchema = z.object({
  fact: z.literal('edge'),
  from: z.string(),                   // literal or "@capture" — resolved against emitted entry_point/entity names first
  to: z.string(),                     // literal or "@capture"
  type: z.string(),                   // edge type label, e.g. "calls", "binds", "routes_to"
});

const EmitBindingSchema = z.object({
  fact: z.literal('binding'),
  token: z.string(),                  // literal or "@capture"
  implementation: z.string(),         // literal or "@capture"
});

const EmitRoleSchema = z.object({
  fact: z.literal('role'),
  target: z.string(),                 // literal or "@capture" — name of the node this role attaches to
  role: z.string(),                    // role label, e.g. "use-case", "repository"
});

export const EmitSchema = z.discriminatedUnion('fact', [
  EmitEntryPointSchema,
  EmitEntitySchema,
  EmitEdgeSchema,
  EmitBindingSchema,
  EmitRoleSchema,
]);
export type Emit = z.infer<typeof EmitSchema>;

const RuleSchema = z.object({
  /** Rule name, used in error messages and generated node/edge ids. */
  name: z.string().min(1, 'rule "name" is required'),
  /** Tree-sitter query S-expression, e.g. "(call_expression function: (identifier) @fn (#eq? @fn \"get\"))". */
  query: z.string().min(1, 'rule "query" is required'),
  /** One or more capture→fact emit mappings produced per query match. */
  emit: z.array(EmitSchema).min(1, 'rule must have at least one "emit" entry'),
});
export type PackRule = z.infer<typeof RuleSchema>;

const AppliesWhenSchema = z.object({
  /** Any of these must appear in package.json dependencies/devDependencies (npm) or the
   *  language-appropriate manifest. Empty/absent = no dependency gate. */
  dependency: z.array(z.string()).optional(),
  /** Any of these globs must match at least one file for the pack to apply. */
  file: z.array(z.string()).optional(),
  /** Any of these regexes must match an import/require statement's module specifier. */
  import: z.array(z.string()).optional(),
}).default({});
export type AppliesWhen = z.infer<typeof AppliesWhenSchema>;

export const PackSchema = z.object({
  /** Unique pack id, e.g. "hapi-routes". Used as the analyzer id + node/edge namespace. */
  pack: z.string().min(1, '"pack" (pack id) is required'),
  /** Human-readable name. */
  name: z.string().optional(),
  /** Free-text version, purely informational for the prototype. */
  version: z.string().optional(),
  /** Source language the queries are written against. Must have a loadable
   *  tree-sitter grammar (native or vendored WASM) — see wasm-tree-sitter.ts. */
  language: z.enum(['typescript', 'javascript', 'typescript-javascript']),
  /** File glob(s) this pack's rules run against. Defaults to the language's
   *  conventional source extensions when omitted. */
  files: z.array(z.string()).optional(),
  /** Gate: only apply this pack when the repo shows real evidence of the
   *  target framework/library — never fabricate facts on repos that don't use it. */
  applies_when: AppliesWhenSchema,
  /** One or more tree-sitter query rules, each producing CAS facts. */
  rules: z.array(RuleSchema).min(1, 'pack must have at least one rule'),
});
export type Pack = z.infer<typeof PackSchema>;

export interface PackValidationResult {
  ok: boolean;
  errors: string[];
  pack?: Pack;
}

/** Validate raw parsed YAML against the pack schema. Never throws — callers
 *  get a structured result with clear, field-path-qualified error strings. */
export function validatePack(raw: unknown): PackValidationResult {
  const result = PackSchema.safeParse(raw);
  if (result.success) {
    return { ok: true, errors: [], pack: result.data };
  }
  const errors = result.error.issues.map(issue => {
    const path = issue.path.length ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
  return { ok: false, errors };
}
