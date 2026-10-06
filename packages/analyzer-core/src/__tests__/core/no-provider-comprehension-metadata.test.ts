import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';

describe('no-provider comprehension metadata', () => {
  test('reports disabled enrichment and partial agent context when no canonical catalog exists', () => {
    const orchestrator = new AnalyzerOrchestrator() as any;
    jest.spyOn(orchestrator, 'hasAIInterpretationProviderConfigured').mockReturnValue(false);

    const phases = orchestrator.buildAnalysisPhases({
      hasAIProvider: false,
      capabilityDescriptionSource: 'skipped',
      canonicalCapabilities: 0,
      embeddingEnabled: false,
      runtimeSignals: 0,
    });
    expect(phases.find((phase: any) => phase.id === 'agent-context')).toMatchObject({
      status: 'partial',
      notes: ['Canonical capability comprehension is unavailable until an AI catalog is accepted.'],
    });
    expect(phases.find((phase: any) => phase.id === 'ai-system-narrative')).toMatchObject({
      status: 'deferred',
      requires_ai: true,
    });
  });

  test('reports complete agent context only when canonical capabilities exist', () => {
    const phases = (new AnalyzerOrchestrator() as any).buildAnalysisPhases({
      hasAIProvider: true,
      systemDescriptionSource: 'ai',
      capabilityDescriptionSource: 'ai',
      canonicalCapabilities: 2,
      embeddingEnabled: false,
      runtimeSignals: 0,
    });
    expect(phases.find((phase: any) => phase.id === 'agent-context')).toMatchObject({
      status: 'complete',
    });
  });
});
