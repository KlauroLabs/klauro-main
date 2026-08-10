jest.unmock('fs-extra');
jest.unmock('fs');
jest.unmock('glob');

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { GoAnalyzer } from '../../analyzer/languages/go-analyzer';
import { buildParadigmConformance } from '../../analyzer/core/paradigm-conformance';
import { CASEdge, CASExitPoint } from '../../types/cas.types';

/**
 * Tier 2 GAP FIX regression (§6.4 / STOCK-TAKE-TIERS.md): paradigm-conformance
 * used to seed its comparable-entry pool via Controller/Repository NAME-SUFFIX
 * regexes only, so an idiomatic, framework-less Go net/http handler (no
 * "Controller" suffix — exactly the shape that misclassified in the
 * determineSystemType defect this same repo already fixed once) was invisible
 * to paradigm detection no matter what it did. This test runs the REAL
 * GoAnalyzer against plain net/http handlers with deliberately
 * non-conventional names, then feeds its real entry-point/node output into
 * buildParadigmConformance to prove the handlers are now included in the
 * comparable pool via the structural entry-point-type fallback, not a name.
 *
 * GoAnalyzer's own route extraction attaches each entry point's
 * `handler.node_id` to the FILE node (the per-function resolution is a
 * separate orchestrator pass, `linkRouteHandlers`, run later in the full
 * pipeline and untouched by this change). This test performs that same
 * name-based resolution inline against the REAL function nodes GoAnalyzer
 * produced, rather than pulling in the whole orchestrator, so the object
 * under test — paradigm-conformance's entry-layer membership — is exercised
 * against real, non-mocked node/entry-point shapes.
 */
describe('paradigm-conformance includes framework-less Go net/http handlers', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-go-paradigm-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('treats plain-named net/http handlers as entry-layer nodes', async () => {
    const goSource = `package main

import "net/http"

func fetchWidgetSummary(w http.ResponseWriter, r *http.Request) {
	svc := WidgetService{}
	svc.Summarize(w, r)
}

func dumpWidgetRows(w http.ResponseWriter, r *http.Request) {
	// deviant: touches the database directly instead of going through a service
	queryWidgetsDirectly()
}

func listWidgetOrders(w http.ResponseWriter, r *http.Request) {
	svc := WidgetService{}
	svc.Summarize(w, r)
}

func archiveWidgetBatch(w http.ResponseWriter, r *http.Request) {
	svc := WidgetService{}
	svc.Summarize(w, r)
}

func main() {
	http.HandleFunc("GET /widgets/summary", fetchWidgetSummary)
	http.HandleFunc("GET /widgets/dump", dumpWidgetRows)
	http.HandleFunc("GET /widgets/orders", listWidgetOrders)
	http.HandleFunc("GET /widgets/archive", archiveWidgetBatch)
	http.ListenAndServe(":8080", nil)
}
`;
    fs.writeFileSync(path.join(root, 'main.go'), goSource);

    const analyzer = new GoAnalyzer();
    const context = { projectPath: root, existingAnalysis: [] } as any;
    const contribution = await analyzer.analyze(context);

    const httpEntryPoints = (contribution.entry_points || []).filter(ep => ep.type === 'http');
    // Sanity: the framework-less handlers really were extracted as http entry
    // points by the real analyzer, none of them named "*Controller".
    expect(httpEntryPoints.length).toBeGreaterThanOrEqual(4);
    expect(httpEntryPoints.some(ep => /controller/i.test(ep.name))).toBe(false);

    const functionNodesByName = new Map(
      (contribution.nodes || []).filter(n => n.type === 'function').map(n => [n.name, n]),
    );
    // Route -> handler function name, read straight from the source this test
    // wrote (mirrors what orchestrator.ts's linkRouteHandlers resolves via
    // the captured handler reference at the real HandleFunc call site).
    const handlerByPath: Record<string, string> = {
      '/widgets/summary': 'fetchWidgetSummary',
      '/widgets/dump': 'dumpWidgetRows',
      '/widgets/orders': 'listWidgetOrders',
      '/widgets/archive': 'archiveWidgetBatch',
    };

    const resolvedEntryPoints = (contribution.entry_points || []).map(ep => {
      if (ep.type !== 'http' || !ep.trigger?.path) return ep;
      const handlerName = handlerByPath[ep.trigger.path];
      const handlerNode = handlerName ? functionNodesByName.get(handlerName) : undefined;
      if (!handlerNode) return ep;
      return { ...ep, source_node: handlerNode.id, handler: { ...ep.handler, node_id: handlerNode.id } };
    });

    const resolvedHttp = resolvedEntryPoints.filter(ep => ep.type === 'http');
    for (const ep of resolvedHttp) {
      const node = functionNodesByName.get(handlerByPath[ep.trigger!.path!]);
      expect(node).toBeDefined();
      // None of the real handler nodes match the OOP Controller/Repository
      // suffix convention — this is exactly the framework-less case.
      expect(/(Controller|Resolver|Gateway)$/.test(node!.name)).toBe(false);
    }

    // Synthesize the surrounding call/write edges paradigm-conformance reads
    // (WidgetService / direct-db-access) on top of the REAL analyzer nodes —
    // this is the tier-2 pass combining tier-1 facts, not mocking tier 1.
    const serviceNodeId = 'synthetic_widget_service';
    const edges: CASEdge[] = [];
    const exitPoints: CASExitPoint[] = [];
    for (const ep of resolvedHttp) {
      const ownerId = ep.source_node;
      const handlerName = handlerByPath[ep.trigger!.path!];
      if (handlerName === 'dumpWidgetRows') {
        exitPoints.push({
          id: `exit_db_${ownerId}`,
          source_node: ownerId,
          type: 'database',
          name: 'direct widget query',
        } as CASExitPoint);
      } else {
        edges.push({ id: `call_${ownerId}`, source: ownerId, target: serviceNodeId, type: 'calls' } as CASEdge);
      }
    }
    const nodes = [
      ...(contribution.nodes || []),
      { id: serviceNodeId, name: 'WidgetService', type: 'class', category: 'code' } as any,
    ];

    const paradigms = buildParadigmConformance({
      nodes,
      edges,
      entryPoints: resolvedEntryPoints as any,
      exitPoints,
    });

    const serviceMediated = paradigms.find(p => p.paradigm === 'service-mediated-data-access');
    expect(serviceMediated).toBeDefined();
    // The framework-less handlers (fetchWidgetSummary etc.) must have been
    // COMPARABLE at all — impossible before this fix, since none of them
    // matched a Controller/Repository name convention.
    expect(serviceMediated!.adoption.comparable_count).toBeGreaterThanOrEqual(4);
    expect(serviceMediated!.adoption.following_count).toBeGreaterThanOrEqual(3);
    // The deviant (direct DB access, no service hop) must be cited by name.
    expect(serviceMediated!.deviations.some(d => /dumpWidgetRows/.test(d.detail))).toBe(true);
  });
});
