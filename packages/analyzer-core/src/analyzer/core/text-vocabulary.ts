/**
 * Shared vocabulary extraction over human-authored TEXT (README/PRD prose,
 * manifest descriptions, doc comments, UI strings).
 *
 * This module exists because the analyzer previously derived a repository's
 * "concepts" by scoring its text against a fixed list of domain/product
 * phrases. A candidate list is fitted to whatever corpus was on hand, so it
 * reports its OWN vocabulary back as the repository's concepts and stays
 * silent about anything it was not fitted to. The replacement reads only what
 * the text itself says: term frequency over the prose, filtered by
 * language-level noise predicates, gated on repetition and on distinctiveness
 * relative to the text's own frequency distribution.
 *
 * NOTHING in this file may name a product, company, industry, or business
 * domain. The only vocabulary hardcoded here is ENGLISH FUNCTION WORDS —
 * closed-class words (determiners, pronouns, prepositions, conjunctions,
 * auxiliaries) plus the handful of high-frequency light verbs and adverbs that
 * carry no referential content in any domain. That is a property of the
 * English language, not of any codebase, and it is the same category as the
 * existing language-builtin and generic-token predicates.
 */

/**
 * English closed-class and light-content words. Every entry is a word whose
 * presence in prose tells you nothing about the subject matter, in any
 * domain. Deliberately does NOT contain nouns that could name a thing a
 * system works with.
 */
export const ENGLISH_FUNCTION_WORDS = new Set<string>([
  // determiners / quantifiers
  'the', 'this', 'that', 'these', 'those', 'each', 'every', 'both', 'either',
  'neither', 'some', 'any', 'many', 'much', 'more', 'most', 'less', 'least',
  'few', 'fewer', 'several', 'all', 'none', 'other', 'others', 'another',
  'such', 'same', 'own', 'enough', 'half', 'whole',
  // pronouns
  'you', 'your', 'yours', 'they', 'them', 'their', 'theirs', 'she', 'her',
  'hers', 'him', 'his', 'its', 'our', 'ours', 'we', 'us', 'who', 'whom',
  'whose', 'which', 'what', 'whatever', 'whoever', 'itself', 'themselves',
  'yourself', 'anyone', 'someone', 'everyone', 'nobody', 'anything',
  'something', 'everything', 'nothing',
  // prepositions / conjunctions / subordinators
  'and', 'but', 'for', 'nor', 'yet', 'with', 'without', 'within', 'from',
  'into', 'onto', 'upon', 'over', 'under', 'above', 'below', 'between',
  'among', 'across', 'through', 'during', 'before', 'after', 'while', 'until',
  'unless', 'though', 'although', 'because', 'since', 'than', 'then', 'when',
  'whenever', 'where', 'wherever', 'whether', 'about', 'against', 'along',
  'around', 'behind', 'beside', 'beyond', 'despite', 'except', 'inside',
  'outside', 'toward', 'towards', 'via', 'per', 'off', 'out', 'too', 'also',
  'however', 'therefore', 'thus', 'hence', 'instead', 'rather', 'otherwise',
  'meanwhile', 'moreover', 'furthermore', 'besides', 'anyway',
  // auxiliaries / modals / copulas
  'are', 'was', 'were', 'been', 'being', 'have', 'has', 'had', 'having',
  'does', 'did', 'doing', 'done', 'will', 'would', 'shall', 'should', 'can',
  'could', 'may', 'might', 'must', 'cannot', 'wont', 'dont', 'doesnt',
  'isnt', 'arent', 'wasnt', 'werent', 'havent', 'hasnt', 'hadnt', 'shouldnt',
  'wouldnt', 'couldnt', 'lets',
  // light verbs / adverbs / discourse
  'make', 'makes', 'made', 'making', 'take', 'takes', 'taken', 'taking',
  'give', 'gives', 'given', 'giving', 'come', 'comes', 'came', 'coming',
  'want', 'wants', 'wanted', 'need', 'needs', 'needed', 'like', 'likes',
  'liked', 'know', 'knows', 'known', 'think', 'thinks', 'thought', 'look',
  'looks', 'looked', 'keep', 'keeps', 'kept', 'let', 'put', 'puts',
  'very', 'just', 'even', 'only', 'still', 'already', 'always', 'never',
  'often', 'sometimes', 'usually', 'again', 'once', 'twice', 'here', 'there',
  'now', 'soon', 'later', 'well', 'better', 'best', 'worse', 'worst',
  'good', 'great', 'easy', 'easily', 'simple', 'simply', 'quick', 'quickly',
  'fast', 'slow', 'able', 'available', 'possible', 'sure', 'true', 'false',
  'yes', 'not', 'both', 'like', 'lot', 'lots', 'way', 'ways', 'thing',
  'things', 'kind', 'sort', 'part', 'parts', 'etc',
]);

export function isEnglishFunctionWord(token: string | undefined): boolean {
  return ENGLISH_FUNCTION_WORDS.has(String(token || '').toLowerCase());
}

export interface DistinctiveVocabularyOptions {
  /** Rejects a token as noise. Called for every candidate word. */
  isNoiseToken: (token: string) => boolean;
  /** Maximum number of terms to return. */
  limit?: number;
  /**
   * Minimum times a term must occur before it can be a concept. A term the
   * authors used exactly once is not a core concept of the system.
   */
  minOccurrences?: number;
  /**
   * A term must reach this fraction of the most frequent term's score to
   * count as distinctive. This is what keeps incidental prose vocabulary out
   * without an absolute threshold that over-fires on long documents and
   * never fires on short ones.
   */
  dominanceFloor?: number;
}

interface ScoredTerm {
  term: string;
  score: number;
  words: string[];
}

/**
 * Extracts the distinctive multi- and single-word vocabulary a body of text
 * actually uses, ranked by prominence within that text.
 *
 * Bigrams are scored above their component unigrams because a repeated
 * two-word phrase is a far stronger signal of a named concept than either
 * word alone, and a unigram that occurs almost exclusively inside a selected
 * bigram is dropped as redundant rather than reported twice.
 */
export function extractDistinctiveTextVocabulary(
  text: string,
  options: DistinctiveVocabularyOptions,
): string[] {
  const limit = options.limit ?? 8;
  const minOccurrences = options.minOccurrences ?? 2;
  const dominanceFloor = options.dominanceFloor ?? 0.15;

  const words = String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.length === 0) return [];

  const keep = words.map(word => !options.isNoiseToken(word));

  const unigrams = new Map<string, number>();
  const bigrams = new Map<string, number>();
  for (let i = 0; i < words.length; i++) {
    if (!keep[i]) continue;
    unigrams.set(words[i], (unigrams.get(words[i]) || 0) + 1);
    if (i + 1 < words.length && keep[i + 1]) {
      const bigram = `${words[i]} ${words[i + 1]}`;
      bigrams.set(bigram, (bigrams.get(bigram) || 0) + 1);
    }
  }

  const scored: ScoredTerm[] = [];
  for (const [term, count] of bigrams) {
    if (count < minOccurrences) continue;
    // A repeated two-word phrase is a named concept; weight it above the sum
    // of its parts so it outranks the generic word it contains.
    scored.push({ term, score: count * 2.5, words: term.split(' ') });
  }
  for (const [term, count] of unigrams) {
    if (count < minOccurrences) continue;
    scored.push({ term, score: count, words: [term] });
  }
  if (scored.length === 0) return [];

  scored.sort((a, b) => b.score - a.score || a.term.localeCompare(b.term));
  const topScore = scored[0].score;
  const distinctivenessCutoff = Math.max(minOccurrences, topScore * dominanceFloor);

  const selected: string[] = [];
  const consumedByPhrase = new Map<string, number>();
  for (const candidate of scored) {
    if (candidate.score < distinctivenessCutoff) break;
    if (candidate.words.length === 1) {
      // Drop a unigram whose occurrences are mostly accounted for by an
      // already-selected phrase containing it — it adds no new concept.
      const consumed = consumedByPhrase.get(candidate.term) || 0;
      if (consumed > 0 && consumed >= (unigrams.get(candidate.term) || 0) * 0.6) continue;
    } else {
      for (const word of candidate.words) {
        const occurrences = bigrams.get(candidate.term) || 0;
        consumedByPhrase.set(word, (consumedByPhrase.get(word) || 0) + occurrences);
      }
    }
    selected.push(candidate.term);
    if (selected.length >= limit) break;
  }

  return selected;
}
