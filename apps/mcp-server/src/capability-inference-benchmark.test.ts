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
  const citationChecks: boolean[] = [];
  process.env.OPENAI_API_KEY = 'capability-benchmark-mock';
  process.env.KLAURO_ANALYSIS_IN_PROCESS = '1';
  aiService.generateComponentDescription = async (request: any) => {
    const context = request?.additionalContext || {};
    if (/cataloging the|evidence-grounded product outcome/i.test(String(context.task || ''))) {
      const requiredOutcomes = Array.isArray(context.facts?.required_outcomes) ? context.facts.required_outcomes : [];
      const requiredOutcome = requiredOutcomes.length === 1 ? requiredOutcomes[0] : undefined;
      if (requiredOutcome) {
        const outcomeText = [requiredOutcome.outcome, requiredOutcome.first_party_outcome_text]
          .filter(Boolean).join(' ');
        const availableIds = new Set<string>((context.facts?.candidate_route_areas || [])
          .map((candidate: { candidate_id?: string }) => String(candidate.candidate_id || '')).filter(Boolean));
        const candidateIds: string[] = Array.isArray(requiredOutcome.candidate_ids)
          ? requiredOutcome.candidate_ids.map(String)
          : [];
        assert.equal(requiredOutcomes.length, 1);
        assert.ok(candidateIds.length > 0);
        citationChecks.push(candidateIds.every(candidateId => availableIds.has(candidateId)));
        catalogCitations.push(candidateIds);
        const capability = /fuel/i.test(outcomeText)
          ? {
            name: 'Record fuel purchases',
            description: 'Fleet operators record fuel purchases and preserve their consumption details for daily operations.',
          }
          : /invoice|settle|billing/i.test(outcomeText)
            ? {
              name: 'Settle customer invoices',
              description: 'Billing staff settle customer invoices after capturing payments and preserve the resulting status.',
            }
            : /vehicle|fleet/i.test(outcomeText)
              ? {
                name: 'List fleet vehicles',
                description: 'Fleet operators list vehicles and retrieve current vehicle information for daily work.',
              }
              : undefined;
        assert.ok(capability, `unexpected required outcome: ${outcomeText}`);
        return JSON.stringify({ capabilities: [{
          requirement_id: requiredOutcome.requirement_id,
          ...capability,
          category: 'core',
          entities: [],
          journeys: [],
          candidate_ids: candidateIds,
        }] });
      }
      catalogFacts ||= context.facts;
      const candidateIdsFor = (subject: string): string[] => (context.facts?.candidate_route_areas || [])
        .filter((candidate: any) => [candidate.family, candidate.name, ...(candidate.entity_names || [])]
          .join(' ').toLowerCase().includes(subject))
        .map((candidate: any) => candidate.candidate_id);
      const availableIds = new Set<string>((context.facts?.candidate_route_areas || [])
        .map((candidate: { candidate_id?: string }) => String(candidate.candidate_id || '')).filter(Boolean));
      const proposals = [
        { subject: 'vehicle', name: 'List vehicles', description: 'Lists vehicle records for operators requesting current vehicle information.', entity: 'Vehicle' },
        { subject: 'fuel', name: 'Record fuel purchases', description: 'Preserves each purchase entered by fleet operators as fuel activity.', entity: 'FuelPurchase' },
        { subject: 'invoice', name: 'Settle invoices', description: 'Invoice settlements record captured customer payments and preserve the resulting settled status for billing staff.', entity: 'Invoice' },
      ].map(proposal => ({ ...proposal, candidate_ids: candidateIdsFor(proposal.subject) }))
        .filter(proposal => proposal.candidate_ids.length > 0);
      for (const proposal of proposals) {
        catalogCitations.push(proposal.candidate_ids);
        citationChecks.push(proposal.candidate_ids.every(candidateId => availableIds.has(candidateId)));
      }
      return JSON.stringify({ capabilities: proposals.map(proposal => ({
        name: proposal.name,
        description: proposal.description,
        category: 'core',
        entities: [proposal.entity],
        journeys: [],
        candidate_ids: proposal.candidate_ids,
      })) });
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
  assert.ok(catalogCitations.length >= 3, JSON.stringify({ catalogFacts, catalogCitations }));
  assert.ok(catalogCitations.every(ids => ids.length > 0), JSON.stringify({ catalogFacts, catalogCitations }));
  assert.ok(citationChecks.every(Boolean), JSON.stringify({ citationChecks, catalogCitations }));
  assert.equal(report.summary.generic_capability_count, 0);
  const capabilityText = report.capabilities.map(capability => `${capability.name} ${capability.description || ''}`.toLowerCase());
  assert.ok(capabilityText.some(text => /fuel/.test(text)), `no fuel capability: ${capabilityText.join(' | ')}`);
  assert.ok(capabilityText.some(text => /vehicle|fleet/.test(text)), `no vehicle capability: ${capabilityText.join(' | ')}`);
  assert.ok(capabilityText.some(text => /invoice|settle|billing/.test(text)), `no invoice capability: ${capabilityText.join(' | ')}`);
});
