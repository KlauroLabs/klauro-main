import type { CASDataEntity, CASEntryPoint, CASNode, CASTerminalityMember, SystemCapability } from '../../types/cas.types';
import { behaviorSurfaceEntryCount } from './capability-catalog-evidence';
import { catalogCandidateEntityFacts } from './capability-catalog-metrics';
import { capabilityCatalogStructuralApiLabels, projectCapabilityCatalogPromptEvidence } from './capability-catalog-prompt-evidence';

export const capabilityCatalogDescriptionContract = "Each description is one sentence of 6-28 words and at least 30 characters. Begin with its concrete audience-facing subject and add evidence-specific behavior beyond the name. Do not start with actor scaffolding (such as \"Lets users\"). Avoid tautology, generic \"by processing\" explanations, or action inventories. Describe the durable outcome; include destructive or reversal actions only when they define it. Use product nouns from cited behavior or first-party text; do not replace them with generic \"data\" or \"information\" and never repeat a type, class, interface, schema, or graph-model identifier. Delivery mechanisms are not outcomes unless the product scope makes them the audience offering. Do not invent value claims. Every value, safety, timing, runtime, or operating claim needs explicit scoped evidence, including claims about locking, exclusivity, security, instant effects, or permanence. Never infer absence, bypass, or unchanged behavior from silence. Do not use \"capability\" or \"lifecycle\" as prose scaffolding.";
export const capabilityCatalogNarrativeContract = "system_description must be exactly four concise grammatical sentences for the intended audience: what the system is; what that audience can accomplish; one observed action and result; another evidenced behavior or operating property. Ground every noun and claim. No unsupported marketing, private identifiers, source-file or implementation inventory. Technical vocabulary is valid when first-party evidence establishes it as the offered product. domain must be a lowercase kebab-case label of 2 to 4 evidence-backed product nouns.";
export const capabilityCatalogApplicationTask = "Catalog the audience outcomes of this software. Return ONLY valid JSON: {\"system_description\":\"...\",\"domain\":\"...\",\"capabilities\":[{\"requirement_id\":\"...\",\"name\":\"...\",\"description\":\"...\",\"category\":\"core|supporting\",\"candidate_ids\":[\"...\"],\"entry_point_ids\":[\"...\"]}]}. PURPOSE TEST: A capability is what someone gets from the system, not a tool, route, class, entity label, or CRUD inventory. Names must be concrete verb-headed outcomes recognizable to the intended audience. Do not lead with Handle or Process; use Manage only when management itself is the product purpose. SCOPE-RELATIVE TEST: Assess scope from first-party purpose, audience, system boundary, dependency direction, terminality, journeys, entities, operations, contracts, and contradictory evidence. Never decide from a domain-word blacklist. A prerequisite with later product behavior is normally supporting; the same behavior can be core when it is terminal and what that audience came to obtain. INTENT RECONCILIATION: Test each required_outcome independently against cited bottom-up behavior. Emit its requirement_id only when grounded; otherwise leave an intent gap. Independently discovered outcomes are valid when implementation evidence supports them. Product text may propose, rank, or name outcomes, but cannot prove implementation or justify unrelated citations. Merge candidates only for the same outcome; preserve distinct audience surfaces and terminal outcomes despite shared entities or vocabulary. A cross-family outcome needs a subject covering its cited scope. Never return two capabilities whose descriptions assert the same result. Core means the product value proposition, not a frequently used mechanism. Every subject noun must be supported by cited behavior, supplied journeys, or first-party text; never invent product nouns or publish source identifiers. Structural families are evidence, never mandatory capability slots. Return only supported distinct outcomes, most central first; an empty list is valid when none is grounded.";
export const capabilityCatalogContextContract = "Required outcomes are authored proposals, not implementation claims. Evidence roles and terminality rank hypotheses; neither establishes semantic truth. Relationships connect observed subjects, not unstated results. Entity fields may establish concrete behavior in combination; translate their meaning into audience language instead of copying identifiers. Coordinate is valid only when cited behavior or first-party text establishes collaboration as the outcome.";
export const capabilityCatalogStyleContract = "Plain audience-appropriate language, no markdown, marketing, CRUD lists, route counts, or generic value claims. Prefer precise observed behavior over a mechanism inventory. Never expand an operation abbreviation unless first-party text defines it. Begin each description with its concrete product subject.";

export const capabilityCatalogEvidenceContract = 'Copy requirement_id only from required_outcomes[].requirement_id when proposing that documented outcome; omit it for an independently discovered outcome. Copy candidate_ids only from candidate_route_areas[].candidate_id. These are distinct namespaces: a candidate ID is never a requirement ID. observed_operations rows have the fixed columns [entry_point_id, entry_point_type, name, action, surface]; null means unavailable. For each capability, return entry_point_ids copied from the first column of rows belonging to its cited candidates. Select only the operations that substantiate the complete outcome; citing a candidate does not cite all its operations. An entry-point ID from another candidate or an invented ID is invalid. Preserve qualifications such as without or before when judging the full outcome; shared words alone do not establish support. Operation names identify observed entry points, not proof of the outcome their names suggest. Use behavior, contracts, relationships and qualifications to ground claims; do not invent behavior for unresolved_entry_point_ids. evidence_window gives original zero-based positions and total item counts for partial collections: offset denotes a contiguous slice; indices explicitly lists positions when citation joins require a noncontiguous slice. Contracts stay with the operations they qualify, including all contracts attached to one operation. These are evidence subsets of the same candidate, not separate complete capabilities. Do not infer absence from an item missing in a window, or claim behavior outside the supplied evidence. Relationships and contracts retain their own scope; sharing a candidate does not make every contract govern every operation.';

export function projectCapabilityCatalogPromptFacts(
  candidates: readonly SystemCapability[],
  nodeById: ReadonlyMap<string, CASNode>,
  entryById: ReadonlyMap<string, CASEntryPoint>,
  entityById: Map<string, CASDataEntity>,
  terminalityById: ReadonlyMap<string, CASTerminalityMember>,
): Array<Record<string, unknown>> {
  const structuralApiLabels = new Set(capabilityCatalogStructuralApiLabels(candidates));
  return candidates.map(capability => {
    const evidence = projectCapabilityCatalogPromptEvidence(capability, nodeById, entryById);
    const entities = catalogCandidateEntityFacts(capability, entityById);
    const terminality = terminalityById.get(capability.id);
    return {
      candidate_id: capability.id,
      family: structuralApiLabels.has(capability.name) ? undefined : capability.name,
      structural_group_label: capability.structural_label,
      operations: evidence.operations,
      observed_operations: capability.operations.map(operation => [
        operation.entry_point_id, operation.entry_point_type,
        entryById.get(operation.entry_point_id)?.name ?? null,
        operation.action ?? null, operation.path_or_command ?? null,
      ]),
      relationships: evidence.relationships,
      declared_contracts: evidence.declared_contracts,
      unresolved_entry_point_ids: evidence.unresolved_entry_point_ids,
      name: evidence.name,
      entry_points: behaviorSurfaceEntryCount(capability),
      entities: entities.length,
      entity_names: entities.map(entity => entity.name),
      entity_fields: entities,
      terminality: terminality?.terminal ? 'terminal' : terminality?.proximal_terminal ? 'proximal-terminal' : 'upstream',
      distance_to_terminal: terminality?.distance_to_terminal,
      evidence_role: capability.evidence_role,
      evidence_role_reasons: capability.evidence_role_reasons,
    };
  });
}
