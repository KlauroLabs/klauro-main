import type { CASOutput, CASNode } from '../../../packages/analyzer-core/src/types/cas.types';
import type { EmbeddingProvider, VectorStore, ScoredNodeId } from '../../../packages/analyzer-core/src/analyzer/embedding/types';
import { createEmbeddingProvider } from '../../../packages/analyzer-core/src/analyzer/embedding/embedding-provider-factory';
import { createVectorStore } from '../../../packages/analyzer-core/src/analyzer/embedding/vector-store-factory';
import { EmbeddingCache } from '../../../packages/analyzer-core/src/analyzer/embedding/embedding-cache';
import { getAnalysis } from './analyzer';
import { getProjectStorageDir } from './storage';
import { loadKlauroConfig } from './klauro-config';
import { searchNodes } from './query';
import { getPgPool, resolvePgConnectionString } from './pg-pool';

export interface SemanticSearchOptions {
  type?: string;
  category?: string;
  level?: number;
  limit?: number;
  files?: string[];
  types?: string[];
  mode?: 'lexical' | 'semantic' | 'hybrid';
  /**
   * 'compact' (default): drop the sub-score breakdown and graph_context,
   * keep a single final score, and lower the default limit — see
   * docs/SPEC-RESPONSE-BUDGET.md §4. 'full' restores today's shape
   * (all sub-scores + graph_context) at the historical default limit.
   */
  detail?: 'compact' | 'full';
  /**
   * Freshness-gated CAS loader override. Callers on the agent-entry path (e.g.
   * search_nodes) pass getFreshAnalysisForAgent here so semantic/hybrid search
   * reads a refreshed CAS instead of the raw stored one; defaults to the plain
   * getAnalysis(path) for callers that don't need the guarantee. Keeping this as
   * an injected function avoids a circular import between semantic-search.ts and
   * server.ts (the freshness gate lives in server.ts).
   */
  getCas?: (projectPath: string) => Promise<CASOutput>;
}

export interface SemanticSearchResult {
  node_id: string;
  name: string;
  qualified_name?: string;
  type: string;
  framework_role?: string;
  file?: string;
  score: number;
  scores?: {
    semantic: number;
    lexical: number;
    structural: number;
    final: number;
  };
  graph_context?: {
    caller_count: number;
    callee_count: number;
    test_count: number;
    is_entry_point: boolean;
    risk?: string;
  };
}

export interface SemanticSearchResponse {
  mode: 'lexical' | 'semantic' | 'hybrid';
  degraded: boolean;
  degraded_reason?: string;
  query: string;
  results: SemanticSearchResult[];
}

const RRF_K = 60;

const queryEmbeddingCache = new EmbeddingCache();

export async function semanticSearch(
  projectPath: string,
  query: string,
  options: SemanticSearchOptions = {},
): Promise<SemanticSearchResponse> {
  const detail = options.detail || 'compact';
  // compact default (8) covers what most agents actually consume from a
  // search (top 3-5 results) without replaying ~20 unused hits on every
  // subsequent turn; full keeps the historical default of 25.
  const defaultLimit = detail === 'full' ? 25 : 8;
  const limit = options.limit && options.limit > 0 ? options.limit : defaultLimit;
  const cas = await (options.getCas ? options.getCas(projectPath) : getAnalysis(projectPath));
  const { config } = await loadKlauroConfig(projectPath);

  const degraded = (reason: string): SemanticSearchResponse => ({
    mode: 'lexical',
    degraded: true,
    degraded_reason: reason,
    query,
    results: lexicalFallback(cas, query, options, limit),
  });

  if (!config.embedding.enabled) {
    return degraded('Embedding is disabled in .klaurorc');
  }

  const index = cas.embedding_index;
  if (!index) {
    return degraded('Analysis has no embedding index');
  }

  let provider: EmbeddingProvider;
  try {
    provider = createEmbeddingProvider(config.embedding.provider, {
      model: config.embedding.model,
      dimensions: config.embedding.dimensions,
      maxBatch: 1,
      maxConcurrency: config.embedding.maxConcurrency,
      apiKeyEnv: config.embedding.apiKeyEnv,
    });
  } catch (error) {
    return degraded(`Embedding provider unavailable: ${errorMessage(error)}`);
  }

  if (provider.model !== index.model) {
    return degraded(
      `Query model "${provider.model}" does not match index model "${index.model}"`,
    );
  }
  if (provider.dimensions !== index.dimensions) {
    return degraded(
      `Query dimensions ${provider.dimensions} do not match index dimensions ${index.dimensions}`,
    );
  }

  let queryVector = queryEmbeddingCache.get(query, provider.model);
  if (queryVector === undefined) {
    try {
      const embedded = await provider.embed([query]);
      if (embedded.length === 0) {
        return degraded('Embedding provider returned no vector for the query');
      }
      queryVector = embedded[0];
      queryEmbeddingCache.set(query, provider.model, queryVector);
    } catch (error) {
      return degraded(`Query embedding failed: ${errorMessage(error)}`);
    }
  }

  const store = resolveVectorStore(
    projectPath,
    cas,
    config.embedding.store,
    config.embedding.databaseUrlEnv,
    config.embedding.dimensions,
  );
  if (!store) {
    return degraded('Vector store could not be resolved');
  }

  let vectorHits: ScoredNodeId[];
  try {
    vectorHits = await store.query(cas.analysis_id, queryVector, limit * 3);
  } catch (error) {
    return degraded(`Vector store query failed: ${errorMessage(error)}`);
  }

  const lexicalHits = searchNodes(cas, query, {
    type: options.type,
    category: options.category,
    level: options.level,
    limit: limit * 3,
  });

  const mode = options.mode ?? 'hybrid';
  const fusedVectorHits = mode === 'lexical' ? [] : vectorHits;
  const fusedLexicalHits = mode === 'semantic' ? [] : lexicalHits;
  const results = fuseAndRank(cas, query, fusedVectorHits, fusedLexicalHits, options, limit, config.embedding.rerank);

  return {
    mode,
    degraded: Boolean(index.degraded),
    degraded_reason: index.degraded ? index.degraded_reason : undefined,
    query,
    results,
  };
}

function lexicalFallback(
  cas: CASOutput,
  query: string,
  options: SemanticSearchOptions,
  limit: number,
): SemanticSearchResult[] {
  const lexicalHits = searchNodes(cas, query, {
    type: options.type,
    category: options.category,
    level: options.level,
    limit: limit * 3,
  });
  const nodesById = nodeIndex(cas);
  const graph = buildGraphSignals(cas);
  const ranked: Array<{ node: CASNode; lexical: number; final: number }> = [];
  for (let i = 0; i < lexicalHits.length; i++) {
    const node = nodesById.get(lexicalHits[i].id);
    if (!node || !passesFilter(node, options)) continue;
    const lexical = rankToScore(i, lexicalHits.length);
    ranked.push({ node, lexical, final: lexical });
  }
  ranked.sort((a, b) => b.final - a.final || a.node.id.localeCompare(b.node.id));
  const detail = options.detail || 'compact';
  return ranked.slice(0, limit).map(entry => toResult(cas, entry.node, graph, {
    semantic: 0,
    lexical: entry.lexical,
    structural: graph.structuralScore(entry.node.id, new Set()),
    final: entry.final,
  }, detail));
}

export function fuseAndRank(
  cas: CASOutput,
  query: string,
  vectorHits: ScoredNodeId[],
  lexicalHits: ReturnType<typeof searchNodes>,
  options: SemanticSearchOptions,
  limit: number,
  rerank: { alpha: number; beta: number },
): SemanticSearchResult[] {
  const nodesById = nodeIndex(cas);
  const graph = buildGraphSignals(cas);

  const vectorRank = new Map<string, number>();
  const semanticScore = new Map<string, number>();
  for (let i = 0; i < vectorHits.length; i++) {
    if (!vectorRank.has(vectorHits[i].nodeId)) {
      vectorRank.set(vectorHits[i].nodeId, i);
      semanticScore.set(vectorHits[i].nodeId, clampUnit(vectorHits[i].score));
    }
  }

  const lexicalRank = new Map<string, number>();
  const lexicalScore = new Map<string, number>();
  for (let i = 0; i < lexicalHits.length; i++) {
    if (!lexicalRank.has(lexicalHits[i].id)) {
      lexicalRank.set(lexicalHits[i].id, i);
      lexicalScore.set(lexicalHits[i].id, rankToScore(i, lexicalHits.length));
    }
  }

  const candidateIds = new Set<string>();
  for (const id of vectorRank.keys()) {
    const node = nodesById.get(id);
    if (node && passesFilter(node, options)) candidateIds.add(id);
  }
  for (const id of lexicalRank.keys()) {
    const node = nodesById.get(id);
    if (node && passesFilter(node, options)) candidateIds.add(id);
  }

  const exactMatches = new Set<string>();
  const queryLower = query.trim().toLowerCase();
  for (const node of cas.nodes) {
    if (!passesFilter(node, options)) continue;
    if (
      node.name.toLowerCase() === queryLower ||
      (node.qualified_name && node.qualified_name.toLowerCase() === queryLower)
    ) {
      exactMatches.add(node.id);
      candidateIds.add(node.id);
    }
  }

  // Symbol-name boost: when the query looks like an identifier (buildSummary,
  // searchNodes, AnalyzerOrchestrator, ...), a node whose own name matches it
  // should win regardless of how the embedding happens to score — semantic
  // similarity is a heuristic for concept queries, but for a literal symbol
  // name the ground truth is the name itself. This runs as an additive tier
  // ABOVE the RRF/structural blend rather than replacing it, so hybrid/semantic
  // ranking is unaffected for natural-language queries (which rarely produce a
  // nameMatchTier > 0 for anything).
  const nameMatchTier = new Map<string, number>();
  if (isSymbolLikeQuery(query)) {
    for (const id of candidateIds) {
      const node = nodesById.get(id);
      if (!node) continue;
      nameMatchTier.set(id, computeNameMatchTier(node, queryLower));
    }
    // Symbol-like queries can also hit names that never surfaced in the
    // vector/lexical candidate pool at all (e.g. index skipped it, or the
    // hash-embedding provider scored an unrelated node higher). Pull in any
    // node with a strong name-tier match so it can compete for the top slot.
    for (const node of cas.nodes) {
      if (candidateIds.has(node.id) || !passesFilter(node, options)) continue;
      const tier = computeNameMatchTier(node, queryLower);
      if (tier > 0) {
        candidateIds.add(node.id);
        nameMatchTier.set(node.id, tier);
      }
    }
  }

  // Intent-query name-token coverage. `isSymbolLikeQuery` only fires for a
  // single identifier token, so a multi-word INTENT query ("orchestrate
  // incremental analysis", "full rebuild reason") gets no name-level credit
  // at all — a function literally named orchestrateIncrementalAnalysis scores
  // zero for the query words that make up its own name, and with the local
  // hash-embedding giving near-random semantic scores it loses to test-file
  // namesakes and generic files. This computes, for multi-token queries, the
  // fraction of QUERY content tokens covered by the node's own name/qualified-
  // name word tokens, and lifts strongly-covered production control-flow /
  // orchestration / decision functions (*orchestrate*/*rebuild*/*reason*/
  // *decide*/*resolve* and other high-fan-in gates) so they surface for the
  // intent that describes them. It occupies a score band BELOW the exact
  // symbol tiers (so a literal symbol query still wins) and requires real
  // coverage (>= a threshold) so pure natural-language concept queries that
  // match no name tokens are unaffected — the base fused/structural blend
  // still governs them.
  const nameCoverageBoost = new Map<string, number>();
  const queryTokens = contentTokens(query);
  if (queryTokens.length >= 2) {
    const queryTokenSet = new Set(queryTokens);
    const considerCoverage = (node: CASNode): void => {
      const coverage = nameTokenCoverage(node, queryTokenSet);
      const controlFlow = controlFlowNudge(node);
      // Require a majority of query tokens to land in the node's own name so a
      // one-word overlap ("analysis" matching every *Analysis* type) can't
      // hijack the band. Two-token queries need both; larger queries need
      // >= 60%. Production control-flow / decision gates get a lower bar (>=
      // 40%): a concept query like "incremental analysis cache reuse decision"
      // only shares "incremental"+"analysis" with orchestrateIncrementalAnalysis,
      // but that partial-plus-control-flow match is exactly the decision point
      // the query is after, and the CONTROL_FLOW_NAME gate keeps noise out.
      const baseThreshold = queryTokenSet.size <= 2 ? 1 : 0.6;
      const threshold = controlFlow > 0 ? Math.min(baseThreshold, 0.4) : baseThreshold;
      if (coverage < threshold) return;
      // Graded within a sub-tier: coverage in [threshold,1] maps to (0,0.6],
      // plus a decision/control-flow nudge (up to +0.4) so a production gate
      // function outranks an identically-named test helper. The whole boost
      // stays < 1 so it never crosses into the exact-symbol tier-1 band above.
      const boost = 0.6 * coverage + 0.4 * controlFlow;
      const existing = nameCoverageBoost.get(node.id) ?? 0;
      if (boost > existing) nameCoverageBoost.set(node.id, boost);
    };
    for (const id of candidateIds) {
      const node = nodesById.get(id);
      if (node) considerCoverage(node);
    }
    // As with the symbol path, pull in strongly-covered nodes that never made
    // the vector/lexical candidate pool so they can compete for the window.
    for (const node of cas.nodes) {
      if (candidateIds.has(node.id) || !passesFilter(node, options)) continue;
      const before = nameCoverageBoost.size;
      considerCoverage(node);
      if (nameCoverageBoost.size > before || nameCoverageBoost.has(node.id)) {
        candidateIds.add(node.id);
      }
    }
  }

  const fused = new Map<string, number>();
  for (const id of candidateIds) {
    let score = 0;
    if (vectorRank.has(id)) score += 1 / (RRF_K + vectorRank.get(id)! + 1);
    if (lexicalRank.has(id)) score += 1 / (RRF_K + lexicalRank.get(id)! + 1);
    fused.set(id, score);
  }

  let maxFused = 0;
  for (const value of fused.values()) {
    if (value > maxFused) maxFused = value;
  }

  const scored = [...candidateIds]
    .map(id => ({ id, node: nodesById.get(id)! }))
    .filter(entry => entry.node);

  const computed = scored.map(entry => {
    const fusedNorm = maxFused > 0 ? (fused.get(entry.id) ?? 0) / maxFused : 0;
    const structural = graph.structuralScore(entry.id, candidateIds);
    const baseFinal = rerank.alpha * fusedNorm + rerank.beta * structural;
    // Name-match tiers occupy disjoint score bands above the [0,1] base range
    // (tier 3 = exact name >= 3, tier 2 = startsWith/contains >= 2, tier 1 =
    // word-boundary token match >= 1) so a match always outranks every
    // non-matching node, while ties within a tier still fall back to the
    // normal fused/structural score.
    const tier = nameMatchTier.get(entry.id) ?? 0;
    // Exact-symbol tiers dominate (band >= 1). Below them, the intent name-
    // coverage boost lifts strongly-covered nodes above the plain fused/
    // structural blend. The boost band ([0,1]) is kept strictly under tier 1
    // by adding the base blend as a fractional tie-breaker (base is in [0,1],
    // scaled by 0.999 so a coverage boost of 1.0 + max base can't reach 2.0
    // and collide with a genuine tier-2 exact match).
    let final: number;
    if (tier > 0) {
      final = tier + baseFinal;
    } else {
      const coverage = nameCoverageBoost.get(entry.id) ?? 0;
      final = coverage > 0 ? coverage + 0.999 * baseFinal : baseFinal;
    }
    return {
      node: entry.node,
      semantic: semanticScore.get(entry.id) ?? 0,
      lexical: lexicalScore.get(entry.id) ?? 0,
      structural,
      final,
    };
  });

  computed.sort((a, b) => b.final - a.final || a.node.id.localeCompare(b.node.id));

  const window = computed.slice(0, limit);
  const windowIds = new Set(window.map(entry => entry.node.id));
  const missingExact = computed.filter(entry => exactMatches.has(entry.node.id) && !windowIds.has(entry.node.id));
  const detail = options.detail || 'compact';

  if (missingExact.length > 0) {
    const kept = window.slice(0, Math.max(0, limit - missingExact.length));
    const lifted = [...kept, ...missingExact].sort(
      (a, b) => b.final - a.final || a.node.id.localeCompare(b.node.id),
    );
    return lifted.map(entry => toResult(cas, entry.node, graph, {
      semantic: round(entry.semantic),
      lexical: round(entry.lexical),
      structural: round(entry.structural),
      final: round(entry.final),
    }, detail));
  }

  return window.map(entry => toResult(cas, entry.node, graph, {
    semantic: round(entry.semantic),
    lexical: round(entry.lexical),
    structural: round(entry.structural),
    final: round(entry.final),
  }, detail));
}

interface GraphSignals {
  callerCount(nodeId: string): number;
  calleeCount(nodeId: string): number;
  testCount(nodeId: string): number;
  isEntryPoint(nodeId: string): boolean;
  neighbors(nodeId: string): Set<string>;
  structuralScore(nodeId: string, candidates: Set<string>): number;
  maxConnectivity: number;
}

function buildGraphSignals(cas: CASOutput): GraphSignals {
  const callers = new Map<string, Set<string>>();
  const callees = new Map<string, Set<string>>();
  for (const edge of cas.edges) {
    if (!callees.has(edge.source)) callees.set(edge.source, new Set());
    callees.get(edge.source)!.add(edge.target);
    if (!callers.has(edge.target)) callers.set(edge.target, new Set());
    callers.get(edge.target)!.add(edge.source);
  }

  const entryPointNodes = new Set<string>();
  for (const ep of cas.entry_points || []) {
    if (ep.source_node) entryPointNodes.add(ep.source_node);
    if (ep.handler?.node_id) entryPointNodes.add(ep.handler.node_id);
    for (const id of ep.connected_nodes || []) entryPointNodes.add(id);
  }

  const testCounts = new Map<string, number>();
  for (const suite of cas.test_suites || []) {
    for (const id of suite.coverage?.nodes_tested || []) {
      testCounts.set(id, (testCounts.get(id) ?? 0) + 1);
    }
    for (const test of suite.tests || []) {
      for (const id of test.targets || []) {
        testCounts.set(id, (testCounts.get(id) ?? 0) + 1);
      }
    }
  }

  let maxConnectivity = 1;
  for (const node of cas.nodes) {
    const connectivity = (callers.get(node.id)?.size ?? 0) + (callees.get(node.id)?.size ?? 0);
    if (connectivity > maxConnectivity) maxConnectivity = connectivity;
  }

  const callerCount = (id: string) => callers.get(id)?.size ?? 0;
  const calleeCount = (id: string) => callees.get(id)?.size ?? 0;
  const testCount = (id: string) => testCounts.get(id) ?? 0;
  const isEntryPoint = (id: string) => entryPointNodes.has(id);
  const neighbors = (id: string): Set<string> => {
    const set = new Set<string>();
    for (const target of callees.get(id) || []) set.add(target);
    for (const source of callers.get(id) || []) set.add(source);
    return set;
  };

  const structuralScore = (id: string, candidates: Set<string>): number => {
    const entry = isEntryPoint(id) ? 1 : 0;
    const connectivity = Math.min(1, (callerCount(id) + calleeCount(id)) / maxConnectivity);
    const tested = testCount(id) > 0 ? 1 : 0;
    const nodeNeighbors = neighbors(id);
    let coherence = 0;
    if (nodeNeighbors.size > 0 && candidates.size > 0) {
      let shared = 0;
      for (const neighbor of nodeNeighbors) {
        if (candidates.has(neighbor)) shared++;
      }
      coherence = shared / nodeNeighbors.size;
    }
    return 0.3 * entry + 0.3 * connectivity + 0.2 * tested + 0.2 * coherence;
  };

  return { callerCount, calleeCount, testCount, isEntryPoint, neighbors, structuralScore, maxConnectivity };
}

function toResult(
  cas: CASOutput,
  node: CASNode,
  graph: GraphSignals,
  scores: NonNullable<SemanticSearchResult['scores']>,
  detail: 'compact' | 'full' = 'compact',
): SemanticSearchResult {
  const risk = (cas.change_risks || []).find(entry => entry.node_id === node.id);
  return {
    node_id: node.id,
    name: node.name,
    qualified_name: node.qualified_name,
    type: node.type,
    framework_role: determineFrameworkRole(cas, node),
    file: node.source?.file,
    score: scores.final,
    // compact (default): drop the semantic/lexical/structural sub-score
    // breakdown and graph_context — diagnostic, not decision-relevant for
    // most calls (docs/SPEC-RESPONSE-BUDGET.md §4). full restores both.
    ...(detail === 'full' ? {
      scores,
      graph_context: {
        caller_count: graph.callerCount(node.id),
        callee_count: graph.calleeCount(node.id),
        test_count: graph.testCount(node.id),
        is_entry_point: graph.isEntryPoint(node.id),
        risk: risk?.risk_level,
      },
    } : {}),
  };
}

function determineFrameworkRole(cas: CASOutput, node: CASNode): string | undefined {
  const decoratorNames = (cas.decorators || [])
    .filter(decorator => decorator.target_node === node.id)
    .map(decorator => decorator.decorator_info.name);

  if (decoratorNames.includes('Controller')) return 'NestJS Controller';
  if (decoratorNames.includes('Injectable')) return 'NestJS Service';
  if (decoratorNames.includes('Entity')) return 'MikroORM/TypeORM Entity';
  if (decoratorNames.includes('Module')) return 'NestJS Module';
  if (decoratorNames.includes('Guard')) return 'NestJS Guard';
  if (decoratorNames.includes('Component')) return 'Vue Component';

  if (node.type === 'functional_component' || node.type === 'class_component') return 'React Component';
  if (node.type === 'custom_hook') return 'React Hook';
  if (node.type === 'api_route') return 'Next.js API Route';
  if (node.type === 'react_page') return 'Next.js Page';
  if (node.type === 'server_component') return 'React Server Component';

  return undefined;
}

function resolveVectorStore(
  projectPath: string,
  cas: CASOutput,
  setting: 'auto' | 'file' | 'pgvector',
  databaseUrlEnv: string,
  dimensions: number,
): VectorStore | null {
  let resolved: 'file' | 'pgvector';
  if (setting === 'auto') {
    // Availability decision, not a "mode": pgvector when a database is configured.
    resolved = process.env[databaseUrlEnv] ? 'pgvector' : 'file';
  } else {
    resolved = setting;
  }

  const indexStore = cas.embedding_index?.store;
  if (indexStore && indexStore !== resolved) {
    resolved = indexStore;
  }

  const fileBaseDir = getProjectStorageDir(projectPath);
  const fileStore = (): VectorStore =>
    createVectorStore({ store: 'file', fileBaseDir, expectedDimensions: dimensions });

  if (resolved !== 'pgvector') {
    return fileStore();
  }

  const pgPool = getPgPool(resolvePgConnectionString(databaseUrlEnv));
  if (!pgPool) {
    return indexStore === 'pgvector' ? null : fileStore();
  }

  try {
    return createVectorStore({
      store: 'pgvector',
      fileBaseDir,
      pgPool,
      expectedDimensions: dimensions,
    });
  } catch {
    return indexStore === 'pgvector' ? null : fileStore();
  }
}

function nodeIndex(cas: CASOutput): Map<string, CASNode> {
  const map = new Map<string, CASNode>();
  for (const node of cas.nodes) map.set(node.id, node);
  return map;
}

function passesFilter(node: CASNode, options: SemanticSearchOptions): boolean {
  if (options.type && node.type !== options.type) return false;
  if (options.category && node.category !== options.category) return false;
  if (options.level !== undefined && node.level !== options.level) return false;
  if (options.types && options.types.length > 0 && !options.types.includes(node.type)) return false;
  if (options.files && options.files.length > 0) {
    const file = node.source?.file ? node.source.file.replace(/\\/g, '/') : '';
    if (!options.files.some(candidate => file.endsWith(candidate.replace(/\\/g, '/')))) return false;
  }
  return true;
}

function rankToScore(rank: number, total: number): number {
  if (total <= 1) return rank === 0 ? 1 : 0;
  return (total - 1 - rank) / (total - 1);
}

// A query "looks like a symbol" when it's a single identifier-shaped token
// (camelCase, PascalCase, snake_case, or a bare word) rather than a natural-
// language phrase. Multi-word phrases ("where are driver status updates
// handled") should keep using pure semantic/hybrid ranking — forcing a name
// tier onto them would defeat the point of semantic search.
function isSymbolLikeQuery(query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(trimmed);
}

// Returns a tier: 3 = exact name/qualified-name match (case-insensitive),
// 2 = name starts with or contains the query as a substring, 1 = the query
// matches one of the node's camelCase/snake_case word tokens exactly,
// 0 = no name-level match at all.
function computeNameMatchTier(node: CASNode, queryLower: string): number {
  const nameLower = node.name.toLowerCase();
  const qualifiedLower = node.qualified_name?.toLowerCase();

  if (nameLower === queryLower || qualifiedLower === queryLower) return 3;

  if (nameLower.startsWith(queryLower) || nameLower.includes(queryLower)) return 2;
  if (qualifiedLower && (qualifiedLower.startsWith(queryLower) || qualifiedLower.includes(queryLower))) return 2;

  const nameWords = splitCamelCaseWords(node.name);
  if (nameWords.includes(queryLower)) return 1;

  return 0;
}

// Stopwords stripped from intent queries before name-coverage matching so
// filler ("the", "for", "reason") and generic retrieval verbs don't count as
// covered/uncovered tokens. "reason" stays IN — it is a load-bearing word for
// decision-gate names like fullRebuildReasonForPreviousOutput.
const QUERY_STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'for', 'to', 'in', 'on', 'and', 'or', 'is', 'are',
  'how', 'where', 'what', 'which', 'when', 'do', 'does', 'this', 'that', 'with',
  'find', 'get', 'show', 'code', 'function', 'method',
]);

// Content tokens of a query: camel/snake-split, lowercased, stopwords and
// 1-char tokens dropped. Used to decide whether a query is "intent-shaped"
// (>= 2 content tokens) and to measure name coverage.
function contentTokens(query: string): string[] {
  return splitCamelCaseWords(query).filter(
    token => token.length > 1 && !QUERY_STOPWORDS.has(token),
  );
}

// Fraction of query content tokens that appear as word tokens of the node's own
// name or qualified name. 1.0 means every query word is present in the name.
function nameTokenCoverage(node: CASNode, queryTokens: Set<string>): number {
  if (queryTokens.size === 0) return 0;
  const nameWords = new Set(splitCamelCaseWords(node.name));
  if (node.qualified_name) {
    for (const word of splitCamelCaseWords(node.qualified_name)) nameWords.add(word);
  }
  let covered = 0;
  for (const token of queryTokens) {
    if (nameWords.has(token)) covered++;
  }
  return covered / queryTokens.size;
}

// Control-flow / decision-gate signal in [0,1]: production (non-test) functions
// and methods whose name reads as orchestration or a rebuild/reuse decision are
// the real "why it runs" entry points an intent query is usually after. Test
// helpers, types, and files that merely reuse the same words score 0 so they
// don't get the extra lift. Deliberately name-shape based (not a keyword
// categorizer of domain concepts): these are structural control-flow verbs.
const CONTROL_FLOW_NAME = /orchestrat|rebuild|reason|decide|decision|resolve|dispatch|coordinat|invalidat|reconcile|schedule|gate|route/i;

function controlFlowNudge(node: CASNode): number {
  if (node.type !== 'function' && node.type !== 'method') return 0;
  const file = node.source?.file ?? '';
  const isTest = /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) || /__tests__|\.test\b/.test(file);
  if (isTest) return 0;
  return CONTROL_FLOW_NAME.test(node.name) ? 1 : 0;
}

function splitCamelCaseWords(str: string): string[] {
  return str
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[-_./]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function clampUnit(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
