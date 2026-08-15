























import type { CASDomainConcept, CASDataEntity, CASDatabaseSchema, CASNode, CASEdge } from '../../../packages/analyzer-core/src/types/cas.types';
import {
  cardinalityForRelationType,
  extractEntityRelations,
  type EntityRelationCardinality,
  type EntityRelationEvidenceSource,
} from '../../../packages/analyzer-core/src/analyzer/core/entity-relations';

export type SemanticRole = 'core' | 'supporting' | 'infrastructure';




export interface RoleClassification {
  role?: SemanticRole;
  role_evidence: string[];
}



const ROLE_RANK: Record<SemanticRole, number> = { core: 3, supporting: 2, infrastructure: 1 };

export function normalizeRoleName(value: unknown): string {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}










export function isRuntimeEndpointSemanticName(name: unknown): boolean {
  const raw = String(name || '');
  const compact = raw.trim();
  const normalizedText = normalizeRoleName(raw);
  return /^[a-z0-9 ._-]+:\d+(?:\b|$)/i.test(compact) ||
    /\bhttps?:\/\/[a-z0-9._-]+:\d+/i.test(compact) ||
    /^[a-z0-9 ._-]+\s+\d{2,5}$/.test(normalizedText);
}




export function strongerRole(left?: SemanticRole, right?: SemanticRole): SemanticRole | undefined {
  if (!left) return right;
  if (!right) return left;
  return ROLE_RANK[right] > ROLE_RANK[left] ? right : left;
}









export interface DomainConceptIndex {






  byEntityKey: Map<string, CASDomainConcept[]>;
  byEntryPoint: Map<string, CASDomainConcept[]>;
  byNode: Map<string, CASDomainConcept[]>;
  size: number;
}




function stripEntityRef(value: unknown): string {
  return normalizeRoleName(String(value || '').replace(/^entity[_\s]+/i, ''));
}



export function entityKeys(entity: { id?: string; name?: string }): string[] {
  const keys = new Set<string>();
  if (entity.id) { keys.add(entity.id); keys.add(stripEntityRef(entity.id)); }
  if (entity.name) { keys.add(normalizeRoleName(entity.name)); keys.add(stripEntityRef(entity.name)); }
  keys.delete('');
  return [...keys];
}

export function buildDomainConceptIndex(concepts: CASDomainConcept[] | undefined): DomainConceptIndex {
  const byEntityKey = new Map<string, CASDomainConcept[]>();
  const byEntryPoint = new Map<string, CASDomainConcept[]>();
  const byNode = new Map<string, CASDomainConcept[]>();
  const push = (map: Map<string, CASDomainConcept[]>, key: string, concept: CASDomainConcept) => {
    if (!key) return;
    const list = map.get(key);
    if (list) { if (!list.includes(concept)) list.push(concept); } else map.set(key, [concept]);
  };
  for (const concept of concepts || []) {
    for (const ent of concept.appears_in?.entities || []) {


      push(byEntityKey, String(ent), concept);
      push(byEntityKey, stripEntityRef(ent), concept);
      push(byEntityKey, normalizeRoleName(ent), concept);
    }
    for (const ep of concept.appears_in?.entry_points || []) {
      push(byEntryPoint, ep, concept);
    }
    for (const nodeId of concept.appears_in?.nodes || []) {
      push(byNode, nodeId, concept);
    }
  }
  return { byEntityKey, byEntryPoint, byNode, size: (concepts || []).length };
}


function conceptsForEntity(entity: { id?: string; name?: string }, index: DomainConceptIndex): CASDomainConcept[] {
  const seen = new Set<CASDomainConcept>();
  for (const key of entityKeys(entity)) {
    for (const c of index.byEntityKey.get(key) || []) seen.add(c);
  }
  return [...seen];
}


function roleFromConcepts(concepts: CASDomainConcept[] | undefined): { role?: SemanticRole; evidence?: string } {
  if (!concepts || concepts.length === 0) return {};
  let best: SemanticRole | undefined;
  let bestConcept: CASDomainConcept | undefined;
  for (const c of concepts) {
    const stronger = strongerRole(best, c.classification);
    if (stronger !== best) { best = stronger; bestConcept = c; }
    if (!bestConcept) bestConcept = c;
  }
  if (!best) return {};
  return {
    role: best,
    evidence: `domain concept "${bestConcept!.name}" (classified ${best}) references this`,
  };
}







export interface EntityRelationEvidence {
  targetName: string;
  relationType: string;
  field?: string;
  kind: 'data' | 'structural';
  cardinality?: EntityRelationCardinality;
  inverseField?: string;
  owning?: boolean;
  joinTable?: string;
  evidenceSource: EntityRelationEvidenceSource;
  evidence: string;
}

export interface EntityRelationIndex {



  byEntityNameLower: Map<string, EntityRelationEvidence[]>;

  dataByEntityNameLower: Map<string, EntityRelationEvidence[]>;

  structuralByEntityNameLower: Map<string, EntityRelationEvidence[]>;

  relationFieldsByEntityNameLower: Map<string, Set<string>>;
}
























export function buildEntityRelationIndex(
  cas: {
    nodes?: CASNode[];
    edges?: CASEdge[];
    entities?: CASDataEntity[];
    database_schema?: CASDatabaseSchema;
  },
): EntityRelationIndex {
  const graph = extractEntityRelations({
    nodes: cas.nodes,
    edges: cas.edges,
    dataEntities: cas.entities,
  });

  const toEvidence = (relation: {
    targetName: string; relationType: string; kind: 'data' | 'structural';
    cardinality?: EntityRelationCardinality; field?: string; inverseField?: string;
    owning?: boolean; joinTable?: string; evidenceSource: EntityRelationEvidenceSource; evidence: string;
  }): EntityRelationEvidence => ({
    targetName: relation.targetName,
    relationType: relation.relationType,
    field: relation.field,
    kind: relation.kind,
    cardinality: relation.cardinality,
    inverseField: relation.inverseField,
    owning: relation.owning,
    joinTable: relation.joinTable,
    evidenceSource: relation.evidenceSource,
    evidence: relation.evidence,
  });

  const dataByEntityNameLower = new Map<string, EntityRelationEvidence[]>();
  const structuralByEntityNameLower = new Map<string, EntityRelationEvidence[]>();
  const relationFieldsByEntityNameLower = new Map<string, Set<string>>(
    [...graph.relationFieldsByEntityNameLower].map(([key, set]) => [key, new Set(set)]),
  );
  const seen = new Set<string>();

  const claimedDataFields = new Map<string, Set<string>>();
  const add = (
    bucket: Map<string, EntityRelationEvidence[]>,
    key: string,
    evidence: EntityRelationEvidence,
  ) => {



    if (evidence.kind === 'data' && evidence.field) {
      const claimed = claimedDataFields.get(key);
      if (claimed?.has(evidence.field)) return;
      if (claimed) claimed.add(evidence.field);
      else claimedDataFields.set(key, new Set([evidence.field]));
    }
    const dedupeKey = [
      key, evidence.kind, (evidence.cardinality || evidence.relationType).toLowerCase(),
      evidence.targetName.toLowerCase(), (evidence.field || '').toLowerCase(),
    ].join('|');
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    const list = bucket.get(key);
    if (list) list.push(evidence);
    else bucket.set(key, [evidence]);
  };




  for (const entity of cas.entities || []) {
    const key = entity.name.toLowerCase();
    for (const relation of entity.relations || []) {
      const evidence: EntityRelationEvidence = {
        targetName: relation.target_name,
        relationType: relation.relation_type,
        field: relation.field,
        kind: relation.kind,
        cardinality: relation.cardinality,
        inverseField: relation.inverse_field,
        owning: relation.owning,
        joinTable: relation.join_table,
        evidenceSource: relation.evidence_source,
        evidence: relation.evidence,
      };
      add(relation.kind === 'data' ? dataByEntityNameLower : structuralByEntityNameLower, key, evidence);
      if (relation.kind === 'data' && relation.field) {
        let fields = relationFieldsByEntityNameLower.get(key);
        if (!fields) {
          fields = new Set<string>();
          relationFieldsByEntityNameLower.set(key, fields);
        }
        fields.add(relation.field);
      }
    }
  }







  const schemaEntityNames = new Map(
    (cas.database_schema?.entities || []).map(entity => [entity.name.toLowerCase(), entity.name]),
  );
  const knownTargetName = (name: string): string | undefined =>
    (cas.entities || []).find(entity => entity.name.toLowerCase() === name.toLowerCase())?.name
    || schemaEntityNames.get(name.toLowerCase());
  for (const schemaEntity of cas.database_schema?.entities || []) {
    const key = schemaEntity.name.toLowerCase();
    for (const relation of schemaEntity.relationships || []) {
      const targetName = relation.target ? knownTargetName(relation.target) : undefined;
      if (!targetName) continue;
      add(dataByEntityNameLower, key, {
        targetName,
        relationType: relation.type,
        field: relation.field || undefined,
        kind: 'data',
        cardinality: cardinalityForRelationType(relation.type),
        inverseField: relation.inverse_field,
        joinTable: relation.join_table,
        evidenceSource: 'orm-declaration',
        evidence: `ORM relation ${relation.type}${relation.field ? ` declared on ${schemaEntity.name}.${relation.field}` : ''}`,
      });
      if (relation.field) {
        let fields = relationFieldsByEntityNameLower.get(key);
        if (!fields) {
          fields = new Set<string>();
          relationFieldsByEntityNameLower.set(key, fields);
        }
        fields.add(relation.field);
      }
    }
  }

  for (const [key, relations] of graph.dataByEntityNameLower) {
    for (const relation of relations) add(dataByEntityNameLower, key, toEvidence(relation));
  }
  for (const [key, relations] of graph.structuralByEntityNameLower) {
    for (const relation of relations) add(structuralByEntityNameLower, key, toEvidence(relation));
  }



  const byEntityNameLower = new Map<string, EntityRelationEvidence[]>();
  for (const key of new Set([...dataByEntityNameLower.keys(), ...structuralByEntityNameLower.keys()])) {
    byEntityNameLower.set(key, [
      ...(dataByEntityNameLower.get(key) || []),
      ...(structuralByEntityNameLower.get(key) || []),
    ]);
  }

  return {
    byEntityNameLower,
    dataByEntityNameLower,
    structuralByEntityNameLower,
    relationFieldsByEntityNameLower,
  };
}





function hasIntegrationCredentialFieldShape(fields: CASDataEntity['fields'] | undefined): boolean {
  const vocab = new Set(['auth', 'credential', 'credentials', 'token', 'apikey', 'api', 'key', 'secret', 'oauth', 'webhook', 'access', 'refresh']);
  return (fields || []).some(field => {
    const words = String(field.name || '')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);



    const unambiguous = new Set(['auth', 'credential', 'credentials', 'oauth', 'webhook']);
    if (words.some(word => unambiguous.has(word))) return true;
    return words.filter(word => vocab.has(word)).length >= 2;
  });
}













function isConnectionIntegrationTargetName(name: string): boolean {
  const spaced = String(name || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return /\b(connection|integration|oauth|webhook)\b/i.test(spaced);
}














export function classifyIntegrationSyncEntity(
  entityName: string,
  relations: EntityRelationIndex,
  domainEntityNamesLower: Set<string>,
  fieldsByNameLower?: Map<string, CASDataEntity['fields']>,
): { isIntegrationSync: boolean; evidence: string[] } {
  const own = relations.byEntityNameLower.get(entityName.toLowerCase()) || [];
  if (own.length < 2) return { isIntegrationSync: false, evidence: [] };

  const isConnectionTarget = (rel: EntityRelationEvidence) =>
    isConnectionIntegrationTargetName(rel.targetName) ||
    hasIntegrationCredentialFieldShape(fieldsByNameLower?.get(rel.targetName.toLowerCase()));

  const connectionRelations = own.filter(isConnectionTarget);
  const domainRelations = own.filter(rel =>
    !isConnectionTarget(rel) && domainEntityNamesLower.has(rel.targetName.toLowerCase())
  );

  if (connectionRelations.length === 0 || domainRelations.length === 0) {
    return { isIntegrationSync: false, evidence: [] };
  }

  return {
    isIntegrationSync: true,
    evidence: [
      `ORM relation "${domainRelations[0].field || domainRelations[0].relationType}" pairs this entity with domain entity "${domainRelations[0].targetName}"`,
      `ORM relation "${connectionRelations[0].field || connectionRelations[0].relationType}" pairs this entity with connection/integration entity "${connectionRelations[0].targetName}" — integration-sync join record, not a core domain entity`,
    ],
  };
}


















export function classifyEntityRole(
  entity: Pick<CASDataEntity, 'id' | 'name' | 'lifecycle'>,
  index: DomainConceptIndex,
  relationContext?: {
    relations: EntityRelationIndex;
    domainEntityNamesLower: Set<string>;
    fieldsByNameLower?: Map<string, CASDataEntity['fields']>;
  }
): RoleClassification {
  const evidence: string[] = [];

  if (relationContext) {
    const syncCheck = classifyIntegrationSyncEntity(
      entity.name,
      relationContext.relations,
      relationContext.domainEntityNamesLower,
      relationContext.fieldsByNameLower,
    );
    if (syncCheck.isIntegrationSync) {
      return { role: 'infrastructure', role_evidence: syncCheck.evidence };
    }
  }

  const conceptHit = roleFromConcepts(conceptsForEntity(entity, index));

  const created = entity.lifecycle?.created_by?.length || 0;
  const updated = entity.lifecycle?.updated_by?.length || 0;
  const read = entity.lifecycle?.read_by?.length || 0;
  const writers = created + updated;
  const singleOwnerWrite = writers > 0 && writers <= 2;

  if (conceptHit.role) {
    evidence.push(conceptHit.evidence!);
    if (singleOwnerWrite && conceptHit.role === 'core') {
      evidence.push(`single-owner writes (${writers} writer node(s)) — core-entity lifecycle`);
    }
    return { role: conceptHit.role, role_evidence: evidence };
  }
  evidence.push(`no domain-concept or relation-shape evidence; lifecycle has ${writers} writer and ${read} reader reference(s)`);
  return { role_evidence: evidence };
}





export interface FlowRoleStructuralEvidence {

  entry_type?: string;

  entry_file?: string;

  terminus_kind?: string;

  terminus_produces?: string;

  capability_linked?: boolean;
}




function isScriptEntryFile(file: string | undefined): boolean {
  return /\.(sh|bash|zsh|ps1|bat|cmd)$|(^|\/)(makefile|justfile)$/i.test(String(file || ''));
}



const PRODUCT_TERMINUS_KINDS = new Set(['api', 'database', 'cache', 'event', 'webhook', 'message', 'queue', 'navigation']);















export function classifyFlowRole(
  flow: { name?: string; intent?: string; entry_point?: string; entities?: string[] },
  index: DomainConceptIndex,
  structural?: FlowRoleStructuralEvidence
): RoleClassification {
  const evidence: string[] = [];



  if (structural) {
    const scriptEntry = isScriptEntryFile(structural.entry_file);
    const productTerminus = Boolean(structural.terminus_kind && PRODUCT_TERMINUS_KINDS.has(structural.terminus_kind));
    if (scriptEntry && !(structural.capability_linked && productTerminus)) {
      return {
        role: 'infrastructure',
        role_evidence: [
          `entry point is a script file (${structural.entry_file}) — operational build/deploy/install surface, not product flow`,
          ...(structural.terminus_kind ? [`terminus kind: ${structural.terminus_kind}${structural.terminus_produces ? ` (${structural.terminus_produces})` : ''}`] : []),
        ],
      };
    }
    if (structural.capability_linked && productTerminus) {
      evidence.push(
        `serves a capability operation and terminates at ${structural.terminus_kind}${structural.terminus_produces ? ` (${structural.terminus_produces})` : ''} — product-facing terminal evidence`
      );
      return { role: 'core', role_evidence: evidence };
    }
  }


  const epHit = flow.entry_point ? roleFromConcepts(index.byEntryPoint.get(flow.entry_point)) : {};
  if (epHit.role) {
    evidence.push(epHit.evidence!);
  }


  let entityRole: SemanticRole | undefined;
  let entityEvidence: string | undefined;
  for (const ent of flow.entities || []) {
    const hit = roleFromConcepts(conceptsForEntity({ name: ent, id: ent }, index));
    const stronger = strongerRole(entityRole, hit.role);
    if (stronger !== entityRole) { entityRole = stronger; entityEvidence = hit.evidence ? `${hit.evidence} (touched entity "${ent}")` : undefined; }
  }

  const conceptRole = strongerRole(epHit.role, entityRole);
  if (conceptRole) {
    if (entityRole && (!epHit.role || strongerRole(epHit.role, entityRole) === entityRole) && entityEvidence) {
      evidence.push(entityEvidence);
    }
    return { role: conceptRole, role_evidence: evidence };
  }
  evidence.push('no structural terminus or domain-concept evidence');
  return { role_evidence: evidence };
}
