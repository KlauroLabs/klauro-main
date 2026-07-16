jest.unmock('fs');
jest.unmock('fs-extra');
jest.unmock('glob');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { cachedGlob as glob } from '../../analyzer/core/glob-cache';
import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';
import { BaseAnalyzer, AnalysisContext, CASContribution } from '../../analyzer/core/base-analyzer';

/**
 * Test-only framework analyzer standing in for a real desktop-UI framework
 * analyzer (WPF, Blazor, ...): it recursively globs `**\/*.cs` from whatever
 * root it's given and emits one `widget` node per file carrying a
 * `WIDGET_MARKER: <Name>` comment. This mirrors WPFAnalyzer's own recursive
 * `**\/*.cs` / `**\/*.xaml` globs — both are analyzers whose real evidence can
 * legitimately be scattered across SEVERAL nested, independently-manifested
 * subdirectories of one cohesive product (a multi-project .NET solution;
 * here, a fake multi-module "widget" product with the same shape).
 */
class WidgetAnalyzer extends BaseAnalyzer {
  constructor() {
    super('widget', 'Widget Framework Analyzer (test double)', '1.0.0', 'framework');
  }

  async canAnalyze(projectPath: string): Promise<boolean> {
    const files = await glob(['**/*.cs'], { cwd: projectPath, nodir: true });
    for (const file of files) {
      const content = await fs.readFile(path.join(projectPath, file), 'utf-8');
      if (/WIDGET_MARKER/.test(content)) return true;
    }
    return false;
  }

  async analyze(context: AnalysisContext): Promise<CASContribution> {
    const files = await glob(['**/*.cs'], { cwd: context.projectPath, nodir: true });
    const nodes = [];
    for (const file of files) {
      const content = await fs.readFile(path.join(context.projectPath, file), 'utf-8');
      const match = /WIDGET_MARKER:\s*(\w+)/.exec(content);
      if (!match) continue;
      const name = match[1];
      nodes.push(
        this.createNodeBuilder(this.generateId('widget', file, name), name, 'widget')
          .withLevel(3, this.getLevelName(3))
          .withSource({ file: path.join(context.projectPath, file), line: 1 })
          .withAnalyzers([this.analyzerId], this.analyzerId)
          .build()
      );
    }
    return this.createContribution(nodes, [], [], []);
  }

  protected getLevelName(_level: number): string {
    return 'component';
  }

  protected getCapabilities(): string[] {
    return ['widget_detection'];
  }
}

function createPipelineOrchestrator(): AnalyzerOrchestrator {
  const orchestrator = new AnalyzerOrchestrator();
  orchestrator.registerAnalyzer({
    id: 'widget',
    name: 'Widget Framework Analyzer (test double)',
    type: 'framework',
    version: '1.0.0',
    detectPatterns: {
      files: ['**/*.cs'],
      content: [/WIDGET_MARKER/],
    },
    analyzer: new WidgetAnalyzer(),
  });
  return orchestrator;
}

/**
 * Regression test for the WPF-on-Hoggan bug: a framework analyzer's real
 * evidence is spread across MULTIPLE nested, independently-manifested
 * subdirectories of one product (e.g. HogganScientific's WPF UI split across
 * several *.csproj-owning subprojects). `shouldUseAnalyzer` used to bind the
 * analyzer to only the FIRST matching nested root (longest-path-first) and
 * stop there; even once it did check the encompassing top-level root,
 * `getAnalyzerScopeFilters` walled off every other nested manifest-owning
 * directory on the (false, for this single-root-per-registration
 * architecture) assumption that some OTHER dedicated pass would cover them —
 * so a multi-module framework's contribution collapsed to whichever single
 * module happened to be discovered first, or to nothing at all.
 *
 * Fix (orchestrator.ts): `shouldUseAnalyzer` now checks the top-level
 * projectPath FIRST (every canAnalyze()/detectPatterns check in this
 * codebase globs recursively, so a signal found in any nested root is also
 * found from the top), and `getAnalyzerScopeFilters` is a no-op when the
 * matched root IS the top-level projectPath, since no other pass exists to
 * pick up what it would otherwise exclude.
 */
describe('framework analyzer whose evidence spans multiple nested manifest roots', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-multi-root-widget-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const write = async (relative: string, content: string) => {
    const full = path.join(root, relative);
    await fs.ensureDir(path.dirname(full));
    await fs.writeFile(full, content);
  };

  it('scans widget markers from EVERY nested project module, not just the first one found', async () => {
    // Three independently-manifested modules, each owning its own widget —
    // simulating a multi-project .NET solution where the WPF UI is split
    // across several *.csproj directories.
    await write('moduleA/package.json', JSON.stringify({ name: 'module-a' }));
    await write('moduleA/WidgetA.cs', '// WIDGET_MARKER: WidgetA\nclass WidgetA {}\n');

    await write('moduleB/package.json', JSON.stringify({ name: 'module-b' }));
    await write('moduleB/WidgetB.cs', '// WIDGET_MARKER: WidgetB\nclass WidgetB {}\n');

    await write('moduleC/package.json', JSON.stringify({ name: 'module-c' }));
    await write('moduleC/WidgetC.cs', '// WIDGET_MARKER: WidgetC\nclass WidgetC {}\n');

    const orchestrator = createPipelineOrchestrator();
    const output = await orchestrator.orchestrateAnalysis(root);

    const widgetNodes = (output.nodes || []).filter(n => n.type === 'widget');
    const widgetNames = widgetNodes.map(n => n.name).sort();

    // The pre-fix behavior bound the analyzer to a SINGLE nested root (or
    // dropped everything via the scope-filter exclusion), surfacing at most
    // one widget. All three must survive to the final CAS.
    expect(widgetNames).toEqual(['WidgetA', 'WidgetB', 'WidgetC']);
  }, 30_000);

  it('still isolates a sibling app when the analyzer legitimately only matches ONE nested root', async () => {
    // moduleA has the marker; moduleB is an unrelated sibling with its own
    // manifest and NO marker. The analyzer must not fabricate a widget node
    // for moduleB, and the narrow-root isolation path (matchedRoot !==
    // projectPath) must still be reachable/correct.
    await write('moduleA/package.json', JSON.stringify({ name: 'module-a' }));
    await write('moduleA/WidgetA.cs', '// WIDGET_MARKER: WidgetA\nclass WidgetA {}\n');

    await write('moduleB/package.json', JSON.stringify({ name: 'module-b' }));
    await write('moduleB/Plain.cs', 'class Plain {}\n');

    const orchestrator = createPipelineOrchestrator();
    const output = await orchestrator.orchestrateAnalysis(root);

    const widgetNodes = (output.nodes || []).filter(n => n.type === 'widget');
    expect(widgetNodes.map(n => n.name)).toEqual(['WidgetA']);
  }, 30_000);
});
