import assert from 'node:assert/strict';
import test from 'node:test';
import { runCapabilityInferenceBenchmark } from './capability-inference-benchmark';
import { aiService } from '../../../packages/analyzer-core/src/ai/ai-service';

test('capability inference benchmark prefers domain capabilities over framework entry noise', async () => {
  const originalGenerate = aiService.generateComponentDescription;
  const previousKey = process.env.OPENAI_API_KEY;
  const previousInProcess = process.env.KLAURO_ANALYSIS_IN_PROCESS;
  let catalogFacts: any;
  let catalogCitations: string[][] = [];
  process.env.OPENAI_API_KEY = 'capability-benchmark-mock';
  process.env.KLAURO_ANALYSIS_IN_PROCESS = '1';
  aiService.generateComponentDescription = async (request: any) => {
    const context = request?.additionalContext || {};
    if (/cataloging the|evidence-grounded product outcome/i.test(String(context.task || ''))) {
      const requiredOutcome = context.facts?.required_outcomes?.[0];
      if (requiredOutcome) {
        const outcomeText = [requiredOutcome.outcome, requiredOutcome.first_party_outcome_text]
          .filter(Boolean).join(' ');
        assert.equal(context.facts.required_outcomes.length, 1);
        assert.match(outcomeText, /fuel purchases/i);
        assert.match(requiredOutcome.requirement_id, /fuel-purchase/i);
        assert.ok(Array.isArray(requiredOutcome.candidate_ids) && requiredOutcome.candidate_ids.length > 0);
        return JSON.stringify({ capabilities: [{
          requirement_id: requiredOutcome.requirement_id,
          name: 'Record fuel purchases',
          description: 'Fuel activity preserves each purchase entered by fleet operators for daily fleet operations.',
          category: 'core',
          entities: [],
          journeys: [],
          candidate_ids: requiredOutcome.candidate_ids,
        }] });
      }
      catalogFacts ||= context.facts;
      const candidateIdsFor = (subject: string): string[] => (context.facts?.candidate_route_areas || [])
        .filter((candidate: any) => [candidate.family, candidate.name, ...(candidate.entity_names || [])]
          .join(' ').toLowerCase().includes(subject))
        .map((candidate: any) => candidate.candidate_id);
      catalogCitations = [candidateIdsFor('vehicle'), candidateIdsFor('fuel'), candidateIdsFor('invoice')];
      return JSON.stringify({ capabilities: [
        { name: 'List vehicles', description: 'Lists vehicle records for operators requesting current vehicle information.', category: 'core', entities: ['Vehicle'], journeys: [], candidate_ids: catalogCitations[0] },
        { name: 'Record fuel purchases', description: 'Preserves each purchase entered by fleet operators as fuel activity.', category: 'core', entities: ['FuelPurchase'], journeys: [], candidate_ids: catalogCitations[1] },
        { name: 'Settle invoices', description: 'Invoice settlements record captured customer payments and preserve the resulting settled status for billing staff.', category: 'core', entities: ['Invoice'], journeys: [], candidate_ids: catalogCitations[2] },
      ] });
    }
    const items: Array<{ id: string; name?: string }> = Array.isArray(context.items) ? context.items : [];
    const descriptionFor = (item: { name?: string; relatedEntities?: string[] }): string => {
      const subject = [item.name, ...(item.relatedEntities || [])].join(' ').toLowerCase();
      if (subject.includes('vehicle')) return 'Vehicle records retain the vehicles identified for daily fleet operations.';
      if (subject.includes('fuel')) return 'Preserves each purchase entered by fleet operators as fuel activity.';
      if (subject.includes('invoice')) return 'Invoice records preserve the invoices marked settled after their payments are captured.';
      return 'Product records retain the evidenced subjects and actions represented by this product behavior.';
    };
    return JSON.stringify({
      system_description: 'Fleet operations teams use this service to maintain vehicle, fuel purchase, and invoice records for daily work. Dispatchers retrieve vehicle information while operators record fuel activity and consumption details. Billing staff settle invoices after payments are captured and preserve the resulting status. The service coordinates these evidenced workflows through its registered application behavior.',
      domain: 'fleet-operations',
      descriptions: items.map(item => ({ id: item.id, description: descriptionFor(item) })),
      quality_check: { used_facts: ['Vehicle', 'FuelPurchase', 'Invoice'], unsupported_claims: [] },
    });
  };
  let report;
  try {
    report = await runCapabilityInferenceBenchmark();
  } finally {
    aiService.generateComponentDescription = originalGenerate;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousInProcess === undefined) delete process.env.KLAURO_ANALYSIS_IN_PROCESS;
    else process.env.KLAURO_ANALYSIS_IN_PROCESS = previousInProcess;
  }

  assert.equal(report.status, 'pass', JSON.stringify({ report, catalogFacts }));
  assert.equal(report.score, 100);
  const availableCandidateIds = new Set<string>((catalogFacts.candidate_route_areas || [])
    .map((candidate: { candidate_id?: string }) => String(candidate.candidate_id || '')).filter(Boolean));
  assert.equal(catalogCitations.length, 3);
  assert.ok(catalogCitations.every(ids => ids.length > 0), JSON.stringify({ catalogFacts, catalogCitations }));
  assert.ok(catalogCitations.flat().every(candidateId => availableCandidateIds.has(candidateId)),
    JSON.stringify({ availableCandidateIds: [...availableCandidateIds], catalogCitations }));
  assert.ok(new Set(catalogCitations.flat()).size >= 3, JSON.stringify(catalogCitations));
  assert.equal(report.summary.generic_capability_count, 0);
  const capabilityText = report.capabilities.map(capability => `${capability.name} ${capability.description || ''}`.toLowerCase());
  assert.ok(capabilityText.some(text => /fuel/.test(text)), `no fuel capability: ${capabilityText.join(' | ')}`);
  assert.ok(capabilityText.some(text => /vehicle|fleet/.test(text)), `no vehicle capability: ${capabilityText.join(' | ')}`);
  assert.ok(capabilityText.some(text => /invoice|settle|billing/.test(text)), `no invoice capability: ${capabilityText.join(' | ')}`);
});
