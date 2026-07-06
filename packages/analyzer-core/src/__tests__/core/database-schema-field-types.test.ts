import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';
import type { CASNode } from '../../types/cas.types';

// Regression: buildDatabaseSchema used to set each entity field's `type` solely
// from `signature.return_type`, which is EMPTY for ORM property nodes
// (MikroORM/TypeORM/Prisma `@Property`/`@Column`, JPA fields). The declared TS
// type is stashed on `metadata.type` by the language analyzers, so the field
// type must fall back to that — while staying evidence-gated (only a real type,
// never fabricated; `unknown` when nothing is recoverable). This drives the ERD
// (get_erd / erdToMermaid); without the fallback every field rendered `unknown`.

function propNode(entityId: string, name: string, opts: {
  metadataType?: string;
  returnType?: string;
  annotations?: string[];
}): CASNode {
  return {
    id: `property_${entityId}_${name}`,
    name,
    type: 'property',
    parent: entityId,
    source: { file: 'src/entities/lead.entity.ts', line: 1, end_line: 1 },
    metadata: {
      annotations: opts.annotations ?? ['@Property'],
      // The declared TS type the language analyzer records for the property.
      ...(opts.metadataType !== undefined ? { type: opts.metadataType } : {}),
    } as any,
    ...(opts.returnType !== undefined
      ? { signature: { return_type: opts.returnType } }
      : {}),
  } as unknown as CASNode;
}

function buildSchema(nodes: CASNode[]) {
  const orchestrator = new AnalyzerOrchestrator() as any;
  return orchestrator.buildDatabaseSchema(nodes, [], undefined, []);
}

test('entity field type falls back to metadata.type when signature.return_type is empty', () => {
  const entityId = 'entity_Lead';
  const entity: CASNode = {
    id: entityId,
    name: 'Lead',
    type: 'entity',
    source: { file: 'src/entities/lead.entity.ts', line: 1 },
    metadata: { annotations: ['@Entity'] } as any,
  } as unknown as CASNode;

  const nodes: CASNode[] = [
    entity,
    // MikroORM/TypeORM-shaped: no signature.return_type, real type on metadata.type.
    propNode(entityId, 'status', { metadataType: 'LeadStatus' }),
    propNode(entityId, 'earnings', { metadataType: 'number' }),
    propNode(entityId, 'partnerWorkEmail', { metadataType: 'string' }),
    // Genuinely untyped in source (no return_type, no metadata.type) -> unknown.
    propNode(entityId, 'untyped', {}),
  ];

  const schema = buildSchema(nodes);
  const lead = schema.entities.find((e: any) => e.name === 'Lead');
  expect(lead).toBeDefined();

  const fieldType = (name: string) =>
    lead.fields.find((f: any) => f.name === name)?.type;

  // Real declared types now flow through — no longer 'unknown'.
  expect(fieldType('status')).toBe('LeadStatus');
  expect(fieldType('earnings')).toBe('number');
  expect(fieldType('partnerWorkEmail')).toBe('string');

  // Evidence-gated: a field with no recoverable type stays 'unknown' (not fabricated).
  expect(fieldType('untyped')).toBe('unknown');
});

test('signature.return_type still wins when present (method-shaped nodes)', () => {
  const entityId = 'entity_Report';
  const entity: CASNode = {
    id: entityId,
    name: 'Report',
    type: 'entity',
    source: { file: 'src/entities/report.entity.ts', line: 1 },
    metadata: { annotations: ['@Entity'] } as any,
  } as unknown as CASNode;

  const nodes: CASNode[] = [
    entity,
    // When both are present, the explicit return_type is preferred.
    propNode(entityId, 'total', { returnType: 'bigint', metadataType: 'number' }),
  ];

  const schema = buildSchema(nodes);
  const report = schema.entities.find((e: any) => e.name === 'Report');
  expect(report.fields.find((f: any) => f.name === 'total')?.type).toBe('bigint');
});

test('multi-line union/generic types are collapsed to a single renderable token', () => {
  const entityId = 'entity_Provider';
  const entity: CASNode = {
    id: entityId,
    name: 'Provider',
    type: 'entity',
    source: { file: 'src/entities/provider.entity.ts', line: 1 },
    metadata: { annotations: ['@Entity'] } as any,
  } as unknown as CASNode;

  const nodes: CASNode[] = [
    entity,
    propNode(entityId, 'options', {
      metadataType: '| MicrosoftEntraOptionsDto\n    | GoogleWorkspaceOptionsDto',
    }),
  ];

  const schema = buildSchema(nodes);
  const provider = schema.entities.find((e: any) => e.name === 'Provider');
  const type = provider.fields.find((f: any) => f.name === 'options')?.type;
  expect(type).not.toMatch(/\n/);
  expect(type).toBe('| MicrosoftEntraOptionsDto | GoogleWorkspaceOptionsDto');
});
