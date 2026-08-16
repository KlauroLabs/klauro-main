












































import { CAPABILITY_PURPOSE_VERBS } from './capability-naming';
import type { CASDataEntity, CASLibrary } from '../../types/cas.types';

type AudienceEntity = Pick<CASDataEntity, 'name' | 'kind'> & {
  lifecycle?: CASDataEntity['lifecycle'];
};




export function splitIdentifierWords(identifier: string): string[] {
  const spaced = String(identifier || '')

    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')

    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')

    .replace(/[_\-./]+/g, ' ');
  return spaced.split(/\s+/).map(w => w.trim()).filter(Boolean);
}





function normalizeToken(token: string): string {
  const lower = token.toLowerCase();
  return lower.endsWith('s') && lower.length > 3 ? lower.slice(0, -1) : lower;
}

function buildProductVocabulary(productTerms: string[]): Set<string> {
  const vocabulary = new Set<string>();
  for (const term of productTerms) {
    const words = splitIdentifierWords(term).map(normalizeToken);
    for (const word of words) vocabulary.add(word);
    if (words.length > 1 && words.length <= 4) vocabulary.add(words.join(''));
  }
  return vocabulary;
}








export function capabilitySubjectTokens(name: string): string[] {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const first = words[0].toLowerCase();





  const candidateStems = [
    first,
    first.replace(/ing$/, ''),
    first.replace(/ed$/, ''),
    first.replace(/ies$/, 'y'),
    first.replace(/es$/, 'e'),
    first.replace(/s$/, ''),
  ];
  const isLeadingVerb = candidateStems.some(stem => CAPABILITY_PURPOSE_VERBS.has(stem));
  const rest = isLeadingVerb ? words.slice(1) : words;





  const connectors = new Set([
    'the', 'a', 'an', 'and', 'or', 'for', 'from', 'with', 'through', 'across',
    'into', 'over', 'under', 'between', 'among', 'via', 'using', 'to', 'of',
    'on', 'in', 'by', 'as', 'their', 'its',
  ]);
  return rest.filter(word => {
    const normalized = word.replace(/[^a-zA-Z]/g, '').toLowerCase();
    return normalized.length >= 3 && !connectors.has(normalized);
  });
}

export interface IdentifierVocabulary {


  words: Set<string>;





  flatNames: string[];
}




export function buildIdentifierVocabulary(libraries: Pick<CASLibrary, 'name'>[]): IdentifierVocabulary {
  const words = new Set<string>();
  const flatNames: string[] = [];
  for (const lib of libraries || []) {
    if (!lib?.name) continue;
    const flat = lib.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (flat) flatNames.push(flat);
    for (const word of splitIdentifierWords(lib.name)) words.add(normalizeToken(word));
  }
  return { words, flatNames };
}






function tokenAppearsAsIdentifier(token: string, vocab: IdentifierVocabulary): boolean {
  if (vocab.words.has(token)) return true;
  if (token.length < 4) return false;
  return vocab.flatNames.some(flat => flat.includes(token) || (flat.length >= 4 && token.includes(flat)));
}





export function buildDomainEntityVocabulary(entities: AudienceEntity[]): Set<string> {
  const vocab = new Set<string>();
  for (const entity of entities || []) {
    if (!entity?.name) continue;
    const observedLifecycle = entity.lifecycle && Object.values(entity.lifecycle).some(nodeIds => nodeIds.length > 0);
    if (entity.kind && entity.kind !== 'persisted-entity' && entity.kind !== 'api-response' && !observedLifecycle) continue;
    for (const word of splitIdentifierWords(entity.name)) vocab.add(normalizeToken(word));
  }
  return vocab;
}

export interface AudienceIdentifierTestResult {



  failsIdentifierTest: boolean;






  flaggedTokens: string[];
}






export function testCapabilityNameAgainstIdentifierVocabulary(
  name: string,
  libraries: Pick<CASLibrary, 'name'>[],
  entities: AudienceEntity[],
  productTerms: string[] = [],
): AudienceIdentifierTestResult {
  const identifierVocab = buildIdentifierVocabulary(libraries);
  const domainVocab = buildDomainEntityVocabulary(entities);
  const productVocab = buildProductVocabulary(productTerms);
  const flaggedTokens: string[] = [];
  const subjectTokens = capabilitySubjectTokens(name);

  for (const token of subjectTokens) {
    const normalized = normalizeToken(token);
    const appearsAsIdentifier = tokenAppearsAsIdentifier(normalized, identifierVocab);
    const appearsAsDomainEntity = domainVocab.has(normalized);
    if (appearsAsIdentifier && !appearsAsDomainEntity && !productVocab.has(normalized)) {
      flaggedTokens.push(token);
    }
  }

  const groundedSubjects = subjectTokens
    .map(normalizeToken)
    .filter(token => productVocab.has(token) || domainVocab.has(token));
  if (groundedSubjects.length >= Math.ceil(subjectTokens.length / 2)) flaggedTokens.length = 0;

  return { failsIdentifierTest: flaggedTokens.length > 0, flaggedTokens };
}















function descriptionCandidateTokens(description: string): string[] {
  const words = String(description || '').split(/[^A-Za-z0-9]+/).filter(Boolean);
  return words.filter(w => w.replace(/[^a-zA-Z]/g, '').length >= 4);
}





const SOURCE_FILE_PATH_PATTERN = /(?:^|[\s"'(])[\w.\-/\\]*[\/\\][\w.\-]+\.(?:ts|tsx|js|jsx|py|rb|java|kt|swift|go|rs|cs|php|c|cpp|h|hpp|scala|ex|exs)\b/i;
const VAGUE_MARKETING_PATTERN = /\b(?:insights?|comprehensive and accurate|seamless(?:ly)?|robust|best[- ]in[- ]class|world[- ]class|various operations?)\b/i;
const IMPLEMENTATION_PROSE_PATTERN = /\b(?:cli|command[- ]line)\s+(?:entry\s+point|command|interface)\b|\b(?:source[- ]code|implementation)\s+(?:type|class|interface|structure|detail)s?\b|\b(?:route|handler|controller|ui\s+widget)\s+(?:class|interface|implementation)s?\b/i;

export interface AudienceDescriptionTestResult {



  failsAudienceTest: boolean;


  reasons: string[];
  flaggedTokens: string[];
}






function descriptionRestatesName(name: string, description: string): boolean {
  const nameTokens = new Set(
    String(name || '').split(/[^A-Za-z0-9]+/).filter(Boolean).map(w => normalizeToken(w))
  );
  if (nameTokens.size === 0) return false;
  const descTokens = descriptionCandidateTokens(description).map(w => normalizeToken(w));
  if (descTokens.length === 0) return true;
  const novel = descTokens.filter(token => !nameTokens.has(token));
  return novel.length === 0;
}









export function testCapabilityDescriptionAgainstAudience(
  name: string,
  description: string | undefined,
  libraries: Pick<CASLibrary, 'name'>[],
  entities: AudienceEntity[],
  productTerms: string[] = [],
): AudienceDescriptionTestResult {
  const trimmed = String(description || '').trim();
  if (!trimmed) {
    return { failsAudienceTest: true, reasons: ['missing'], flaggedTokens: [] };
  }
  const reasons: string[] = [];
  const flaggedTokens: string[] = [];
  if (SOURCE_FILE_PATH_PATTERN.test(trimmed)) reasons.push('source-file-path');
  if (IMPLEMENTATION_PROSE_PATTERN.test(trimmed)) reasons.push('implementation-language');
  if (descriptionRestatesName(name, trimmed)) reasons.push('restates-name');
  const marketingMatch = trimmed.match(VAGUE_MARKETING_PATTERN)?.[0];
  const normalizedProductText = productTerms.join(' ').toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  if (marketingMatch && !normalizedProductText.includes(marketingMatch.toLowerCase().replace(/[^a-z0-9]+/g, ' '))) {
    reasons.push('marketing-language');
    flaggedTokens.push(marketingMatch);
  }

  const identifierVocab = buildIdentifierVocabulary(libraries);
  const domainVocab = buildDomainEntityVocabulary(entities);
  const productVocab = buildProductVocabulary(productTerms);
  const nameSubjects = capabilitySubjectTokens(name).map(normalizeToken);
  const groundedNameSubjects = nameSubjects.filter(token => productVocab.has(token) || domainVocab.has(token));
  const trustedNameSubjects = new Set(
    groundedNameSubjects.length >= Math.ceil(nameSubjects.length / 2) ? nameSubjects : groundedNameSubjects,
  );
  const structuralEntityWordsByName = new Map(
    entities
      .filter(entity => entity.kind && entity.kind !== 'persisted-entity' && entity.kind !== 'api-response')
      .map(entity => [
        normalizeToken(String(entity.name || '').replace(/[^A-Za-z0-9]/g, '')),
        splitIdentifierWords(entity.name).map(normalizeToken),
      ] as const)
      .filter(([token]) => token.length >= 5),
  );
  for (const token of descriptionCandidateTokens(trimmed)) {
    const normalized = normalizeToken(token);
    const appearsAsIdentifier = tokenAppearsAsIdentifier(normalized, identifierVocab);
    const appearsAsDomainEntity = domainVocab.has(normalized);
    const structuralEntityWords = structuralEntityWordsByName.get(normalized);
    const namesStructuralType = Boolean(structuralEntityWords);
    const namesGroundedStructuralType = structuralEntityWords?.some(word =>
      productVocab.has(word) || domainVocab.has(word) || trustedNameSubjects.has(word)
    );
    if (
      (appearsAsIdentifier || namesStructuralType) &&
      !appearsAsDomainEntity &&
      !namesGroundedStructuralType &&
      !productVocab.has(normalized) &&
      !trustedNameSubjects.has(normalized)
    ) flaggedTokens.push(token);
  }
  if (flaggedTokens.length > 0) reasons.push('identifier-vocabulary');

  return { failsAudienceTest: reasons.length > 0, reasons, flaggedTokens };
}
