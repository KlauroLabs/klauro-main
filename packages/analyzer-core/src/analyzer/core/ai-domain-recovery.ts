import { aiService } from '../../ai/ai-service';
import { recordSemanticDecision } from '../../ai/semantic-dataset';

export interface DomainRejection {
  label: string;
  reason: string;
}

export function buildGroundedDomainVocabulary(input: {
  systemName: string;
  projectText: Array<string | undefined>;
  entityNames: string[];
  capabilityNames: string[];
  coreConcepts: string[];
  implementationNames: string[];
  isGenericToken: (token: string) => boolean;
}): string[] {
  const tokenize = (values: Array<string | undefined>): string[] => values
    .flatMap(value => String(value || '').toLowerCase().split(/[^a-z0-9]+/))
    .filter(Boolean);
  const systemTokens = new Set(tokenize([input.systemName]).filter(token => token.length >= 3));
  const firstPartyValues = [...input.projectText, ...input.entityNames, ...input.capabilityNames];
  const firstPartyTokens = new Set(tokenize(firstPartyValues));
  const implementationTokens = new Set(tokenize(input.implementationNames));
  const protocolTokens = new Set(['get', 'post', 'put', 'patch', 'delete', 'http', 'https', 'graphql', 'grpc']);
  const supportingMechanismTokens = new Set(['auth', 'authentication', 'authorization', 'guard', 'middleware', 'validation', 'security', 'session', 'logging', 'cache', 'queue']);
  return Array.from(new Set(tokenize([...firstPartyValues, ...input.coreConcepts])
    .filter(token => token.length >= 3)
    .filter(token => !systemTokens.has(token))
    .filter(token => firstPartyTokens.has(token) || !implementationTokens.has(token))
    .filter(token => firstPartyTokens.has(token) || !protocolTokens.has(token))
    .filter(token => firstPartyTokens.has(token) || !supportingMechanismTokens.has(token))
    .filter(token => !/^(?:and|for|the|this|that|with|from|into|around|parts?|remain|product|critical|future|legacy)$/.test(token))
    .filter(token => !input.isGenericToken(token))))
    .slice(0, 32);
}

export async function recoverAIDomainLabel(input: {
  systemName: string;
  domainVocabulary: string[];
  capabilities: string[];
  entities: string[];
  rejectedCandidates: DomainRejection[];
  readOnly: boolean;
  model?: string;
  modelProvider?: string;
  parseDomain: (raw: string) => string | undefined;
  normalize: (candidate: string) => string | undefined;
  evaluate: (label: string) => { accepted: boolean };
}): Promise<{ label?: string; rejections: DomainRejection[] }> {
  const rejections: DomainRejection[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw = await aiService.generateComponentDescription({
        additionalContext: {
          model: input.model,
          model_provider: input.modelProvider,
          responseFormat: 'json',
          task: 'Return ONLY JSON shaped as {"domain":"..."}. Produce one lowercase kebab-case product-domain label of 2 to 4 nouns. Use at least one exact noun from allowedProductNouns and, only when needed to form a natural domain label, one term from allowedScopeTerms. Do not use framework, library, protocol, transport, HTTP-method, source-code, repository, or project-name words. Do not repeat any rejected label.',
          systemName: input.systemName,
          allowedProductNouns: input.domainVocabulary,
          allowedScopeTerms: input.readOnly
            ? ['viewing', 'exploration', 'reference', 'discovery']
            : ['management', 'operations', 'workflow', 'administration', 'service'],
          acceptedCapabilities: input.capabilities,
          dataEntities: input.entities,
          rejectedCandidates: [...input.rejectedCandidates, ...rejections],
          attempt,
        },
      });
      const candidate = input.parseDomain(raw);
      recordSemanticDecision({
        ts: Date.now(),
        decision_type: 'domain_recovery',
        prompt_version: 'domain_recovery.v1',
        input_evidence_digest: {
          vocabulary: input.domainVocabulary.length,
          capabilities: input.capabilities.length,
          entities: input.entities.length,
          rejected: input.rejectedCandidates.length + rejections.length,
          attempt,
        },
        raw_output_excerpt: candidate || raw,
        parse_ok: Boolean(candidate),
        gate_verdict: candidate ? 'accepted' : 'rejected',
        gate_reason: candidate ? undefined : 'missing-domain',
        final_outcome: candidate ? 'ai' : 'error',
      });
      const label = candidate ? input.normalize(candidate) : undefined;
      if (!label) continue;
      if (input.readOnly && /(?:^|-)(?:management|lifecycle|mutation|write)(?:-|$)/i.test(label)) {
        rejections.push({ label, reason: 'read-only-domain-claims-ownership' });
        continue;
      }
      const verdict = input.evaluate(label);
      if (!verdict.accepted) {
        rejections.push({ label, reason: 'failed-domain-quality-gate' });
        continue;
      }
      return { label, rejections };
    } catch (error) {
      recordSemanticDecision({
        ts: Date.now(),
        decision_type: 'domain_recovery',
        prompt_version: 'domain_recovery.v1',
        input_evidence_digest: { attempt },
        parse_ok: false,
        gate_verdict: 'rejected',
        gate_reason: error instanceof Error ? error.message : String(error),
        final_outcome: 'error',
      });
    }
  }
  return { rejections };
}
