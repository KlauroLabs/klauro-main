jest.unmock('fs-extra');
jest.unmock('fs');
jest.unmock('glob');

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { GoAnalyzer } from '../../analyzer/languages/go-analyzer';
import { assignNodeRoles } from '../../analyzer/core/node-roles';
import { selectProductFrameworkNames, analyzerTypeMap } from '../../analyzer/core/framework-comprehension';
import { CASEntryPoint, CASNode } from '../../types/cas.types';

/**
 * Confirmed defect: a Go app that genuinely uses a third-party web framework
 * (gin/echo/gorilla/fiber) reported `frameworks: []`, indistinguishable from a
 * stdlib-only app. Two causes:
 *   1. GoAnalyzer's detectFrameworkPatterns stamped `metadata.framework` only
 *      onto the synthetic `${framework}_handler` entry point it creates, never
 *      onto the underlying CASNode — but selectProductFrameworkNames only ever
 *      reads `node.metadata?.framework` off CAS NODES.
 *   2. Even with the node stamped, selectProductFrameworkNames additionally
 *      requires application-surface evidence (route/controller/... `type`, or
 *      now `role`) on that SAME node, and requires the contributing analyzer
 *      to be registered `type: 'framework'` — GoAnalyzer is registered
 *      `type: 'language'` (there is no separate gin/echo/gorilla/fiber
 *      framework analyzer), so a bare node-level stamp still would not have
 *      surfaced without the language-analyzer + surface-evidence admission
 *      path added to selectProductFrameworkNames.
 *
 * This test runs the REAL GoAnalyzer + assignNodeRoles +
 * selectProductFrameworkNames pipeline (the same real-node resolution pattern
 * node-roles.test.ts's "FRAMEWORK-LESS (real GoAnalyzer)" case and
 * paradigm-conformance-framework-less-go.test.ts already use) against two
 * fixtures:
 *   - a real gin app                → 'gin' MUST appear.
 *   - a hand-rolled net/http router → frameworks MUST stay [] (the owner's
 *     explicitly verified non-bug: a stdlib-only Go app must never start
 *     reporting a framework).
 */
describe('Go framework surface reaches system.technologies.frameworks', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-go-framework-surface-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const isProductNode = (node: { source?: { file?: string } }): boolean => {
    const file = String(node.source?.file || '');
    return Boolean(file) && !/(^|\/)(fixtures?|__fixtures__|testdata|__tests__|tests?|spec)(\/|$)/.test(file);
  };

  /** GoAnalyzer's own http-route extraction attaches `source_node` to the FILE
   *  node; production resolves this to the real handler function via
   *  orchestrator.ts's linkRouteHandlers, which runs before both
   *  assignNodeRoles and framework-comprehension. Mirrored here exactly like
   *  the existing node-roles.test.ts / paradigm-conformance-framework-less-go
   *  regression tests do, against real (non-mocked) GoAnalyzer output. */
  function resolveHttpEntryPoints(
    entryPoints: CASEntryPoint[],
    handlerByPath: Record<string, string>,
    functionNodesByName: Map<string, CASNode>,
  ): CASEntryPoint[] {
    return entryPoints.map(ep => {
      if (ep.type !== 'http' || !ep.trigger?.path) return ep;
      const handlerName = handlerByPath[ep.trigger.path];
      const handlerNode = handlerName ? functionNodesByName.get(handlerName) : undefined;
      if (!handlerNode) return ep;
      return { ...ep, source_node: handlerNode.id, handler: { ...(ep as any).handler, node_id: handlerNode.id } };
    });
  }

  it('a real gin app: frameworks includes gin', async () => {
    const goSource = `package main

import "github.com/gin-gonic/gin"

func fetchWidgetSummary(c *gin.Context) {
	c.JSON(200, gin.H{"summary": true})
}

func dumpWidgetRows(c *gin.Context) {
	c.JSON(200, gin.H{"rows": []string{}})
}

func main() {
	r := gin.Default()
	r.GET("/widgets/summary", fetchWidgetSummary)
	r.GET("/widgets/dump", dumpWidgetRows)
	r.Run(":8080")
}
`;
    fs.writeFileSync(path.join(root, 'main.go'), goSource);

    const analyzer = new GoAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: root, existingAnalysis: [] } as any);

    const nodes: CASNode[] = contribution.nodes || [];
    const edges = contribution.edges || [];
    const functionNodesByName = new Map(nodes.filter(n => n.type === 'function').map(n => [n.name, n]));

    // Sanity: detectFrameworkPatterns' handler-signature evidence actually
    // fired on the real analyzer output.
    expect(functionNodesByName.get('fetchWidgetSummary')?.metadata?.framework).toBe('gin');
    expect(functionNodesByName.get('dumpWidgetRows')?.metadata?.framework).toBe('gin');

    const handlerByPath: Record<string, string> = {
      '/widgets/summary': 'fetchWidgetSummary',
      '/widgets/dump': 'dumpWidgetRows',
    };
    const resolvedEntryPoints = resolveHttpEntryPoints(
      contribution.entry_points || [],
      handlerByPath,
      functionNodesByName,
    );

    assignNodeRoles({
      nodes,
      edges,
      entry_points: resolvedEntryPoints,
      exit_points: contribution.exit_points || [],
    });

    const contributions = [{ analyzer_id: 'go', analyzer_type: 'language', analyzer_name: 'Go Analyzer' }];
    const frameworks = selectProductFrameworkNames(
      nodes as any,
      edges as any,
      analyzerTypeMap(contributions),
      isProductNode,
      8,
    );

    expect(frameworks).toContain('gin');
  });

  it('REGRESSION GUARD: a hand-rolled net/http router (no third-party framework) stays frameworks: []', async () => {
    const goSource = `package main

import "net/http"

func fetchWidgetSummary(w http.ResponseWriter, r *http.Request) {}
func dumpWidgetRows(w http.ResponseWriter, r *http.Request) {}

func main() {
	http.HandleFunc("GET /widgets/summary", fetchWidgetSummary)
	http.HandleFunc("GET /widgets/dump", dumpWidgetRows)
	http.ListenAndServe(":8080", nil)
}
`;
    fs.writeFileSync(path.join(root, 'main.go'), goSource);

    const analyzer = new GoAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: root, existingAnalysis: [] } as any);

    const nodes: CASNode[] = contribution.nodes || [];
    const edges = contribution.edges || [];
    const functionNodesByName = new Map(nodes.filter(n => n.type === 'function').map(n => [n.name, n]));

    // Sanity: no node anywhere carries a framework tag — detectFrameworkPatterns
    // must not fire on plain net/http signatures.
    expect(nodes.some(n => n.metadata?.framework && n.metadata.framework !== 'go')).toBe(false);

    const handlerByPath: Record<string, string> = {
      '/widgets/summary': 'fetchWidgetSummary',
      '/widgets/dump': 'dumpWidgetRows',
    };
    const resolvedEntryPoints = resolveHttpEntryPoints(
      contribution.entry_points || [],
      handlerByPath,
      functionNodesByName,
    );

    assignNodeRoles({
      nodes,
      edges,
      entry_points: resolvedEntryPoints,
      exit_points: contribution.exit_points || [],
    });

    // The file DOES get a structural controller role (2+ route handlers via
    // containment) — that role assignment is correct and must stay; it is
    // NOT, by itself, evidence of a third-party framework.
    const fileNode = nodes.find(n => n.type === 'file');
    expect(fileNode?.role).toBe('controller');

    const contributions = [{ analyzer_id: 'go', analyzer_type: 'language', analyzer_name: 'Go Analyzer' }];
    const frameworks = selectProductFrameworkNames(
      nodes as any,
      edges as any,
      analyzerTypeMap(contributions),
      isProductNode,
      8,
    );

    expect(frameworks).toEqual([]);
  });
});
