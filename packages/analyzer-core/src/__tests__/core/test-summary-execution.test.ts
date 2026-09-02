import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';
import type { CASTestSuite } from '../../types/cas.types';

describe('static test summary execution semantics', () => {
  it('does not report discovered tests as passing without execution evidence', () => {
    const suites: CASTestSuite[] = [{
      id: 'suite_example',
      name: 'example',
      file_path: 'src/example.test.ts',
      test_type: 'unit',
      framework: 'jest',
      tests: [
        {
          id: 'test_runs',
          name: 'runs',
          test_type: 'unit',
          status: { skipped: false, focused: false, flaky: false },
        },
        {
          id: 'test_skipped',
          name: 'skipped',
          test_type: 'unit',
          status: { skipped: true, focused: false, flaky: false },
        },
      ],
    }];

    const summary = (new AnalyzerOrchestrator() as any).buildTestSummary([], [], suites);

    expect(summary.total_tests).toBe(2);
    expect(summary.by_status).toEqual({
      passing: 0,
      failing: 0,
      skipped: 1,
      flaky: 0,
      unknown: 1,
    });
    expect(summary.execution).toEqual({
      status: 'not-run',
      source: 'static-analysis',
      observed_tests: 0,
      note: 'Tests were discovered from source; no test execution results were supplied.',
    });
  });
});
