jest.unmock('glob');
jest.unmock('fs');
jest.unmock('fs-extra');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { GenericTreeSitterLanguageAnalyzer } from '../../../analyzer/languages/generic-tree-sitter-language-analyzer';

/**
 * Regression for the FOUNDATIONAL INDEX signal-to-noise audit: a single bundled
 * stylesheet (vendored Bootstrap dropped under src/main/resources/static/css/ of
 * a real Java Spring repo) was emitting one `style_rule` node per CSS selector
 * block — 2,708 of them, 69% of the entire node graph, against 229 methods and
 * 11 functions in the actual Java service. No consumer in the codebase reads
 * type==='style_rule' (domain-extractor.ts explicitly treats it as noise to
 * exclude from domain vocabulary), so every one of those nodes was pure cost:
 * node budget, AI batch size, latency, reachability walks, search relevance.
 *
 * Fix: LanguageSpec.aggregateClassNodes collapses classNodeTypes matches for a
 * grammar into ONE node per file (type still honors classNodeLabel) carrying an
 * exact rule_count plus a labeled, capped sample — not a truncation, since the
 * true count is always reported and nothing is silently dropped.
 */
describe('GenericTreeSitterLanguageAnalyzer CSS style_rule aggregation', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'generic-ts-css-agg-'));
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('emits one aggregate style_rule node per stylesheet instead of one per selector', async () => {
    const selectorCount = 50;
    const rules = Array.from({ length: selectorCount }, (_, i) => `.selector-${i} { color: red; }`).join('\n');
    const cssPath = path.join(tmpDir, 'src/main/resources/static/css/vendor.css');
    await fs.ensureDir(path.dirname(cssPath));
    await fs.writeFile(cssPath, rules, 'utf-8');

    const analyzer = new GenericTreeSitterLanguageAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: tmpDir });

    const styleRuleNodes = (contribution.nodes || []).filter(n => n.type === 'style_rule');
    expect(styleRuleNodes.length).toBe(1);

    const aggregate = styleRuleNodes[0];
    expect(aggregate.metadata?.attributes?.rule_count).toBe(selectorCount);
    expect(Array.isArray(aggregate.metadata?.attributes?.sample_selectors)).toBe(true);
    expect((aggregate.metadata?.attributes?.sample_selectors as string[]).length).toBeLessThanOrEqual(20);
    expect(aggregate.metadata?.attributes?.sample_is_partial).toBe(true);
  });

  it('does not aggregate ordinary class-emitting grammars (no regression for non-flagged languages)', async () => {
    const luaPath = path.join(tmpDir, 'widgets.lua');
    await fs.writeFile(
      luaPath,
      [
        'local Widget = {}',
        'function Widget:new() end',
        'local Gadget = {}',
        'function Gadget:new() end',
        ''
      ].join('\n'),
      'utf-8'
    );

    const analyzer = new GenericTreeSitterLanguageAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: tmpDir });

    const functionNodes = (contribution.nodes || []).filter(n => n.type === 'function');
    expect(functionNodes.length).toBeGreaterThanOrEqual(2);
  });
});
