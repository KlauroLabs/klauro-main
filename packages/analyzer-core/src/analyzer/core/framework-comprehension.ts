// COMPREHENSION framework selection — the single evidence-based gate that decides
// which frameworks may appear in the AI description / narrative and in the
// summary.frameworks field the description cites. See
// docs/cas/DETERMINISM-BOUNDARY.md (facts vs comprehension) and
// docs/SEMANTIC-MODEL.md.
//
// The structural `metadata.framework` field is OVERLOADED: language analyzers
// stamp language/tooling names ("typescript/javascript ast", "python language",
// "dockerfile"), library analyzers stamp CATEGORY labels ("authentication and
// authorization", "validation schema contract", "observability instrumentation"),
// and framework analyzers stamp real framework names (react, fastapi, django).
// The structural inventory (system.technologies.frameworks) MAY keep the raw mix,
// but the COMPREHENSION list — what the customer-facing description asserts the
// system "is built with" — must be only frameworks the system is genuinely built
// ON. Three live dogfood defects motivated this gate:
//   - Klauro (a TypeScript monorepo) described itself as built with "django and
//     fastapi" — those came from Python test FIXTURES and from the klauro-sdk-py
//     telemetry SDK's ADAPTER middleware (KlauroDjangoMiddleware / an ASGI shim),
//     i.e. integrations Klauro ships FOR those frameworks, not frameworks it runs.
//   - Category labels ("authentication and authorization", "validation schema
//     contract") leaked in as "frameworks".
//
// The gate is three deterministic Camp-B facts, no brand/keyword hardcoding:
//   1. framework-type analyzer  — only analyzers registered as `framework`
//      contribute a framework NAME (drops language tags and library category
//      labels; those belong to system.technologies, not the "built with" list).
//   2. primary product path     — the framework must be evidenced OUTSIDE
//      test/fixture paths (drops fixture-only django/fastapi/flask sample apps).
//   3. application surface       — the framework must be evidenced by at least one
//      real application-surface node (a route/component/page/app/…), not merely an
//      adapter shim (a lone `middleware`/`module`/`class`/`method`). A system that
//      is BUILT ON fastapi exposes routes/an app; one that merely ships a fastapi
//      adapter exposes only middleware. This is what separates react (33 components
//      + a react_app) from the SDK's fastapi/django adapter shims.

/**
 * Node types that constitute a real framework APPLICATION SURFACE — evidence that
 * the system is built ON the framework, not merely integrating with it. Kept broad
 * enough to cover the common web/UI/backend framework analyzers (routes, endpoints,
 * controllers, components, pages, views, resolvers, scheduled entry points). Adapter
 * shims (middleware/module/class/method/function/config/import/…) are intentionally
 * excluded. Extend this set when a new framework analyzer emits a new surface type;
 * the gauntlet fixtures (real apps) guard against over-tightening.
 */
export const FRAMEWORK_APPLICATION_SURFACE_TYPES = new Set<string>([
  'application', 'app',
  'react_app', 'functional_component', 'class_component', 'component',
  'hook_usage', 'page', 'layout',
  'route', 'endpoint', 'api_endpoint', 'http_endpoint', 'graphql_endpoint',
  'controller', 'view', 'resolver', 'graphql_resolver',
  'websocket', 'gateway', 'island', 'server_component',
]);

/**
 * CASNode.role values (see node-roles.ts / NODE_ROLES in cas.types.ts) that
 * are themselves evidence of a real framework application surface, even when
 * the node's `type` never made it into FRAMEWORK_APPLICATION_SURFACE_TYPES.
 * `role` exists precisely to express "this node is a controller/resolver/
 * gateway" without overloading `type`, language-agnostically — a Go
 * `net/http`-family file grouping several route handlers gets `role:
 * 'controller'` from node-roles.ts's structural grouping rule the same way a
 * `@Controller` class does, but its node.type stays plain `file`/`function`.
 * `middleware`/`guard`/`migration`/`scheduled-job`/`event-listener` are
 * deliberately excluded — those are wrapping/scheduling positions, not "the
 * system is built ON this" surface evidence, mirroring the exclusions
 * FRAMEWORK_APPLICATION_SURFACE_TYPES already makes for middleware/module.
 */
export const FRAMEWORK_APPLICATION_SURFACE_ROLES = new Set<string>(['controller', 'resolver', 'gateway']);

const CONTAINMENT_EDGE_TYPES = new Set(['contains', 'has_method', 'declares']);

interface FrameworkEvidenceNode {
  id?: string;
  type?: string;
  role?: string;
  parent?: string;
  metadata?: { framework?: unknown } & Record<string, unknown>;
  source?: { file?: string };
  analyzers?: string[];
}

interface FrameworkEvidenceEdge {
  type?: string;
  source?: string;
  target?: string;
}

/**
 * Real application-surface evidence for a framework-tagged node: either the
 * node's own `type`/`role`, or — the Go net/http-family shape — the `role` of
 * the node that structurally OWNS it (its containing file/struct/class, via
 * `node.parent` or a `contains`/`has_method`/`declares` edge). A gin/echo/
 * gorilla/fiber handler function is tagged with `metadata.framework` on the
 * FUNCTION node (see go-analyzer.ts detectFrameworkPatterns), but node-roles.ts
 * assigns `role: 'controller'` to the FILE that groups >=2 such handlers, not
 * to the handlers themselves (matching "@Controller and Go's http.HandleFunc
 * must resolve to the same role" — the grouping owner is the controller, the
 * per-handler role already lives at CASEntryPoint.type). Without the owner
 * lookup, a genuinely gin/echo/gorilla/fiber-built Go app would still fail
 * this gate: its handler nodes carry the framework tag but never the surface
 * type/role themselves.
 */
function hasApplicationSurfaceEvidence(
  node: FrameworkEvidenceNode,
  nodesById: Map<string, FrameworkEvidenceNode>,
  edges: FrameworkEvidenceEdge[],
): boolean {
  if (node.type && FRAMEWORK_APPLICATION_SURFACE_TYPES.has(node.type)) return true;
  if (node.role && FRAMEWORK_APPLICATION_SURFACE_ROLES.has(node.role)) return true;
  if (!node.id) return false;
  const ownerId = node.parent
    ?? (Array.isArray(edges) ? edges : []).find(e => e.type && CONTAINMENT_EDGE_TYPES.has(e.type) && e.target === node.id)?.source;
  if (!ownerId) return false;
  const owner = nodesById.get(ownerId);
  return Boolean(owner?.role && FRAMEWORK_APPLICATION_SURFACE_ROLES.has(owner.role));
}

/**
 * The comprehension framework list from raw CAS nodes.
 *
 * @param nodes             all CAS nodes.
 * @param edges             all CAS edges — only used to resolve a node's
 *                          structural OWNER for the role-inherited surface
 *                          check (see hasApplicationSurfaceEvidence).
 * @param analyzerTypeById  analyzer_id -> analyzer_type (from analyzer_contributions);
 *                          used to admit `framework`-type analyzers unconditionally,
 *                          and `language`-type analyzers ONLY when the node itself
 *                          carries real application-surface evidence (see rule 1
 *                          below — this is what lets Go's gin/echo/gorilla/fiber
 *                          detection, which lives inside the language analyzer
 *                          rather than a dedicated framework analyzer, surface at
 *                          all, without reopening the door for language/category
 *                          labels: those never land on a surface node or role).
 * @param isProductNode     product-path predicate (test/fixture nodes excluded).
 * @param limit             cap on returned names.
 */
export function selectProductFrameworkNames(
  nodes: FrameworkEvidenceNode[],
  edges: FrameworkEvidenceEdge[],
  analyzerTypeById: Map<string, string>,
  isProductNode: (node: FrameworkEvidenceNode) => boolean,
  limit = 10,
): string[] {
  const nodesById = new Map(nodes.filter(n => n.id).map(n => [n.id as string, n] as const));
  // framework name -> whether any product framework-analyzer node is an app surface.
  const surfaceByFramework = new Map<string, boolean>();
  const firstSeenOrder: string[] = [];

  for (const node of nodes) {
    const framework = normalizeFrameworkName(node.metadata?.framework);
    if (!framework) continue;
    const analyzers = Array.isArray(node.analyzers) ? node.analyzers : [];
    const analyzerTypes = analyzers.map(id => analyzerTypeById.get(id));
    const surfaceEvidence = hasApplicationSurfaceEvidence(node, nodesById, edges);
    // (1) a framework-type analyzer always defines a framework name; a
    // language-type analyzer (one that detects framework usage internally
    // rather than through a sibling framework analyzer, e.g. GoAnalyzer's
    // gin/echo/gorilla/fiber handler-signature detection) defines one only
    // when its own node is already a genuine application surface — a bare
    // language/category tag never satisfies that, only real route/controller/
    // resolver/gateway evidence does.
    const isFrameworkAnalyzer = analyzerTypes.includes('framework');
    const isSurfacedLanguageAnalyzer = analyzerTypes.includes('language') && surfaceEvidence;
    if (!isFrameworkAnalyzer && !isSurfacedLanguageAnalyzer) continue;
    // (2) product-path evidence only.
    if (!isProductNode(node)) continue;

    if (!surfaceByFramework.has(framework)) {
      surfaceByFramework.set(framework, false);
      firstSeenOrder.push(framework);
    }
    // (3) real application surface (vs adapter shim).
    if (surfaceEvidence) {
      surfaceByFramework.set(framework, true);
    }
  }

  return firstSeenOrder
    .filter(framework => surfaceByFramework.get(framework))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, limit);
}

/**
 * Build the analyzer_id -> analyzer_type lookup from CAS analyzer contributions.
 */
export function analyzerTypeMap(
  contributions: Array<{ analyzer_id?: string; analyzer_type?: string; contribution_type?: string }> = [],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const contribution of contributions) {
    const id = contribution.analyzer_id;
    if (!id) continue;
    const type = contribution.analyzer_type || contribution.contribution_type;
    if (type) map.set(id, type);
  }
  return map;
}

function normalizeFrameworkName(value: unknown): string {
  const name = String(value ?? '')
    .trim()
    .replace(/\s*analyzer$/i, '')
    .replace(/^enhanced\s+/i, '')
    .trim();
  if (!name) return '';
  // A framework name must not be an analyzer/language/AST artifact label.
  if (/\b(language|ast|analyzer)\b/i.test(name)) return '';
  return name;
}
