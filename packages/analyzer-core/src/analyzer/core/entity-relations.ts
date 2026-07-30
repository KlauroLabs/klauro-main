/**
 * Entity relation extraction — the single source of truth for "what is this
 * entity related to, and how".
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Relation evidence used to be read in three unconnected places, each from a
 * different carrier, and each surface therefore disagreed with the others:
 *   - `buildDatabaseSchema` read property DECORATORS off the source file, so
 *     the ERD saw decorator ORMs but nothing edge-based.
 *   - the MCP entity surface read `references` EDGES carrying `relationType`,
 *     so it saw edge-emitting ORM analyzers but no decorator ORMs — and, since
 *     `implements`/`uses_trait` edges were folded in as relation evidence, a
 *     decorator-ORM entity's whole relation list could be a single
 *     entity -> UI-component `implements` edge.
 *   - nothing at all read a field whose declared TYPE *is* another extracted
 *     entity, so composition-by-type ecosystems (structs holding structs)
 *     reported zero relations even where the type name proved the edge.
 * One extractor reading every carrier, with an explicit `kind` on every
 * record, is what keeps those surfaces from drifting apart again.
 *
 * EVIDENCE GATING (non-negotiable)
 * --------------------------------
 * Every emitted relation cites the decorator, attribute, edge, or declared
 * type that PROVES it, and the target must resolve to a known entity name.
 * A field whose NAME looks like a foreign key (`project`, `ownerId`) but whose
 * type is a scalar and which carries no relation decorator yields NOTHING —
 * name-shape is never evidence. See `EntityRelation.evidence`.
 *
 * DATA vs STRUCTURAL
 * ------------------
 * `kind: 'data'` is a relation between two data shapes (an ORM association or
 * a typed composition). `kind: 'structural'` is an interface/trait/superclass
 * composition edge — real, but not part of the data model, and never allowed
 * to stand in for it. Consumers surface the two separately; see
 * `EntityRelationGraph.dataByEntityNameLower` / `structuralByEntityNameLower`.
 */

import type { CASNode, CASEdge, CASDataEntity } from '../../types/cas.types';

export type EntityRelationCardinality = '1:1' | '1:N' | 'N:1' | 'N:M';

/** Where a relation's proof came from, strongest first. */
export type EntityRelationEvidenceSource =
  /** A `references`-shaped edge emitted by an ORM analyzer, carrying `relationType`. */
  | 'orm-edge'
  /** A relation decorator/annotation/attribute on the declaring property. */
  | 'orm-declaration'
  /** The field's declared TYPE is itself an extracted entity. */
  | 'typed-composition'
  /** An interface/trait/superclass edge (structural, never a data relation). */
  | 'structural-edge';

export interface EntityRelation {
  /** Entity name this relation is declared ON. */
  sourceName: string;
  targetName: string;
  /**
   * The relation kind as the ecosystem names it (`ManyToOne`, `has_many`,
   * `ForeignKey`, `composition`, `implements`, …) — kept verbatim so the
   * evidence stays recognisable, with `cardinality` as the normalized form.
   */
  relationType: string;
  kind: 'data' | 'structural';
  cardinality?: EntityRelationCardinality;
  /** Declaring field / relation-method name on the source entity. */
  field?: string;
  /** The inverse side's field on the target, where the declaration names it. */
  inverseField?: string;
  /** True when this side owns the association (declared, not inferred). */
  owning?: boolean;
  joinTable?: string;
  evidenceSource: EntityRelationEvidenceSource;
  /** Human-readable citation of the proving decorator / attribute / type. */
  evidence: string;
}

export interface EntityRelationGraph {
  /** DATA relations (ORM associations + typed composition), by source name. */
  dataByEntityNameLower: Map<string, EntityRelation[]>;
  /** STRUCTURAL relations (implements / trait / extends), by source name. */
  structuralByEntityNameLower: Map<string, EntityRelation[]>;
  /**
   * Relation-declaring field names per entity, so a consumer can mark the FK
   * field as a relation instead of reporting it as a plain scalar column.
   */
  relationFieldsByEntityNameLower: Map<string, Set<string>>;
  counts: { data: number; structural: number; byEvidenceSource: Record<string, number> };
}

/**
 * Relation-kind vocabulary across ecosystems -> normalized cardinality.
 * Keys are compared lowercased. Decorator/attribute ORMs (MikroORM, Doctrine,
 * TypeORM, EF Core, JPA), Python (SQLAlchemy/Django) and Ruby ActiveRecord all
 * name the same four shapes differently; this is the only place that mapping
 * lives.
 */
const RELATION_KIND_CARDINALITY: Record<string, EntityRelationCardinality> = {
  // Decorator / attribute ORMs
  onetoone: '1:1',
  onetomany: '1:N',
  manytoone: 'N:1',
  manytomany: 'N:M',
  one_to_one: '1:1',
  one_to_many: '1:N',
  many_to_one: 'N:1',
  many_to_many: 'N:M',
  // Ruby ActiveRecord
  belongs_to: 'N:1',
  has_one: '1:1',
  has_many: '1:N',
  has_and_belongs_to_many: 'N:M',
  // Laravel Eloquent (method-shaped)
  belongsto: 'N:1',
  hasone: '1:1',
  hasmany: '1:N',
  belongstomany: 'N:M',
  morphone: '1:1',
  morphmany: '1:N',
  morphto: 'N:1',
  morphtomany: 'N:M',
  // Django model fields
  foreignkey: 'N:1',
  onetoonefield: '1:1',
  manytomanyfield: 'N:M',
  // Typed composition (this module's own kind)
  composition: '1:1',
  composes_many: '1:N',
};

/** Decorator/annotation names that DECLARE a relation. Lowercased compare. */
const RELATION_DECLARATION_NAMES = new Set(Object.keys(RELATION_KIND_CARDINALITY).concat([
  // SQLAlchemy declares associations through `relationship(...)`; cardinality
  // comes from `uselist`/the collection type rather than the call name.
  'relationship',
  // EF Core has no relation attribute — a navigation property is the evidence
  // — but `[ForeignKey]`/`[InverseProperty]` DO appear and name the relation.
  'inverseproperty',
]));

/** Structural (non-data) edge types that still describe a real composition. */
const STRUCTURAL_EDGE_TYPES = new Set(['implements', 'uses_trait', 'extends', 'inherits']);

/**
 * Generic wrappers that hold a related shape without changing WHICH shape it
 * is. Split by whether the wrapper is a COLLECTION (relation is 1:N) or a
 * single-value reference (1:1). Covers the container vocabulary of every
 * ecosystem the analyzers cover; unknown wrappers are simply not unwrapped,
 * which fails closed (no relation) rather than inventing one.
 */
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
  /** The innermost named type after unwrapping containers. */
  name?: string;
  /** True when at least one unwrapped layer was a collection. */
  collection: boolean;
}

/**
 * Reduce a declared type to the shape it ultimately names, remembering whether
 * a collection layer was crossed. Handles `Ref<T>`, `Collection<T>`, `T[]`,
 * `List<T>`, `Option<Box<T>>`, `Optional[T]`, `&T`, `[T]`, and unions with
 * null/undefined. Returns no name when the type is not a single named shape —
 * a union of two real types, a primitive, an inline object, a generic
 * parameter — so ambiguity yields no relation.
 */
export function resolveDeclaredTypeShape(rawType: string | undefined): TypeShape {
  let type = String(rawType || '').trim();
  if (!type) return { collection: false };
  let collection = false;

  // Strip Rust references/lifetimes and TS/PHP nullability markers.
  type = type.replace(/^&(?:'\w+\s+)?(?:mut\s+)?/, '').replace(/^\?/, '').trim();

  for (let guard = 0; guard < 8; guard++) {
    const before = type;

    // Drop null/undefined/None union members: `User | null` -> `User`.
    if (type.includes('|')) {
      const parts = type.split('|').map(p => p.trim()).filter(
        p => p && !/^(null|undefined|none|nil|void)$/i.test(p),
      );
      if (parts.length !== 1) return { collection };
      type = parts[0];
    }

    // Array suffix: `Post[]`, `Post[][]`.
    const arraySuffix = /^(.*?)\s*\[\s*\]$/.exec(type);
    if (arraySuffix) {
      collection = true;
      type = arraySuffix[1].trim();
      continue;
    }

    // Rust slice / fixed array: `[T]`, `[T; 16]`.
    const slice = /^\[\s*([^;\]]+?)\s*(?:;[^\]]*)?\]$/.exec(type);
    if (slice) {
      collection = true;
      type = slice[1].trim();
      continue;
    }

    // Generic wrapper: `Ref<T>`, `List<T>`, `Optional[T]`.
    const generic = /^([A-Za-z_][\w.]*)\s*[<[]\s*([\s\S]+?)\s*[>\]]$/.exec(type);
    if (generic) {
      const wrapper = generic[1].split('.').pop()!.toLowerCase();
      const inner = generic[2].trim();
      // Multi-arg generics (`Map<K,V>`, `Collection<Post, number>`): keep only
      // when every extra arg is a scalar-ish key, otherwise bail out. Splitting
      // on top-level commas keeps nested generics intact.
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
      // An unrecognised generic is its own shape (e.g. `Money<USD>`), and a
      // generic whose head we cannot vouch for must not be unwrapped.
      return { name: undefined, collection };
    }

    if (type === before) break;
  }

  // A single bare named type is the only accepted answer.
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

/** Normalize a relation kind token to a cardinality, or undefined if unknown. */
export function cardinalityForRelationType(
  relationType: string | undefined,
  hints: { collection?: boolean } = {},
): EntityRelationCardinality | undefined {
  const key = String(relationType || '').trim().toLowerCase().replace(/[\s-]/g, '');
  const direct = RELATION_KIND_CARDINALITY[key] || RELATION_KIND_CARDINALITY[
    String(relationType || '').trim().toLowerCase()
  ];
  if (direct) return direct;
  // `relationship(...)`-shaped declarations name no cardinality; the declared
  // collection-ness is the only honest signal, and absent that we stay silent.
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

/**
 * Parse a relation declaration out of a decorator/annotation/attribute string.
 * Accepts the textual forms every decorator ORM writes:
 *   `@ManyToOne(() => Project, { nullable: true })`
 *   `@OneToMany(() => Post, post => post.author)`
 *   `@ORM\OneToMany(targetEntity: Post::class, mappedBy: 'author')`
 *   `@ManyToMany(mappedBy="tags")`
 *   `[InverseProperty(nameof(Post.Author))]`
 * Returns undefined when the text names no relation kind.
 */
export function parseRelationDeclaration(raw: string): RelationDeclaration | undefined {
  const text = String(raw || '').trim();
  if (!text) return undefined;
  // The decorator/attribute NAME. Leading sigils differ per ecosystem and none
  // of them carry meaning here: `@ManyToOne(`, `#[ORM\ManyToOne(` (PHP 8
  // attributes), `[ForeignKey(` (.NET), a bare `belongs_to :x` (Ruby). A
  // namespace prefix (`ORM\`, `Doctrine\ORM\`) is stripped with the sigils.
  const sigilless = text.replace(/^[#@[\s]+/, '');
  const nameMatch = /^(?:[\w]+\s*\\\s*)*([A-Za-z_]\w*)/.exec(sigilless);
  const declName = nameMatch?.[1];
  if (!declName || !RELATION_DECLARATION_NAMES.has(declName.toLowerCase())) return undefined;

  const decl: RelationDeclaration = { relationType: declName, evidence: text.slice(0, 220) };

  // `() => Target` / `type => Target` / `(t: T) => Target` (TS decorator ORMs).
  const lambda = /=>\s*([A-Za-z_]\w*)/.exec(text);
  if (lambda) decl.target = lambda[1];

  // `targetEntity: Post::class` / `targetEntity="Post"` / `targetEntity: Post`.
  const targetEntity = /targetEntity\s*[:=]\s*["']?\\?([\w\\]+)["']?/.exec(text);
  if (!decl.target && targetEntity) decl.target = targetEntity[1].split('\\').pop();

  // SQLAlchemy `relationship("Post", back_populates="author")` /
  // Django `ForeignKey('app.Post', ...)` / `ForeignKey(Post, ...)`.
  if (!decl.target) {
    const firstArg = /\(\s*["']?([A-Za-z_][\w.]*)["']?\s*[,)]/.exec(text);
    if (firstArg) decl.target = firstArg[1].split('.').pop();
  }

  // Inverse side: `mappedBy` (owned side names the owner's field) /
  // `inversedBy` (owning side names the inverse) / `back_populates` /
  // `related_name` / a second arrow `post => post.author`.
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
  /**
   * The extracted entity set. Relations may only target a name in here (plus
   * the graph's own entity-node names) — that is the gate that stops a
   * relation being invented for an entity-shaped field name.
   */
  dataEntities?: CASDataEntity[];
}

/**
 * Extract every provable relation for every entity, from all carriers.
 * Pure over its input (no filesystem, no source re-read) so the SAME function
 * serves fresh analysis and query-time reads of an already-stored analysis.
 */
export function extractEntityRelations(input: ExtractEntityRelationsInput): EntityRelationGraph {
  const nodes = input.nodes || [];
  const edges = input.edges || [];
  const dataEntities = input.dataEntities || [];

  const nodesById = new Map<string, CASNode>();
  for (const node of nodes) if (!nodesById.has(node.id)) nodesById.set(node.id, node);

  // Canonical entity names: the extracted entity set plus graph nodes that an
  // analyzer already labelled as an entity/model/struct-shaped data node.
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
    // ONE data relation per (entity, field): a field declares at most one
    // association, so a weaker carrier reading the same field differently (a
    // typed-composition `1:1` over a decorator's `N:1`) must not double it.
    // Sources are processed strongest-first, so the first reading wins.
    if (relation.kind === 'data' && relation.field) {
      if (relationFieldsByEntityNameLower.get(relation.sourceName.toLowerCase())?.has(relation.field)) return;
    }
    // Dedupe on (source|cardinality-or-type|target|field) so the same relation
    // proved by two carriers (an edge AND its decorator) lands once, with the
    // FIRST (strongest, since sources are processed strongest-first) evidence.
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

  // ---- Source 1: ORM analyzer edges carrying `relationType` ----------------
  // Strongest evidence: an analyzer already parsed the schema/decorator and
  // emitted the directed association.
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

  // ---- Source 2: relation declarations on the declaring property ----------
  // Decorator/attribute ORMs whose analyzer records the declaration on the
  // property node (`metadata.annotations`, `metadata.attributes.decorators`,
  // or the pre-parsed `{relation_type, target_entity}` pair).
  const ownerNameForProperty = buildPropertyOwnerIndex(nodes, canonicalByLower);
  for (const node of nodes) {
    if (node.type !== 'property' && node.type !== 'field' && node.type !== 'attribute') continue;
    const owner = ownerNameForProperty.get(node.id);
    if (!owner) continue;
    const attributes = (node.metadata as any)?.attributes || {};

    // Pre-parsed pair (attribute-shape ORM analyzers).
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

    // Textual decorators/annotations.
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

  // ---- Source 3: typed composition ---------------------------------------
  // A field whose declared TYPE *is* another extracted entity. The type name
  // is the proof; a scalar/unknown type, or a type that names nothing in the
  // entity set, yields nothing. Runs over the extracted entity field lists so
  // it works identically on a fresh analysis and a stored one.
  for (const entity of dataEntities) {
    const sourceName = canonicalByLower.get(entity.name.toLowerCase()) || entity.name;
    for (const field of entity.fields || []) {
      // `alreadyRelational` is re-read per field, not captured once, because a
      // relation recorded earlier in THIS loop must also block a later reading.
      if (relationFieldsByEntityNameLower.get(sourceName.toLowerCase())?.has(field.name)) continue;
      const shape = resolveDeclaredTypeShape(field.type);
      if (!shape.name) continue;
      const targetName = canonicalByLower.get(shape.name.toLowerCase());
      if (!targetName) continue;
      // A shape composing ITSELF by value is not a relation worth reporting
      // (recursive self-reference is reported, self-typed alias noise is not).
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

/**
 * Map every property/field node to the NAME of the entity that declares it.
 * Prefers the explicit `parent` link; falls back to same-file containment
 * (the language analyzers do not always set `parent` on a property, and the
 * file an entity is declared in is the reliable second key — a `*.entity.*`
 * file holds one entity).
 */
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
    // Only an UNAMBIGUOUS single entity per file may claim an unparented
    // property — two entities in one file makes ownership a guess, and a guess
    // is not evidence.
    if (candidates?.length === 1) {
      const owner = candidates[0];
      ownerByPropertyId.set(node.id, canonicalByLower.get(owner.name.toLowerCase()) || owner.name);
    }
  }

  return ownerByPropertyId;
}
