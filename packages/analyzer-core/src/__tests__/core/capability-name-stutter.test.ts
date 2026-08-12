import { AnalyzerOrchestrator } from '../../analyzer/core/orchestrator';

// isGenericCapabilityDisplayName gates six call sites that DROP a capability from
// the customer-facing catalog, so what it matches decides what a customer never
// sees. This asserts the one rule there that is structural rather than a list.
describe('capability name stutter rule', () => {
  const orch = new (AnalyzerOrchestrator as any)() as any;
  const isGeneric = (name: string): boolean => orch.isGenericCapabilityDisplayName(name);

  it('rejects a name whose subject and qualifier share a stem', () => {
    // Replaced a literal `report reporting` suppression: a stutter says nothing,
    // and that is true of the string in any repository.
    expect(isGeneric('Report Reporting')).toBe(true);
  });

  it('keeps the capability names measured live on prod', () => {
    for (const name of [
      'Pair devices for communication',
      'Organize and publish topics',
      'Monitor system health',
      'Process audio',
      'Configure audio processing',
      'Manage Dependency Injection',
      'Integrate with external services',
    ]) {
      expect(isGeneric(name)).toBe(false);
    }
  });

  it('keeps the commerce names the corpus characterization pins', () => {
    for (const name of ['Orders Management', 'Stock Management', 'Jobs Management', 'Proposal Preview']) {
      expect(isGeneric(name)).toBe(false);
    }
  });
});
