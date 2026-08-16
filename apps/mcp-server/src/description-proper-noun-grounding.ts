import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';

const NON_CLAIM_TITLE_CASE_TERM = /^(A|An|The|This|It|Its|When|Key|Data|Entry|REST|API|UI|SQL|AWS|GPO)$/;

export function unexplainedShortTitleCaseTerms(
  text: string,
  isGrounded: (term: string) => boolean,
): string[] {
  return Array.from(new Set(
    [...String(text || '').matchAll(/\b[A-Z][a-z]{1,3}\b/g)]
      .map(match => match[0])
      .filter(term => !NON_CLAIM_TITLE_CASE_TERM.test(term))
      .filter(term => !isGrounded(term)),
  ));
}

export function descriptionTermIsGroundedInCas(cas: CASOutput, term: string): boolean {
  const normalized = String(term || '').trim().toLowerCase();
  if (!normalized) return false;
  if (normalized === 'command-line interface') {
    return (cas.entry_points || []).some((entry: any) => entry.type === 'cli');
  }
  const technologies = cas.system?.technologies || {};
  const haystack = JSON.stringify({
    system: cas.system?.name,
    firstPartyProductEvidence: cas.enhanced_system_purpose?.first_party_product_evidence,
    domain: cas.enhanced_system_purpose?.primary_domain,
    concepts: cas.enhanced_system_purpose?.core_concepts,
    domainConcepts: (cas.domain_concepts || []).map((concept: any) => concept.name),
    capabilities: (cas.capabilities || []).map((capability: any) => capability.name),
    entities: [
      ...((cas.database_schema?.entities || []).map((entity: any) => entity?.name || '')),
      ...((cas.entities || []).map((entity: any) => entity.name)),
    ],
    entries: (cas.entry_points || []).map((entry: any) => `${entry.name} ${entry.type}`),
    integrations: (cas.external_services || []).map((service: any) => `${service?.name || ''} ${service?.service || ''} ${service?.type || ''}`),
    languages: (technologies.languages || []).map((language: any) => `${language?.name || language}`),
    frameworks: [
      ...((technologies.frameworks || []).map((framework: any) => `${framework?.name || framework}`)),
      ...(((cas as any).frameworks || []).map((framework: any) => `${framework?.name || framework}`)),
    ],
    packages: [
      ...((cas.libraries || []).map((library: any) => library?.name || '')),
      ...((cas.dependencies?.packages || []).map((pkg: any) => pkg?.name || '')),
      ...(Array.isArray(cas.dependencies) ? cas.dependencies.map((dependency: any) => `${dependency?.name || dependency}`) : []),
    ],
    nodes: (cas.nodes || []).slice(0, 200).map((node: any) => `${node.name} ${node.type} ${node.source?.file || ''}`),
  }).toLowerCase();
  return haystack.includes(normalized);
}
