/**
 * Regression coverage for the "silent zero" defect class: a registered
 * LANGUAGE analyzer whose glob matched N>0 files but whose extraction
 * pipeline crashed on every one of them (a native tree-sitter addon with no
 * prebuilt binary for the running Node ABI is the concrete incident — see
 * native-addon-load-failure.test.ts) still returns a structurally valid,
 * empty CASContribution: nodes: [], edges: []. Nothing throws. That is
 * indistinguishable from a legitimately tiny/empty project unless it is
 * checked explicitly.
 *
 * `AnalyzerOrchestrator.detectZeroYieldForClaimedFiles` (orchestrator.ts) is
 * that explicit check. These tests exercise it directly (it is private —
 * accessed via `as any`, matching this suite's existing style for
 * orchestrator internals) against fake analyzer registrations, so the guard
 * is verified without needing a real project fixture or a real broken
 * tree-sitter build.
 */
import { AnalyzerOrchestrator, AnalyzerRegistration } from '../../analyzer/core/orchestrator';
import type { CASContribution } from '../../types/cas.types';

function fakeContribution(nodes: any[] = [], edges: any[] = []): CASContribution {
  return {
    nodes,
    edges,
    analyzer_metadata: {
      analyzer_id: 'fake',
      analyzer_name: 'Fake Analyzer',
      contribution_type: 'language',
    },
  } as CASContribution;
}

function fakeRegistration(
  type: AnalyzerRegistration['type'],
  relevantFiles: string[]
): AnalyzerRegistration {
  return {
    id: 'fake-analyzer',
    name: 'Fake Analyzer',
    type,
    version: '1.0.0',
    detectPatterns: {},
    analyzer: {
      getRelevantFiles: async () => relevantFiles,
    } as any,
  };
}

describe('AnalyzerOrchestrator.detectZeroYieldForClaimedFiles', () => {
  const orchestrator = new AnalyzerOrchestrator() as any;

  it('flags a language analyzer that matched files but produced zero nodes AND zero edges as a hard error', async () => {
    const registration = fakeRegistration('language', ['src/a.ts', 'src/b.ts']);
    const result = fakeContribution([], []);

    const error = await orchestrator.detectZeroYieldForClaimedFiles(registration, result, '/fake/project');

    expect(error).not.toBeNull();
    expect(error.severity).toBe('error');
    expect(error.code).toBe('ZERO_NODES_FOR_CLAIMED_FILES');
    expect(error.recoverable).toBe(false);
    expect(error.analyzer).toBe('fake-analyzer');
    expect(error.message).toContain('2 file(s)');
  });

  it('does NOT flag a language analyzer with zero matched files (a genuinely empty project is not an error)', async () => {
    const registration = fakeRegistration('language', []);
    const result = fakeContribution([], []);

    const error = await orchestrator.detectZeroYieldForClaimedFiles(registration, result, '/fake/project');

    expect(error).toBeNull();
  });

  it('does NOT flag a language analyzer that matched files AND produced nodes (the normal, healthy case)', async () => {
    const registration = fakeRegistration('language', ['src/a.ts']);
    const result = fakeContribution([{ id: 'n1', type: 'function' } as any], []);

    const error = await orchestrator.detectZeroYieldForClaimedFiles(registration, result, '/fake/project');

    expect(error).toBeNull();
  });

  it('does NOT flag a language analyzer that matched files and produced only edges (no nodes)', async () => {
    const registration = fakeRegistration('language', ['src/a.ts']);
    const result = fakeContribution([], [{ id: 'e1' } as any]);

    const error = await orchestrator.detectZeroYieldForClaimedFiles(registration, result, '/fake/project');

    expect(error).toBeNull();
  });

  it('does NOT flag a language analyzer that matched files and produced only an exit point', async () => {
    const registration = fakeRegistration('language', ['src/client.py']);
    const result = { ...fakeContribution(), exit_points: [{ id: 'exit_1' }] } as CASContribution;

    const error = await orchestrator.detectZeroYieldForClaimedFiles(registration, result, '/fake/project');

    expect(error).toBeNull();
  });

  it('does NOT flag a FRAMEWORK/pattern analyzer that matched files but found nothing — that is a legitimate "not present" result, not a crash', async () => {
    const registration = fakeRegistration('framework', ['package.json']);
    const result = fakeContribution([], []);

    const error = await orchestrator.detectZeroYieldForClaimedFiles(registration, result, '/fake/project');

    expect(error).toBeNull();
  });

  it('does not manufacture a false positive when getRelevantFiles itself throws', async () => {
    const registration: AnalyzerRegistration = {
      id: 'fake-analyzer',
      name: 'Fake Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {},
      analyzer: {
        getRelevantFiles: async () => { throw new Error('glob blew up'); },
      } as any,
    };
    const result = fakeContribution([], []);

    const error = await orchestrator.detectZeroYieldForClaimedFiles(registration, result, '/fake/project');

    expect(error).toBeNull();
  });

  it('uses analyzer claims instead of broad candidate files when the analyzer exposes both', async () => {
    const registration: AnalyzerRegistration = {
      id: 'selective-analyzer',
      name: 'Selective Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {},
      analyzer: {
        getRelevantFiles: async () => ['src/a.ts', 'src/b.ts'],
        getClaimedFiles: async () => [],
      } as any,
    };

    const error = await orchestrator.detectZeroYieldForClaimedFiles(
      registration,
      fakeContribution([], []),
      '/fake/project'
    );

    expect(error).toBeNull();
  });
});
