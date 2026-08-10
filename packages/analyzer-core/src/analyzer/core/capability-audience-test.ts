/**
 * AUDIENCE-TEST DISCRIMINATOR (#119 capability/mechanism audit follow-up).
 *
 * The audit's acceptance criterion: "the capability should be able to be
 * read by a NON-TECHNICAL PERSON... think product managers, designers, or
 * even marketing people." `Authenticate with WebAuthn` fails because a
 * designer does not know what WebAuthn is — but there is no vocabulary list
 * of protocol/vendor/library names to check against (~30 such tables were
 * deliberately torn out of this product; the spec-purity gate blocks
 * deploys on regressions). This module implements the audit's recommended
 * STRUCTURAL discriminator instead:
 *
 *   "if a token in a capability name appears in the codebase only as an
 *   identifier — an import, dependency, package or type name — and never in
 *   domain entity vocabulary, it is mechanism vocabulary."
 *
 * Evidence sources, all already computed elsewhere in the CAS, no new
 * vocabulary:
 *   - IDENTIFIER vocabulary: `CASLibrary.name` (dependency/package names —
 *     import evidence) and, optionally, non-entity type/class node names.
 *   - DOMAIN vocabulary: `CASDataEntity.name` (persisted-entity/api-response
 *     records — the system's own business nouns).
 *
 * MEASURED LIMITATION (see the accompanying test file / the #119 report):
 * this signal is NOT reliable on its own for auth/session-artifact
 * capabilities whose persisted entity's OWN name is the mechanism token
 * concatenated with a generic suffix (`WebAuthnCredential`, `APIKey`) —
 * whether that token counts as "appearing in domain vocabulary" depends on
 * whether domain-name matching is done by SUBSTRING (too permissive — the
 * mechanism token is trivially inside the entity name, so it never gets
 * flagged) or by EXACT segmented-word match (too strict against acronym-
 * shaped names, and also fails to flag some real mechanism cases whenever
 * the entity's other segments happen to coincide). This module uses EXACT
 * segmented-word matching (the stricter, more defensible reading of "domain
 * entity vocabulary" — the word actually IS one of the entity's own parts,
 * not merely a substring some other compound name happens to contain), which
 * the accompanying test suite shows correctly separates WebAuthn/session
 * cases from real product nouns (Feed/Entry) but is not perfect on
 * acronym-cased entities (`APIKey`). The audit's own conclusion — this class
 * is not fully structurally discriminable and requires a top-down
 * domain-identity judgment as a backstop — still holds; this discriminator
 * narrows, but does not close, that gap. Reported honestly, not
 * oversold.
 */

import { CAPABILITY_PURPOSE_VERBS } from './capability-naming';
import type { CASDataEntity, CASLibrary } from '../../types/cas.types';

/** Splits a PascalCase/camelCase identifier into its component words,
 *  including acronym runs ("APIKey" -> ["API", "Key"], "WebAuthnCredential"
 *  -> ["Web", "Authn", "Credential"]). Generic tokenizer, no vocabulary. */
export function splitIdentifierWords(identifier: string): string[] {
  const spaced = String(identifier || '')
    // Acronym run followed by a new capitalized word: "APIKey" -> "API Key"
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    // lower/digit -> upper boundary: "webAuthn" -> "web Authn"
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    // separators
    .replace(/[_\-./]+/g, ' ');
  return spaced.split(/\s+/).map(w => w.trim()).filter(Boolean);
}

/** Very light singularization — strips a trailing "s" (never a stemming
 *  table). Good enough for the common "Feeds" -> "Feed" case; deliberately
 *  does not try to handle irregular plurals, which would start to look like
 *  a vocabulary table. */
function normalizeToken(token: string): string {
  const lower = token.toLowerCase();
  return lower.endsWith('s') && lower.length > 3 ? lower.slice(0, -1) : lower;
}

/**
 * The SUBJECT of a capability name: the name with any leading purpose verb
 * (and its common inflection) stripped, tokenized into words. "Authenticate
 * with WebAuthn" -> ["with", "WebAuthn"]; "Manage RSS Feeds" -> ["RSS",
 * "Feeds"]. Reuses the SAME purpose-verb list the rest of the capability
 * pipeline already uses (capability-naming.ts) rather than a second list.
 */
export function capabilitySubjectTokens(name: string): string[] {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const first = words[0].toLowerCase();
  // Try every common inflection ending in turn (rather than one combined
  // regex) so "manages" -> "manage" (strip "s", not "es" verbatim) resolves
  // correctly alongside "managing" -> "manage" and "managed" -> "manage".
  // Still no project-specific inflection table — these are the same three
  // generic English suffixes capability-naming.ts already strips.
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
  // Only tokens with real content (length >= 3) are evaluated as evidence —
  // this is a length filter, not a stopword list: short function words
  // ("of", "to", "in") are excluded because they are too short to be
  // meaningful identifier/domain evidence either way, not because of what
  // they mean.
  return rest.filter(w => w.replace(/[^a-zA-Z]/g, '').length >= 3);
}

export interface IdentifierVocabulary {
  /** Normalized (singularized, lowercased) individual words split out of
   *  every library/package name — exact-word evidence. */
  words: Set<string>;
  /** Whole package names squashed to bare lowercase letters/digits (no
   *  splitting) — substring evidence, so a compound/scoped package name
   *  like "@simplewebauthn/server" or "passport-webauthn" still carries the
   *  mechanism token as one contiguous run even though it never appears as
   *  its own standalone word. */
  flatNames: string[];
}

/** Builds the codebase's own import/dependency vocabulary from its real
 *  library/package list — no new vocabulary table, just a structural read
 *  of CASLibrary.name. */
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

/** True when `token` (already normalized) reads as evidence that it is a
 *  real import/dependency identifier: either an exact split-word match, or
 *  a substring match against a whole package name (in EITHER direction —
 *  "session" is a substring of the package "gorilla/sessions", and a short
 *  package name can likewise be a substring of a longer compound token). */
function tokenAppearsAsIdentifier(token: string, vocab: IdentifierVocabulary): boolean {
  if (vocab.words.has(token)) return true;
  if (token.length < 4) return false; // too short for reliable substring evidence
  return vocab.flatNames.some(flat => flat.includes(token) || (flat.length >= 4 && token.includes(flat)));
}

/** Normalized set of every WORD that is one of a domain entity's own
 *  segmented parts (never a substring of a compound name — see the module
 *  doc for why that distinction is the one that makes WebAuthnCredential
 *  not count as "Feed"-style domain vocabulary for the token "WebAuthn"). */
export function buildDomainEntityVocabulary(entities: Pick<CASDataEntity, 'name' | 'kind'>[]): Set<string> {
  const vocab = new Set<string>();
  for (const entity of entities || []) {
    if (!entity?.name) continue;
    // Only real product-record kinds count as domain vocabulary — a
    // request-dto/value-object carries no more product truth than an
    // ordinary function parameter.
    if (entity.kind && entity.kind !== 'persisted-entity' && entity.kind !== 'api-response') continue;
    for (const word of splitIdentifierWords(entity.name)) vocab.add(normalizeToken(word));
  }
  return vocab;
}

export interface AudienceIdentifierTestResult {
  /** True when at least one subject token reads as identifier-only
   *  vocabulary (appears as an import/dependency, never as a domain
   *  entity's own word). */
  failsIdentifierTest: boolean;
  /** The specific token(s) that triggered the failure — evidence, not a
   *  verdict on the whole name (a capability can still be legitimate if
   *  ONLY a supporting/qualifying word triggers this; callers should weigh
   *  this alongside other evidence, matching the audit's own caution that
   *  this signal is necessary-but-not-sufficient for the auth/session
   *  class). */
  flaggedTokens: string[];
}

/**
 * Runs the audit's structural discriminator against one capability name.
 * `libraries` and `entities` are the CAS's own already-computed evidence —
 * no new vocabulary table is introduced here.
 */
export function testCapabilityNameAgainstIdentifierVocabulary(
  name: string,
  libraries: Pick<CASLibrary, 'name'>[],
  entities: Pick<CASDataEntity, 'name' | 'kind'>[],
): AudienceIdentifierTestResult {
  const identifierVocab = buildIdentifierVocabulary(libraries);
  const domainVocab = buildDomainEntityVocabulary(entities);
  const flaggedTokens: string[] = [];

  for (const token of capabilitySubjectTokens(name)) {
    const normalized = normalizeToken(token);
    const appearsAsIdentifier = tokenAppearsAsIdentifier(normalized, identifierVocab);
    const appearsAsDomainEntity = domainVocab.has(normalized);
    if (appearsAsIdentifier && !appearsAsDomainEntity) {
      flaggedTokens.push(token);
    }
  }

  return { failsIdentifierTest: flaggedTokens.length > 0, flaggedTokens };
}
