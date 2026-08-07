import {
  checkSourcePathIntegrity,
  formatSourcePathIntegrityReport,
} from '../../analyzer/core/graph-referential-integrity';

/**
 * THE INVARIANT UNDER TEST: every `source.file` / `handler.file` naming a
 * location under the analysis root is repo-relative. An absolute path there
 * leaks the sandbox filesystem layout (temp dir, username, org folder) into
 * customer-visible output and resolves for no consumer. See task #115: 34
 * analyzer files were found recording node.source.file as an absolute path,
 * and the generic entry-point backfill faithfully copied it into
 * handler.file too.
 */
describe('source-path repo-relativity', () => {
  const rootPath = '/private/tmp/klauro-sandbox/some-repo';

  it('accepts a document where every file field is already repo-relative', () => {
    const report = checkSourcePathIntegrity(
      {
        nodes: [
          { id: 'fn_a', source: { file: 'src/main.ts' }, primaryAnalyzer: 'typescript' },
        ],
        entry_points: [
          { id: 'entry_http_get', source_analyzer: 'nestjs', handler: { file: 'src/orders.controller.ts' } },
        ],
      },
      rootPath
    );
    expect(report.ok).toBe(true);
    expect(report.leaked_absolute_paths).toBe(0);
    expect(formatSourcePathIntegrityReport(report)).toContain('clean');
  });

  it('flags an absolute node.source.file that resolves under the analysis root, attributed to its analyzer', () => {
    const report = checkSourcePathIntegrity(
      {
        nodes: [
          { id: 'fn_a', source: { file: `${rootPath}/src/main.ts` }, primaryAnalyzer: 'nestjs', analyzers: ['nestjs'] },
          { id: 'fn_b', source: { file: 'src/util.ts' }, primaryAnalyzer: 'typescript' },
        ],
      },
      rootPath
    );
    expect(report.ok).toBe(false);
    expect(report.leaked_absolute_paths).toBe(1);
    expect(report.by_producer).toEqual({ nestjs: 1 });
    expect(report.samples[0]).toMatchObject({ id: 'fn_a', producer: 'nestjs', field: 'source.file' });
    expect(formatSourcePathIntegrityReport(report)).toContain('nestjs');
  });

  it('flags a leaked handler.file on a backfilled entry point', () => {
    const report = checkSourcePathIntegrity(
      {
        entry_points: [
          { id: 'entry_discovered_main', source_analyzer: 'orchestrator', handler: { file: `${rootPath}/src/main.ts` } },
        ],
      },
      rootPath
    );
    expect(report.ok).toBe(false);
    expect(report.samples[0]).toMatchObject({ field: 'handler.file', producer: 'orchestrator' });
  });

  it('does NOT flag an absolute path that genuinely lies outside the analysis root', () => {
    // A dependency outside the repo (e.g. a global type shim) is not this
    // defect class — forcing a relative rewrite here would produce a WRONG
    // path, which is worse than an honest absolute one.
    const report = checkSourcePathIntegrity(
      {
        nodes: [
          { id: 'fn_ext', source: { file: '/usr/lib/node_modules/some-global-lib/index.d.ts' }, primaryAnalyzer: 'typescript' },
        ],
      },
      rootPath
    );
    expect(report.ok).toBe(true);
    expect(report.leaked_absolute_paths).toBe(0);
  });

  it('refuses to guess when no root path anchor is available, rather than risk a false positive', () => {
    const report = checkSourcePathIntegrity(
      { nodes: [{ id: 'fn_a', source: { file: '/some/absolute/path.ts' } }] },
      undefined
    );
    expect(report.ok).toBe(true);
    expect(report.total_checked).toBe(0);
  });
});
