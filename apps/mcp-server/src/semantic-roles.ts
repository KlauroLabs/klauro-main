/**
 * Semantic role classification — the single source of truth for the
 * core / supporting / infrastructure vocabulary.
 *
 * This module holds the name-driven primitives that the workspace-level
 * capability/item classifier (`semanticRoleForWorkspaceItem` in
 * cross-codebase-analysis.ts) already relied on, so that the same evidence
 * and logic can be reused per-ENTITY and per-FLOW without forking a parallel
 * classifier. cross-codebase-analysis.ts imports these primitives; it does
 * NOT keep its own copy.
 *
 * Vocabulary (shared across capabilities, entities, and flows):
 *   - core           — business/domain: the nouns the product exists for, the
 *                      domain capability flows.
 *   - supporting     — enabling but not the point: auth, notifications, config,
 *                      users/sessions, audit.
 *   - infrastructure — plumbing: logging, telemetry, framework glue, DB access,
 *                      health, serialization, migrations.
 *
 * Every classifier is evidence-gated and conservative: when the honest label
 * is unclear it returns the weaker role (or `undefined` for "unknown"), and it
 * carries the evidence that drove the decision. Nothing is fabricated.
 */

import type { CASDomainConcept, CASDataEntity, CASNode, CASEdge } from '../../../packages/analyzer-core/src/types/cas.types';

export type SemanticRole = 'core' | 'supporting' | 'infrastructure';

/** A classification plus the evidence that produced it. `role` is omitted
 *  (undefined) when there is no honest signal at all — callers surface that as
 *  "unknown" rather than guessing. */
export interface RoleClassification {
  role?: SemanticRole;
  role_evidence: string[];
}

/** Rank used to pick the "stronger"/"more core" role when several signals
 *  disagree, and to compare against a threshold. */
const ROLE_RANK: Record<SemanticRole, number> = { core: 3, supporting: 2, infrastructure: 1 };

export function normalizeRoleName(value: unknown): string {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function countUniqueMatches(text: string, patterns: RegExp[]): number {
  return patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
}

/** Names that are unambiguously plumbing. Kept byte-for-byte identical to the
 *  workspace item classifier's original regex so importing it here does not
 *  shift any workspace-level classification (single source of truth, no fork). */
export function isInfrastructureSemanticName(normalized: string): boolean {
  return /\b(database|postgres|mysql|redis|cache|queue|broker infrastructure|cloud|infrastructure|terraform|pulumi|kubernetes|docker|compose|deployment|provisioning|monitoring|observability|logging|ci|cd|build|pipeline|container|backend provisioning)\b/.test(normalized);
}

/** Extra plumbing vocabulary that is honest infrastructure for a data ENTITY or
 *  FLOW (migration/log/telemetry/health/serialization tables and endpoints) but
 *  that the workspace CAPABILITY classifier deliberately does not fold into its
 *  name gate. Applied only in the entity/flow classifiers below, so the
 *  workspace path is byte-for-byte unchanged. */
export function isEntityFlowInfrastructureName(normalized: string): boolean {
  return isInfrastructureSemanticName(normalized) ||
    /\b(migration|migrations|schema migration|serialization|serializer|health|healthcheck|heartbeat|telemetry|metric|metrics|tracing|span|changelog|schema version|flyway|liquibase|knex migration)\b/.test(normalized);
}

/** A runtime endpoint literal ("host:port", "https://host:port") — plumbing. */
export function isRuntimeEndpointSemanticName(name: unknown): boolean {
  const raw = String(name || '');
  const compact = raw.trim();
  const normalizedText = normalizeRoleName(raw);
  return /^[a-z0-9 ._-]+:\d+(?:\b|$)/i.test(compact) ||
    /\bhttps?:\/\/[a-z0-9._-]+:\d+/i.test(compact) ||
    /^[a-z0-9 ._-]+\s+\d{2,5}$/.test(normalizedText);
}

/** Names that enable the product but are not the point of it. Byte-for-byte
 *  identical to the workspace item classifier's original supporting regex. */
export function isSupportingSemanticName(normalized: string): boolean {
  return /\b(license|licensing|notification|notifications|terms|conditions|impersonation|revocation|audit|activity log|password reset|email|mailer|usage|settings|configuration|logo|avatar|theme|session|token|apikey|api key|identity|authentication|forgot password|reset password|profile|preference|preferences|document|documents|cancellation|feedback|credential|credentials|platform)\b/.test(normalized) ||
    /\b(passwordreset|cancellationfeedback|userapikey|apikey|credential|credentials)\b/.test(normalized);
}

/** Product/domain vocabulary — a positive signal that a noun is core. The first
 *  block mirrors the workspace `workspaceProductCapabilitySignal` exactly; the
 *  second block adds common business nouns (client/customer/order/invoice/…)
 *  that the entity/flow classifiers benefit from. Additive only. */
export function productDomainSignal(name: string): number {
  const text = normalizeRoleName(name);
  return countUniqueMatches(text, [
    /\bfinance\b/, /\bfinancial\b/, /\binvest(?:ment|ing)?\b/, /\basset\b/,
    /\bportfolio\b/, /\btransaction\b/, /\bpayment\b/, /\bbilling\b/,
    /\binvoice\b/, /\bsettlement\b/, /\bliquidation\b/, /\bpurchase\b/,
    /\bspending\b/, /\bexchange\b/, /\border\b/, /\btrad(?:e|ing)\b/,
    /\bcrypto\b/, /\bblockchain\b/, /\bweb3\b/, /\bdigital asset/,
    /\bon-?chain\b/, /\bdefi\b/, /\bwallet\b/, /\bcustod(?:y|ian|ial)\b/,
    /\bswap\b/, /\bstak(?:e|ing)\b/, /\bmint(?:ing)?\b/, /\bdeposit\b/,
    // entity/flow-oriented business nouns (additive to the workspace set):
    /\bclient\b/, /\bcustomer\b/, /\bproduct\b/, /\bshipment\b/,
    /\bvehicle\b/, /\bdriver\b/, /\bbooking\b/, /\breservation\b/,
    /\bcontract\b/, /\bclaim\b/, /\bappointment\b/,
    /\bcatalog\b/, /\binventory\b/, /\bcart\b/, /\bcheckout\b/,
  ]);
}

/** Fold two role judgements into the stronger (more-core) of the two. */
export function strongerRole(left?: SemanticRole, right?: SemanticRole): SemanticRole | undefined {
  if (!left) return right;
  if (!right) return left;
  return ROLE_RANK[right] > ROLE_RANK[left] ? right : left;
}

/**
 * The name-only classifier — the same shape of decision
 * `semanticRoleForWorkspaceItem` makes, minus the workspace score machinery
 * (there is no per-entity/per-flow terminal score, so name + a caller-supplied
 * corroborating signal do the work). Conservative: an ambiguous name with no
 * product signal is supporting, never core.
 */
export function roleFromName(
  name: unknown,
  opts: { productSignal?: boolean } = {}
): { role: SemanticRole; evidence: string } {
  const raw = String(name || '');
  const normalized = normalizeRoleName(raw);
  // Entity/flow contexts use the broadened infra gate (migration/log/telemetry
  // /health/serialization). This never runs on the workspace path.
  if (isEntityFlowInfrastructureName(normalized)) return { role: 'infrastructure', evidence: 'name matches infrastructure vocabulary (plumbing)' };
  if (isRuntimeEndpointSemanticName(raw)) return { role: 'infrastructure', evidence: 'name is a runtime endpoint literal (host:port)' };
  if (isSupportingSemanticName(normalized)) return { role: 'supporting', evidence: 'name matches supporting vocabulary (auth/config/notifications/audit)' };
  if (opts.productSignal || productDomainSignal(raw) > 0) return { role: 'core', evidence: 'name carries product/domain vocabulary' };
  return { role: 'supporting', evidence: 'no domain or infrastructure signal in name (conservative default)' };
}

/**
 * Index domain concepts by the entity names and entry-point ids they appear
 * in, so an entity or flow can look up which already-classified domain
 * concept(s) reference it. `domain_concepts[].classification` is the
 * core/supporting/infrastructure signal computed by the domain-extractor from
 * real structural evidence (entry-point + entity anchoring, node dominance) —
 * exactly the terminal/domain signal to reuse here rather than re-derive.
 */
export interface DomainConceptIndex {
  /** Keyed by an ENTITY KEY that matches whichever reference form the domain
   *  extractor emitted for `appears_in.entities`. In practice that array holds
   *  entity NODE IDs (e.g. "entity_billing"), not display names, so we index
   *  each concept reference under its raw value AND a stripped/normalized form
   *  ("billing"), and `entityKeys(entity)` produces the same candidate set for
   *  a data entity so id-based and name-based references both join. */
  byEntityKey: Map<string, CASDomainConcept[]>;
  byEntryPoint: Map<string, CASDomainConcept[]>;
  byNode: Map<string, CASDomainConcept[]>;
  size: number;
}

/** Strip a leading "entity_" / "entity " prefix and normalize, so an entity
 *  node id ("entity_billing") and a display name ("Billing") collapse to the
 *  same key ("billing"). */
function stripEntityRef(value: unknown): string {
  return normalizeRoleName(String(value || '').replace(/^entity[_\s]+/i, ''));
}

/** The candidate join keys for a data entity — its id, its stripped id, and its
 *  normalized name — so a concept reference in any of those forms matches. */
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
      // Index under the raw reference and its stripped/normalized form so the
      // entity can look up by id OR by name.
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

/** Look up the concepts referencing an entity across all its candidate keys. */
function conceptsForEntity(entity: { id?: string; name?: string }, index: DomainConceptIndex): CASDomainConcept[] {
  const seen = new Set<CASDomainConcept>();
  for (const key of entityKeys(entity)) {
    for (const c of index.byEntityKey.get(key) || []) seen.add(c);
  }
  return [...seen];
}

/** Pick the strongest classification among a set of concepts, with evidence. */
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

/** A single ORM relation, resolved to real node names, keyed by the
 *  RELATION SOURCE entity's own name (lowercased) — the join key
 *  `classifyEntityRole` uses to look up "what does this entity relate to". */
export interface EntityRelationEvidence {
  targetName: string;
  relationType: string;
  field?: string;
}

export interface EntityRelationIndex {
  byEntityNameLower: Map<string, EntityRelationEvidence[]>;
}

/**
 * Build an entity-name-keyed relation index from the CAS node/edge graph.
 * ORM analyzers (Doctrine, TypeORM, Prisma, MikroORM, Eloquent, …) all emit
 * cross-entity relations as `references` edges carrying
 * `metadata.attributes.relationType` — the same convention the
 * database_schema ERD summary already reads (see buildDatabaseSchema's
 * "Edge-based relations" pass in orchestrator.ts). Keyed by NAME rather than
 * node id because a `CASDataEntity` (data_entities[]) and its originating
 * graph NODE (nodes[], the edge endpoint) carry different id schemes — the
 * entity name is the only reliable join key between the two.
 */
export function buildEntityRelationIndex(cas: { nodes?: CASNode[]; edges?: CASEdge[] }): EntityRelationIndex {
  const byEntityNameLower = new Map<string, EntityRelationEvidence[]>();
  const nodesById = new Map<string, CASNode>();
  for (const node of cas.nodes || []) {
    if (!nodesById.has(node.id)) nodesById.set(node.id, node);
  }
  for (const edge of cas.edges || []) {
    const relationType = (edge.metadata as any)?.attributes?.relationType as string | undefined;
    if (!relationType) continue;
    const source = nodesById.get(edge.source);
    const target = nodesById.get(edge.target);
    if (!source?.name || !target?.name) continue;
    const key = source.name.toLowerCase();
    const list = byEntityNameLower.get(key);
    const evidence: EntityRelationEvidence = {
      targetName: target.name,
      relationType,
      field: (edge.metadata as any)?.attributes?.field,
    };
    if (list) list.push(evidence);
    else byEntityNameLower.set(key, [evidence]);
  }
  return { byEntityNameLower };
}

/** Field-name vocabulary that corroborates a relation TARGET being an
 *  external-integration/connection hub (credential/provider-shaped storage)
 *  rather than a domain record — e.g. Doctrine's `Connection` entity storing
 *  `auth`/`type`/`enabled` for a third-party sync provider. */
function hasIntegrationCredentialFieldShape(fields: CASDataEntity['fields'] | undefined): boolean {
  const vocab = new Set(['auth', 'credential', 'credentials', 'token', 'apikey', 'api', 'key', 'secret', 'oauth', 'webhook', 'access', 'refresh']);
  return (fields || []).some(field => {
    const words = String(field.name || '')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    // Require at least two matching tokens (e.g. "api"+"key", "access"+"token")
    // OR one unambiguous single-word hit (auth/credential/secret/oauth/webhook)
    // so a lone "key" (a primary-key field) never trips this alone.
    const unambiguous = new Set(['auth', 'credential', 'credentials', 'oauth', 'webhook']);
    if (words.some(word => unambiguous.has(word))) return true;
    return words.filter(word => vocab.has(word)).length >= 2;
  });
}

/** Name-based signal that a relation TARGET (not the entity being
 *  classified) is a connection/integration hub. This is evidence about a
 *  DIFFERENT entity than the one under classification — not the name-pattern
 *  the caller is asked to avoid on the classified entity itself — and is
 *  only ever combined with the structural relation-pairing test below, never
 *  used alone. */
function isConnectionIntegrationTargetName(name: string): boolean {
  return /\b(connection|integration|oauth|webhook)\b/i.test(name);
}

/**
 * Evidence-first integration-sync JOIN RECORD detection. An entity whose ORM
 * relations pair it to BOTH (a) another entity present in this codebase's own
 * domain-entity set and (b) a connection/integration hub entity (by name
 * and/or credential-field shape) is a sync/bind record joining the two — not
 * a core domain entity in its own right, regardless of what its own name
 * looks like (a name ending in "ConnectionBind" is corroboration only, never
 * required and never sufficient alone). Real example: truckspy's
 * `DeviceConnectionBind` ManyToOne-relates to both `Device` (a real domain
 * entity) and `Connection` (a `type`/`auth`/`enabled`-shaped integration
 * hub) — the SAME structural shape repeats across 14 `*ConnectionBind`
 * entities, each pairing a different domain entity with `Connection`.
 */
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

/**
 * Classify a data ENTITY. Evidence, strongest-first:
 *   0. STRUCTURAL relation-pairing evidence: an entity whose ORM relations
 *      pair a domain entity with a connection/integration hub is an
 *      integration-sync join record (demoted to infrastructure) — this
 *      outranks the domain-concept/name signals below, the same way flow
 *      classification's structural terminus evidence outranks its name
 *      fallback, because the relation SHAPE is stronger evidence than a
 *      name-derived concept guess.
 *   1. domain-concept classification (reused terminal/domain signal), if a
 *      concept references this entity by name;
 *   2. lifecycle shape — a single owning writer (created/updated by one node)
 *      is a core-entity signal; a write-nowhere read-only table leans infra;
 *   3. the name-based classifier (shared with the workspace item classifier).
 * The domain-concept signal, when present, is authoritative; name/lifecycle
 * corroborate or fill in when no concept references the entity.
 */
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

  const nameRole = roleFromName(entity.name);

  // Domain concept is the authoritative signal when present.
  if (conceptHit.role) {
    evidence.push(conceptHit.evidence!);
    // Corroborate with name only when it strengthens; never let a bare name
    // override a concept-derived infrastructure/supporting judgement upward
    // unless the name itself carries genuine product vocabulary.
    if (nameRole.role === 'core' && productDomainSignal(entity.name) > 0 && conceptHit.role !== 'core') {
      evidence.push(nameRole.evidence);
      return { role: strongerRole(conceptHit.role, 'core'), role_evidence: evidence };
    }
    if (singleOwnerWrite && conceptHit.role === 'core') {
      evidence.push(`single-owner writes (${writers} writer node(s)) — core-entity lifecycle`);
    }
    return { role: conceptHit.role, role_evidence: evidence };
  }

  // No concept references this entity — fall back to name, corroborated by
  // lifecycle. A clearly-infra name stays infra regardless of lifecycle.
  evidence.push(nameRole.evidence);
  if (nameRole.role === 'infrastructure') {
    return { role: 'infrastructure', role_evidence: evidence };
  }
  if (nameRole.role === 'core') {
    if (singleOwnerWrite) evidence.push(`single-owner writes (${writers} writer node(s)) corroborate core`);
    return { role: 'core', role_evidence: evidence };
  }
  // Supporting-by-name: a read-only / write-nowhere table with heavy reads and
  // no product vocabulary is closer to infrastructure plumbing (e.g. a
  // log/lookup/reference table); keep it supporting otherwise.
  if (writers === 0 && read > 0) {
    evidence.push('never written in-app (read-only) — plumbing/reference table');
    return { role: 'infrastructure', role_evidence: evidence };
  }
  return { role: 'supporting', role_evidence: evidence };
}

/** Structural (terminal/product) evidence for a flow's role, resolved by the
 *  query layer from the CAS entry point + the flow's terminus. This is TYPE
 *  evidence (entry-point handler file kind, exit-point kind, capability
 *  membership), never a name blocklist. */
export interface FlowRoleStructuralEvidence {
  /** Entry point type ('http' | 'cli' | 'event' | ...). */
  entry_type?: string;
  /** Entry point handler/source file, when resolvable. */
  entry_file?: string;
  /** The flow's resolved terminus exit kind ('api' | 'database' | 'sdk' | ...). */
  terminus_kind?: string;
  /** What the terminus produces (service id / resource / route). */
  terminus_produces?: string;
  /** True when a system_capabilities operation references this flow's entry point. */
  capability_linked?: boolean;
}

/** Shell/batch/build-script file — a script ENTRY is structural evidence that
 *  the flow is operational plumbing (deploy/install/release/build), regardless
 *  of what domain vocabulary its name happens to contain. */
function isScriptEntryFile(file: string | undefined): boolean {
  return /\.(sh|bash|zsh|ps1|bat|cmd)$|(^|\/)(makefile|justfile)$/i.test(String(file || ''));
}

/** Product-facing terminus kinds — the flow ends by emitting a response,
 *  persisting state, or raising a product event (vs. a build/deploy artifact). */
const PRODUCT_TERMINUS_KINDS = new Set(['api', 'database', 'cache', 'event', 'webhook', 'message', 'queue', 'navigation']);

/**
 * Classify a FLOW. Evidence, strongest-first:
 *   0. STRUCTURAL terminal/product evidence, when supplied: a flow rooted at a
 *      build/deploy/install script entry is infrastructure (script entry IS
 *      the evidence — no name blocklist); a flow serving a capability
 *      operation with an api-response/persisted terminus is core. This
 *      outranks domain-concept anchors: a shell domain concept classified
 *      "core" must not make deploy.sh a core product flow, and a capability
 *      operation that responds/persists is core product surface even when its
 *      name carries no domain vocabulary.
 *   1. domain-concept classification for the flow's entry point (reused signal);
 *   2. domain-concept classification for any data entity the flow touches;
 *   3. the name-based classifier applied to the flow name / intent.
 */
export function classifyFlowRole(
  flow: { name?: string; intent?: string; entry_point?: string; entities?: string[] },
  index: DomainConceptIndex,
  structural?: FlowRoleStructuralEvidence
): RoleClassification {
  const evidence: string[] = [];

  // 0. Structural terminal/product evidence (entry TYPE + terminus), when the
  // caller resolved it. Evidence-gated: each branch names the concrete fact.
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

  // 1. Entry-point-anchored concept.
  const epHit = flow.entry_point ? roleFromConcepts(index.byEntryPoint.get(flow.entry_point)) : {};
  if (epHit.role) {
    evidence.push(epHit.evidence!);
  }

  // 2. Concept via any touched entity.
  let entityRole: SemanticRole | undefined;
  let entityEvidence: string | undefined;
  for (const ent of flow.entities || []) {
    const hit = roleFromConcepts(conceptsForEntity({ name: ent, id: ent }, index));
    const stronger = strongerRole(entityRole, hit.role);
    if (stronger !== entityRole) { entityRole = stronger; entityEvidence = hit.evidence ? `${hit.evidence} (touched entity "${ent}")` : undefined; }
  }

  // 3. Name-based, using product vocab from the flow name AND its touched
  // entities (a flow named "Handle POST /clients" is core because Client is).
  const combinedName = [flow.name, flow.intent, ...(flow.entities || [])].filter(Boolean).join(' ');
  const nameRole = roleFromName(flow.name || flow.intent || '', { productSignal: productDomainSignal(combinedName) > 0 });

  const conceptRole = strongerRole(epHit.role, entityRole);
  if (conceptRole) {
    if (entityRole && (!epHit.role || strongerRole(epHit.role, entityRole) === entityRole) && entityEvidence) {
      evidence.push(entityEvidence);
    }
    // A concept-core flow can still be pulled down by an unambiguous infra name
    // (e.g. a health/metrics endpoint that merely mentions a domain entity).
    if (isEntityFlowInfrastructureName(normalizeRoleName(flow.name || '')) || isRuntimeEndpointSemanticName(flow.name || '')) {
      evidence.push(nameRole.evidence);
      return { role: 'infrastructure', role_evidence: evidence };
    }
    return { role: conceptRole, role_evidence: evidence };
  }

  // No concept anchor — name only.
  evidence.push(nameRole.evidence);
  return { role: nameRole.role, role_evidence: evidence };
}
