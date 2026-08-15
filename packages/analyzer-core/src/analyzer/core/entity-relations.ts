





































import type { CASNode, CASEdge, CASDataEntity } from '../../types/cas.types';

export type EntityRelationCardinality = '1:1' | '1:N' | 'N:1' | 'N:M';


export type EntityRelationEvidenceSource =

  | 'orm-edge'

  | 'orm-declaration'

  | 'typed-composition'

  | 'structural-edge';

export interface EntityRelation {

  sourceName: string;
  targetName: string;





  relationType: string;
  kind: 'data' | 'structural';
  cardinality?: EntityRelationCardinality;

  field?: string;

  inverseField?: string;

  owning?: boolean;
  joinTable?: string;
  evidenceSource: EntityRelationEvidenceSource;

  evidence: string;
}

export interface EntityRelationGraph {

  dataByEntityNameLower: Map<string, EntityRelation[]>;

  structuralByEntityNameLower: Map<string, EntityRelation[]>;




  relationFieldsByEntityNameLower: Map<string, Set<string>>;
  counts: { data: number; structural: number; byEvidenceSource: Record<string, number> };
}








const RELATION_KIND_CARDINALITY: Record<string, EntityRelationCardinality> = {

  onetoone: '1:1',
  onetomany: '1:N',
  manytoone: 'N:1',
  manytomany: 'N:M',
  one_to_one: '1:1',
  one_to_many: '1:N',
  many_to_one: 'N:1',
  many_to_many: 'N:M',

  belongs_to: 'N:1',
  has_one: '1:1',
  has_many: '1:N',
  has_and_belongs_to_many: 'N:M',

  belongsto: 'N:1',
  hasone: '1:1',
  hasmany: '1:N',
  belongstomany: 'N:M',
  morphone: '1:1',
  morphmany: '1:N',
  morphto: 'N:1',
  morphtomany: 'N:M',

  foreignkey: 'N:1',
  onetoonefield: '1:1',
  manytomanyfield: 'N:M',

  composition: '1:1',
  composes_many: '1:N',
};


const RELATION_DECLARATION_NAMES = new Set(Object.keys(RELATION_KIND_CARDINALITY).concat([


  'relationship',


  'inverseproperty',
]));


const STRUCTURAL_EDGE_TYPES = new Set(['implements', 'uses_trait', 'extends', 'inherits']);








const COLLECTION_WRAPPERS = new Set([
  'collection', 'array', 'list', 'set', 'iterable', 'sequence', 'vec', 'vecdeque',
  'icollection', 'ienumerable', 'ilist', 'iset', 'hashset', 'arraylist', 'linkedlist',
  'persistentcollection', 'arraycollection', 'queryset', 'relatedmanager',
]);
const REFERENCE_WRAPPERS = new Set([
  'ref', 'reference', 'identifiedreference', 'option', 'optional', 'box', 'arc', 'rc',
  'refcell', 'mutex', 'rwlock', 'cell', 'promise', 'awaited', 'nullable', 'maybe',
  'mapped', 'lazy', 'weakref', 'partial', 'readonly', 'required',
]);

interface TypeShape {

  name?: string;

  collection: boolean;
}









export function resolveDeclaredTypeShape(rawType: string | undefined): TypeShape {
  let type = String(rawType || '').trim();
  if (!type) return { collection: false };
  let collection = false;


  type = type.replace(/^&(?:'\w+\s+)?(?:mut\s+)?/, '').replace(/^\?/, '').trim();

  for (let guard = 0; guard < 8; guard++) {
    const before = type;


    if (type.includes('|')) {
      const parts = type.split('|').map(p => p.trim()).filter(
        p => p && !/^(null|undefined|none|nil|void)$/i.test(p),
      );
      if (parts.length !== 1) return { collection };
      type = parts[0];
    }


    const arraySuffix = /^(.*?)\s*\[\s*\]$/.exec(type);
    if (arraySuffix) {
      collection = true;
      type = arraySuffix[1].trim();
      continue;
    }


    const slice = /^\[\s*([^;\]]+?)\s*(?:;[^\]]*)?\]$/.exec(type);
    if (slice) {
      collection = true;
      type = slice[1].trim();
      continue;
    }


    const generic = /^([A-Za-z_][\w.]*)\s*[<[]\s*([\s\S]+?)\s*[>\]]$/.exec(type);
    if (generic) {
      const wrapper = generic[1].split('.').pop()!.toLowerCase();
      const inner = generic[2].trim();



      const args = splitTopLevel(inner);
      if (COLLECTION_WRAPPERS.has(wrapper)) {
        collection = true;
        type = args[0];
        continue;
      }
      if (REFERENCE_WRAPPERS.has(wrapper)) {
        type = args[0];
        continue;
      }


      return { name: undefined, collection };
    }

    if (type === before) break;
  }


  return /^[A-Za-z_][\w.]*$/.test(type)
    ? { name: type.split('.').pop(), collection }
    : { collection };
}

function splitTopLevel(input: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of input) {
    if (ch === '<' || ch === '[' || ch === '(') depth++;
    else if (ch === '>' || ch === ']' || ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out.length ? out : [input.trim()];
}


export function cardinalityForRelationType(
  relationType: string | undefined,
  hints: { collection?: boolean } = {},
): EntityRelationCardinality | undefined {
  const key = String(relationType || '').trim().toLowerCase().replace(/[\s-]/g, '');
  const direct = RELATION_KIND_CARDINALITY[key] || RELATION_KIND_CARDINALITY[
    String(relationType || '').trim().toLowerCase()
  ];
  if (direct) return direct;


  if (hints.collection === true) return '1:N';
  return undefined;
}

interface RelationDeclaration {
  relationType: string;
  target?: string;
  inverseField?: string;
  owning?: boolean;
  joinTable?: string;
  evidence: string;
}











export function parseRelationDeclaration(raw: string): RelationDeclaration | undefined {
  const text = String(raw || '').trim();
  if (!text) return undefined;




  const sigilless = text.replace(/^[#@[\s]+/, '');
  const nameMatch = /^(?:[\w]+\s*\\\s*)*([A-Za-z_]\w*)/.exec(sigilless);
  const declName = nameMatch?.[1];
  if (!declName || !RELATION_DECLARATION_NAMES.has(declName.toLowerCase())) return undefined;

  const decl: RelationDeclaration = { relationType: declName, evidence: text.slice(0, 220) };


  const lambda = /=>\s*([A-Za-z_]\w*)/.exec(text);
  if (lambda) decl.target = lambda[1];


  const targetEntity = /targetEntity\s*[:=]\s*["']?\\?([\w\\]+)["']?/.exec(text);
  if (!decl.target && targetEntity) decl.target = targetEntity[1].split('\\').pop();



  if (!decl.target) {
    const firstArg = /\(\s*["']?([A-Za-z_][\w.]*)["']?\s*[,)]/.exec(text);
    if (firstArg) decl.target = firstArg[1].split('.').pop();
  }




  const mappedBy = /mappedBy\s*[:=]\s*["']([\w]+)["']/.exec(text);
  const inversedBy = /inversedBy\s*[:=]\s*["']([\w]+)["']/.exec(text);
  const backPopulates = /back_populates\s*=\s*["']([\w]+)["']/.exec(text);
  const secondArrow = /=>\s*\w+\s*\.\s*(\w+)/.exec(text);
  decl.inverseField = mappedBy?.[1] || inversedBy?.[1] || backPopulates?.[1] || secondArrow?.[1];
  if (mappedBy) decl.owning = false;
  else if (inversedBy) decl.owning = true;

  const joinTable = /(?:joinTable|name)\s*[:=]\s*["']([\w]+)["']/.exec(text);
  if (joinTable && /manytomany/i.test(declName)) decl.joinTable = joinTable[1];

  return decl;
}

export interface ExtractEntityRelationsInput {
  nodes?: CASNode[];
  edges?: CASEdge[];





  dataEntities?: CASDataEntity[];
}






export function extractEntityRelations(input: ExtractEntityRelationsInput): EntityRelationGraph {
  const nodes = input.nodes || [];
  const edges = input.edges || [];
  const dataEntities = input.dataEntities || [];

  const nodesById = new Map<string, CASNode>();
  for (const node of nodes) if (!nodesById.has(node.id)) nodesById.set(node.id, node);



  const canonicalByLower = new Map<string, string>();
  const addCanonical = (name: string | undefined) => {
    if (!name) return;
    const key = name.toLowerCase();
    if (!canonicalByLower.has(key)) canonicalByLower.set(key, name);
  };
  for (const entity of dataEntities) addCanonical(entity.name);
  for (const node of nodes) {
    if (node.type === 'entity' || node.type === 'model' || node.subcategories?.includes('entity')) {
      addCanonical(node.name);
    }
  }

  const dataByEntityNameLower = new Map<string, EntityRelation[]>();
  const structuralByEntityNameLower = new Map<string, EntityRelation[]>();
  const relationFieldsByEntityNameLower = new Map<string, Set<string>>();
  const byEvidenceSource: Record<string, number> = {};
  const seen = new Set<string>();

  const push = (relation: EntityRelation) => {




    if (relation.kind === 'data' && relation.field) {
      if (relationFieldsByEntityNameLower.get(relation.sourceName.toLowerCase())?.has(relation.field)) return;
    }



    const key = [
      relation.sourceName.toLowerCase(),
      (relation.cardinality || relation.relationType).toLowerCase(),
      relation.targetName.toLowerCase(),
      (relation.field || '').toLowerCase(),
      relation.kind,
    ].join('|');
    if (seen.has(key)) return;
    seen.add(key);
    const bucket = relation.kind === 'data' ? dataByEntityNameLower : structuralByEntityNameLower;
    const list = bucket.get(relation.sourceName.toLowerCase());
    if (list) list.push(relation);
    else bucket.set(relation.sourceName.toLowerCase(), [relation]);
    byEvidenceSource[relation.evidenceSource] = (byEvidenceSource[relation.evidenceSource] || 0) + 1;
    if (relation.kind === 'data' && relation.field) {
      const fieldKey = relation.sourceName.toLowerCase();
      let fields = relationFieldsByEntityNameLower.get(fieldKey);
      if (!fields) {
        fields = new Set<string>();
        relationFieldsByEntityNameLower.set(fieldKey, fields);
      }
      fields.add(relation.field);
    }
  };




  for (const edge of edges) {
    const attributes = (edge.metadata as any)?.attributes || {};
    const relationType = attributes.relationType as string | undefined;
    const source = nodesById.get(edge.source);
    const target = nodesById.get(edge.target);
    if (!source?.name || !target?.name) continue;

    if (relationType) {
      const sourceName = canonicalByLower.get(source.name.toLowerCase());
      const targetName = canonicalByLower.get(target.name.toLowerCase());
      if (!sourceName || !targetName) continue;
      push({
        sourceName,
        targetName,
        relationType,
        kind: 'data',
        cardinality: cardinalityForRelationType(relationType),
        field: attributes.field,
        inverseField: attributes.inverseField || attributes.mappedBy || attributes.inversedBy,
        joinTable: attributes.joinTable,
        evidenceSource: 'orm-edge',
        evidence: `ORM analyzer relation edge ${relationType}${attributes.field ? ` via ${attributes.field}` : ''}`,
      });
      continue;
    }

    if (STRUCTURAL_EDGE_TYPES.has(edge.type)) {
      const sourceName = canonicalByLower.get(source.name.toLowerCase());
      if (!sourceName) continue;
      push({
        sourceName,
        targetName: target.name,
        relationType: edge.type,
        kind: 'structural',
        evidenceSource: 'structural-edge',
        evidence: `${edge.type} edge to ${target.name}`,
      });
    }
  }





  const ownerNameForProperty = buildPropertyOwnerIndex(nodes, canonicalByLower);
  for (const node of nodes) {
    if (node.type !== 'property' && node.type !== 'field' && node.type !== 'attribute') continue;
    const owner = ownerNameForProperty.get(node.id);
    if (!owner) continue;
    const attributes = (node.metadata as any)?.attributes || {};


    const preParsedType = String(attributes.relation_type || attributes.relationType || '');
    if (preParsedType) {
      const rawTarget = attributes.target_entity || attributes.targetEntity;
      const declaredShape = resolveDeclaredTypeShape(
        (node.metadata as any)?.type || node.signature?.return_type,
      );
      const targetGuess = rawTarget && String(rawTarget) !== 'unknown'
        ? String(rawTarget).split('\\').pop()!.split('.').pop()!
        : declaredShape.name;
      const targetName = targetGuess ? canonicalByLower.get(targetGuess.toLowerCase()) : undefined;
      if (targetName) {
        push({
          sourceName: owner,
          targetName,
          relationType: preParsedType,
          kind: 'data',
          cardinality: cardinalityForRelationType(preParsedType, { collection: declaredShape.collection }),
          field: node.name,
          inverseField: attributes.inverse_field || attributes.mappedBy || attributes.inversedBy,
          joinTable: attributes.join_table || attributes.joinTable,
          evidenceSource: 'orm-declaration',
          evidence: `relation attribute ${preParsedType} on ${owner}.${node.name}`,
        });
        continue;
      }
    }


    const declarations: string[] = [
      ...((node.metadata as any)?.annotations || []),
      ...(Array.isArray(attributes.decorators) ? attributes.decorators : []),
      ...(Array.isArray(attributes.annotations) ? attributes.annotations : []),
    ].map(String);
    for (const raw of declarations) {
      const parsed = parseRelationDeclaration(raw);
      if (!parsed) continue;
      const declaredShape = resolveDeclaredTypeShape(
        (node.metadata as any)?.type || node.signature?.return_type,
      );
      const targetGuess = parsed.target || declaredShape.name;
      const targetName = targetGuess ? canonicalByLower.get(targetGuess.toLowerCase()) : undefined;
      if (!targetName) continue;
      push({
        sourceName: owner,
        targetName,
        relationType: parsed.relationType,
        kind: 'data',
        cardinality: cardinalityForRelationType(parsed.relationType, { collection: declaredShape.collection }),
        field: node.name,
        inverseField: parsed.inverseField,
        owning: parsed.owning,
        joinTable: parsed.joinTable,
        evidenceSource: 'orm-declaration',
        evidence: `${parsed.evidence} on ${owner}.${node.name}`,
      });
    }
  }






  for (const entity of dataEntities) {
    const sourceName = canonicalByLower.get(entity.name.toLowerCase()) || entity.name;
    for (const field of entity.fields || []) {


      if (relationFieldsByEntityNameLower.get(sourceName.toLowerCase())?.has(field.name)) continue;
      const shape = resolveDeclaredTypeShape(field.type);
      if (!shape.name) continue;
      const targetName = canonicalByLower.get(shape.name.toLowerCase());
      if (!targetName) continue;


      if (targetName.toLowerCase() === sourceName.toLowerCase() && !shape.collection) continue;
      push({
        sourceName,
        targetName,
        relationType: shape.collection ? 'composes_many' : 'composition',
        kind: 'data',
        cardinality: shape.collection ? '1:N' : '1:1',
        field: field.name,
        evidenceSource: 'typed-composition',
        evidence: `field ${sourceName}.${field.name} is typed \`${field.type}\``,
      });
    }
  }

  let data = 0;
  let structural = 0;
  for (const list of dataByEntityNameLower.values()) data += list.length;
  for (const list of structuralByEntityNameLower.values()) structural += list.length;

  return {
    dataByEntityNameLower,
    structuralByEntityNameLower,
    relationFieldsByEntityNameLower,
    counts: { data, structural, byEvidenceSource },
  };
}








function buildPropertyOwnerIndex(
  nodes: CASNode[],
  canonicalByLower: Map<string, string>,
): Map<string, string> {
  const ownerByPropertyId = new Map<string, string>();
  const entityNodesById = new Map<string, CASNode>();
  const entityNodesByFile = new Map<string, CASNode[]>();

  for (const node of nodes) {
    const isEntityNode =
      node.type === 'entity' || node.type === 'model' || node.subcategories?.includes('entity');
    if (!isEntityNode || !canonicalByLower.has(node.name.toLowerCase())) continue;
    entityNodesById.set(node.id, node);
    const file = node.source?.file;
    if (!file) continue;
    const bucket = entityNodesByFile.get(file);
    if (bucket) bucket.push(node);
    else entityNodesByFile.set(file, [node]);
  }

  for (const node of nodes) {
    if (node.type !== 'property' && node.type !== 'field' && node.type !== 'attribute') continue;
    if (node.parent) {
      const owner = entityNodesById.get(node.parent);
      if (owner) {
        ownerByPropertyId.set(node.id, canonicalByLower.get(owner.name.toLowerCase()) || owner.name);
        continue;
      }
    }
    const file = node.source?.file;
    if (!file) continue;
    const candidates = entityNodesByFile.get(file);



    if (candidates?.length === 1) {
      const owner = candidates[0];
      ownerByPropertyId.set(node.id, canonicalByLower.get(owner.name.toLowerCase()) || owner.name);
    }
  }

  return ownerByPropertyId;
}
