import { assertAnalysisVersionSupported, describeAnalysisVersion } from './storage';
import { buildSummary, getDataLineage, getParadigmConformance, getProductMap, getUserJourneys } from './query';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';

export interface VersionSkewCheck {
  id: string;
  question: string;
  invariant: string;
  observed: string;
  status: 'pass' | 'fail';
}

export function buildVersionSkewFixture(casVersion: string): CASOutput {
  return {
    cas_version: casVersion,
    analysis_timestamp: new Date().toISOString(),
    analysis_id: `analysis-version-skew-${casVersion}`,
    system: { id: 'version-skew', name: 'version-skew-fixture', type: 'service', root_path: '/tmp/version-skew' },
    nodes: [
      { id: 'node-a', type: 'function', name: 'handleRequest', source: { file: 'src/handler.ts', line: 1 } },
    ],
    edges: [],
    entry_points: [
      { id: 'entry-a', type: 'http', name: 'GET /things', source_node: 'node-a' },
    ],
    analyzer_contributions: [],
  } as unknown as CASOutput;
}

export function evaluateVersionSkewChecks(): VersionSkewCheck[] {
  const checks: VersionSkewCheck[] = [];
  const record = (id: string, question: string, invariant: string, run: () => { observed: string; pass: boolean }) => {
    try {
      const { observed, pass } = run();
      checks.push({ id, question, invariant, observed, status: pass ? 'pass' : 'fail' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      checks.push({ id, question, invariant, observed: `threw: ${message}`, status: 'fail' });
    }
  };

  const legacy = buildVersionSkewFixture('1.9.0');

  record(
    'skew-core-summary-degrades',
    'Does a core tool still answer on a pre-pillar (1.9.0) analysis?',
    'buildSummary returns data plus an analysis_version_notice, without throwing',
    () => {
      const summary = buildSummary(legacy);
      const noticed = typeof summary.analysis_version_notice === 'string' && summary.analysis_version_notice.includes('Re-run analyze_codebase');
      return { observed: `nodes=${summary.nodes}, notice=${noticed}`, pass: summary.nodes === 1 && noticed };
    }
  );

  record(
    'skew-journeys-notice',
    'Does get_user_journeys explain itself on a pre-pillar analysis instead of returning silent emptiness?',
    'empty result carries an analysis_version_notice naming the missing pillar',
    () => {
      const result = getUserJourneys(legacy) as { total?: number; analysis_version_notice?: string };
      const noticed = Boolean(result.analysis_version_notice?.includes('user journeys'));
      return { observed: `total=${result.total}, notice=${noticed}`, pass: result.total === 0 && noticed };
    }
  );

  record(
    'skew-paradigms-notice',
    'Does get_paradigm_conformance explain itself on a pre-pillar analysis?',
    'empty result carries an analysis_version_notice naming the missing pillar',
    () => {
      const result = getParadigmConformance(legacy) as { total?: number; analysis_version_notice?: string };
      const noticed = Boolean(result.analysis_version_notice?.includes('paradigm conformance'));
      return { observed: `total=${result.total}, notice=${noticed}`, pass: result.total === 0 && noticed };
    }
  );

  record(
    'skew-lineage-notice',
    'Does get_data_lineage explain itself on a pre-pillar analysis?',
    'empty result carries an analysis_version_notice naming the missing pillar',
    () => {
      const result = getDataLineage(legacy) as { total?: number; analysis_version_notice?: string };
      const noticed = Boolean(result.analysis_version_notice?.includes('data lineage'));
      return { observed: `total=${result.total}, notice=${noticed}`, pass: result.total === 0 && noticed };
    }
  );

  record(
    'skew-product-map-on-demand',
    'Does get_product_map fall back to an on-demand map with a notice on a pre-pillar analysis?',
    'markdown renders and starts with the on-demand notice',
    () => {
      const rendered = getProductMap(legacy, { format: 'markdown' }) as { markdown?: string };
      const hasNotice = Boolean(rendered.markdown?.startsWith('> ') && rendered.markdown.includes('computed on demand'));
      return { observed: `markdown_lines=${rendered.markdown?.split('\n').length ?? 0}, notice=${hasNotice}`, pass: hasNotice };
    }
  );

  record(
    'skew-floor-rejects-clearly',
    'Does a below-floor analysis get a re-analysis instruction instead of a crash or garbage?',
    'assertAnalysisVersionSupported throws a message containing analyze_codebase',
    () => {
      const ancient = buildVersionSkewFixture('1.5.0');
      const info = describeAnalysisVersion(ancient.cas_version);
      let message = '';
      try {
        assertAnalysisVersionSupported(ancient, '/tmp/version-skew');
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      const pass = info.status === 'unsupported' && message.includes('analyze_codebase');
      return { observed: `status=${info.status}, instruction=${message ? 'present' : 'missing'}`, pass };
    }
  );

  return checks;
}
