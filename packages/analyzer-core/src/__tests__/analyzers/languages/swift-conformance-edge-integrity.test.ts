jest.unmock('fs-extra');
jest.unmock('fs');
jest.unmock('glob');

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SwiftAnalyzer } from '../../../analyzer/languages/swift-analyzer';
import { checkEdgeReferentialIntegrity } from '../../../analyzer/core/graph-referential-integrity';
import type { AnalysisContext } from '../../../analyzer/core/base-analyzer';
import type { CASEdge } from '../../../types/cas.types';

/**
 * THE INVARIANT UNDER TEST: every edge endpoint the Swift analyzer emits
 * resolves in nodes ∪ entry_points ∪ exit_points.
 *
 * THE REGRESSION IT PINS. `extension X: P` is the idiomatic Swift way to
 * declare a conformance, and an extension is NOT a new type — the analyzer
 * emits no node for it and re-parents its members onto X's canonical
 * declaration. The conformance edge, however, keyed its SOURCE off the
 * extension's own `lineStart`, so it named `type_X_<extensionLine>` while the
 * only node emitted was `type_X_<declarationLine>`. Measured on a real
 * multi-language repository, exactly 3 of 136,398 edges dangled and all 3 were
 * Swift `implements` edges of this shape, each missing its source.
 */
describe('swift conformance edges resolve to emitted nodes', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-conformance-integrity-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const write = (relative: string, content: string) => {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };

  const analyze = async () => {
    const analyzer = new SwiftAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: root } as AnalysisContext);
    return {
      nodes: contribution.nodes ?? [],
      edges: contribution.edges ?? [],
      entry_points: contribution.entry_points ?? [],
      exit_points: contribution.exit_points ?? [],
    };
  };

  const conformanceEdges = (edges: CASEdge[]) =>
    edges.filter(e => e.type === 'implements' || e.type === 'extends');

  it('emits an implements edge whose endpoints both resolve, for a direct conformance', async () => {
    write(
      'Sources/App/Location.swift',
      `import Foundation

protocol LocationServicing {
    func start()
}

final class LocationService: LocationServicing {
    func start() {}
}
`
    );

    const { nodes, edges, entry_points, exit_points } = await analyze();
    const implementsEdges = conformanceEdges(edges);
    expect(implementsEdges).toHaveLength(1);
    expect(implementsEdges[0].type).toBe('implements');

    const report = checkEdgeReferentialIntegrity(edges, { nodes, entry_points, exit_points });
    expect(report.samples).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('resolves the source through the canonical declaration when the conformance is declared on an extension', async () => {
    write(
      'Sources/App/Camera.swift',
      `import Foundation

protocol CameraServicing {
    func start()
}

final class CameraController {
    private var running = false
}

extension CameraController: CameraServicing {
    func start() {
        running = true
    }
}
`
    );

    const { nodes, edges, entry_points, exit_points } = await analyze();

    const implementsEdges = conformanceEdges(edges);
    expect(implementsEdges).toHaveLength(1);
    const edge = implementsEdges[0];

    // The source must be the id of the node that was actually emitted for the
    // class — the canonical declaration — not the extension's line.
    const classNode = nodes.find(n => n.name === 'CameraController');
    const protocolNode = nodes.find(n => n.name === 'CameraServicing');
    expect(classNode).toBeDefined();
    expect(protocolNode).toBeDefined();
    expect(edge.source).toBe(classNode!.id);
    expect(edge.target).toBe(protocolNode!.id);

    const report = checkEdgeReferentialIntegrity(edges, { nodes, entry_points, exit_points });
    expect(report.samples).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('resolves the source when the extension declaring the conformance lives in another file', async () => {
    write(
      'Sources/App/ScreenRecordService.swift',
      `import Foundation

final class ScreenRecordService {
    private var recording = false
}
`
    );
    write(
      'Sources/App/ScreenRecordingServicing.swift',
      `import Foundation

protocol ScreenRecordingServicing {
    func begin()
}
`
    );
    write(
      'Sources/App/ScreenRecordService+Recording.swift',
      `import Foundation

extension ScreenRecordService: ScreenRecordingServicing {
    func begin() {
        recording = true
    }
}
`
    );

    const { nodes, edges, entry_points, exit_points } = await analyze();

    const implementsEdges = conformanceEdges(edges);
    expect(implementsEdges).toHaveLength(1);
    const edge = implementsEdges[0];
    const classNode = nodes.find(n => n.name === 'ScreenRecordService');
    expect(classNode).toBeDefined();
    expect(edge.source).toBe(classNode!.id);

    const report = checkEdgeReferentialIntegrity(edges, { nodes, entry_points, exit_points });
    expect(report.samples).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('does not emit a duplicate edge when the same conformance is declared twice', async () => {
    write(
      'Sources/App/Feed.swift',
      `import Foundation

protocol FeedServicing {
    func refresh()
}

final class FeedService: FeedServicing {
    func refresh() {}
}

extension FeedService: FeedServicing {
    func reload() {}
}
`
    );

    const { nodes, edges, entry_points, exit_points } = await analyze();
    expect(conformanceEdges(edges)).toHaveLength(1);

    const report = checkEdgeReferentialIntegrity(edges, { nodes, entry_points, exit_points });
    expect(report.ok).toBe(true);
  });
});
