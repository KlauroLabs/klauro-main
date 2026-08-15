import type { CASOutput } from '../../types/cas.types';
import { isLanguageBuiltinName } from './language-builtins';

function hasUnsupportedExternalClaim(previousOutput: CASOutput): boolean {
  const description = previousOutput.enhanced_system_purpose?.inferred_description || '';
  if (/\b(?:connects to|connected to|calls out to)\b[^.]*\b(?:Self|gtk|objc_sys|[A-Z][A-Za-z0-9]*(?:Data|Decl|Item|Pool|Size))\b/.test(description)) {
    return true;
  }
  if (/\bexternal services? like\b/i.test(description)) {
    const candidates = description
      .split(/[,\s.()]+/)
      .map(token => token.trim())
      .filter(Boolean);
    if (candidates.some(candidate => isLanguageBuiltinName(candidate))) return true;
  }
  return false;
}

export function previousDescriptionNeedsCurrentValidation(previousOutput: CASOutput): boolean {
  const description = previousOutput.enhanced_system_purpose?.inferred_description || '';
  const domain = previousOutput.enhanced_system_purpose?.primary_domain || '';
  const previousOperations = (previousOutput.capabilities || []).flatMap(capability => capability.operations || []);
  const previousHasRead = previousOperations.some(operation =>
    /^(?:view|read|list|get|show|access|analyze|review)$/i.test(operation.action || '') ||
    /^(?:GET|HEAD|OPTIONS)$/i.test(operation.trigger?.method || '')
  );
  const previousHasMutation = previousOperations.some(operation =>
    /^(?:create|update|delete|write|modify|submit|configure|manage|mutate)$/i.test(operation.action || '') ||
    /^(?:POST|PUT|PATCH|DELETE)$/i.test(operation.trigger?.method || '')
  );
  if (hasUnsupportedExternalClaim(previousOutput)) return true;
  if (previousHasRead && !previousHasMutation &&
    /\b(?:creat(?:e|es|ing|ion)|updat(?:e|es|ing)|delet(?:e|es|ing|ion)|writ(?:e|es|ing)|modif(?:y|ies|ying|ication)|submits?|configur(?:e|es|ing|ation)|manag(?:e|es|ing|ement)|mutat(?:e|es|ing|ion))\b/i.test(description)) {
    return true;
  }
  if (/\b(?:manages|coordinates?)\s+[^.]{3,140}\s+workflows\b/i.test(description) ||
    /\bworkflows?\s+to\s+produce\s+and\s+manage\b/i.test(description) ||
    /\bmain grounded concepts are\b/i.test(description) ||
    /\bservice records?\b/i.test(description) ||
    /\bhttp requests?\b|\b(?:dedicated|specific|internal|route|request)?\s*handlers?\b/i.test(description) ||
    /\b(?:utiliz(?:e|es|ing)|leverag(?:e|es|ing))\s+(?:frameworks?|libraries?)\b/i.test(description) ||
    /\bframeworks?\s+(?:like|such as)\b/i.test(description) ||
    /\bbuilt\s+using\s+(?:a\s+)?combination\s+of\s+frameworks?\b/i.test(description) ||
    /\bgraph evidence\b/i.test(description) ||
    /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/.test(description)) {
    return true;
  }
  const primaryType = previousOutput.enhanced_system_purpose?.primary_type || '';
  const classificationContext = `${domain} ${primaryType}`.toLowerCase();
  if (!domain.trim() && !primaryType.trim()) return false;
  const typeClaimStopWords = new Set([
    'a', 'an', 'the', 'this', 'that', 'and', 'or', 'for', 'with', 'its',
    'their', 'our', 'main', 'core', 'general', 'basic', 'internal',
    'primary', 'central', 'various', 'multiple', 'other', 'more', 'built',
    'used', 'using', 'full', 'stack', 'based',
  ]);
  const typeClaimPattern = /\b((?:[a-z][a-z-]{2,}(?:[- ][a-z][a-z-]{2,}){0,2}))\s+(?:tool|system|service|platform|application|app|api|engine|framework|library|server|gateway|pipeline|dashboard|suite|toolkit|sdk)s?\b/gi;
  let typeClaimMatch: RegExpExecArray | null;
  while ((typeClaimMatch = typeClaimPattern.exec(description)) !== null) {
    const modifierTokens = typeClaimMatch[1]
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(token => token.length >= 4 && !typeClaimStopWords.has(token));
    if (modifierTokens.length === 0) continue;
    if (!modifierTokens.some(token => classificationContext.includes(token))) return true;
  }
  return false;
}
