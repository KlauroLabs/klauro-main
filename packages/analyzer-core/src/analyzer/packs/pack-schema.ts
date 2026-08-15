








import { z } from 'zod';
import { ENTRY_POINT_TYPES } from '../../types/cas.types';







const EntryPointKindSchema = z.enum(
  ENTRY_POINT_TYPES as unknown as [string, ...string[]],
  { message: `entry-point "kind" must be one of: ${ENTRY_POINT_TYPES.join(', ')}` },
);





const EmitEntryPointSchema = z.object({
  fact: z.literal('entry_point'),
  kind: EntryPointKindSchema,
  method: z.string().optional(),
  path: z.string().optional(),
  handler: z.string().optional(),
  name: z.string().optional(),
});

const EmitEntitySchema = z.object({
  fact: z.literal('entity'),
  name: z.string(),
  node_type: z.string().optional(),
});

const EmitEdgeSchema = z.object({
  fact: z.literal('edge'),
  from: z.string(),
  to: z.string(),
  type: z.string(),
});

const EmitBindingSchema = z.object({
  fact: z.literal('binding'),
  token: z.string(),
  implementation: z.string(),
});

const EmitRoleSchema = z.object({
  fact: z.literal('role'),
  target: z.string(),
  role: z.string(),
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

  name: z.string().min(1, 'rule "name" is required'),

  query: z.string().min(1, 'rule "query" is required'),

  emit: z.array(EmitSchema).min(1, 'rule must have at least one "emit" entry'),
});
export type PackRule = z.infer<typeof RuleSchema>;

const AppliesWhenSchema = z.object({


  dependency: z.array(z.string()).optional(),

  file: z.array(z.string()).optional(),

  import: z.array(z.string()).optional(),
}).default({});
export type AppliesWhen = z.infer<typeof AppliesWhenSchema>;

export const PackSchema = z.object({

  pack: z.string().min(1, '"pack" (pack id) is required'),

  name: z.string().optional(),

  version: z.string().optional(),


  language: z.enum(['typescript', 'javascript', 'typescript-javascript']),


  files: z.array(z.string()).optional(),


  applies_when: AppliesWhenSchema,

  rules: z.array(RuleSchema).min(1, 'pack must have at least one rule'),
});
export type Pack = z.infer<typeof PackSchema>;

export interface PackValidationResult {
  ok: boolean;
  errors: string[];
  pack?: Pack;
}



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
