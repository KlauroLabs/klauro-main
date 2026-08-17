import assert from 'node:assert/strict';
import test from 'node:test';
import { runCapabilityInferenceBenchmark } from './capability-inference-benchmark';
import { aiService } from '../../../packages/analyzer-core/src/ai/ai-service';

test('capability inference benchmark prefers domain capabilities over framework entry noise', async () => {
  const originalGenerate = aiService.generateComponentDescription;
  const previousKey = process.env.OPENAI_API_KEY;
  const previousInProcess = process.env.KLAURO_ANALYSIS_IN_PROCESS;
  let catalogFacts: any;
  process.env.OPENAI_API_KEY = 'capability-benchmark-mock';
  process.env.KLAURO_ANALYSIS_IN_PROCESS = '1';
  aiService.generateComponentDescription = async (request: any) => {
    const context = request?.additionalContext || {};
    if (/cataloging the/i.test(String(context.task || ''))) {
      catalogFacts = context.facts;
      return JSON.stringify({ capabilities: [
        { name: 'Track fleet vehicles', description: 'Keeps vehicle records current for daily fleet operations and dispatch decisions.', category: 'core', entities: ['Vehicle'], journeys: [] },
        { name: 'Record fuel purchases', description: 'Captures fuel purchase details for fleet cost and consumption tracking.', category: 'core', entities: ['FuelPurchase'], journeys: [] },
        { name: 'Settle customer invoices', description: 'Marks invoices settled after payments are captured and recorded.', category: 'core', entities: ['Invoice'], journeys: [] },
      ] });
    }
    const items: Array<{ id: string; name?: string }> = Array.isArray(context.items) ? context.items : [];
    const descriptions: Record<string, string> = {
      'Track fleet vehicles': 'Maintains unit numbers so dispatchers can identify vehicles during daily fleet work.',
      'Record fuel purchases': 'Captures gallons and purchase details so operators can monitor fleet consumption.',
      'Settle customer invoices': 'Records payment completion so outstanding invoices reflect their final settlement status.',
    };
    return JSON.stringify({
      system_description: 'Fleet operations teams use this service to maintain vehicle, fuel purchase, and invoice records for daily work. Dispatchers retrieve vehicle information while operators record fuel activity and consumption details. Billing staff settle invoices after payments are captured and preserve the resulting status. The service coordinates these evidenced workflows through its registered application behavior.',
      domain: 'fleet-operations',
      descriptions: items.map(item => ({ id: item.id, description: descriptions[item.name || ''] || 'Keeps fleet records accurate and available for daily operational decisions.' })),
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
  assert.equal(report.summary.generic_capability_count, 0);
  const capabilityText = report.capabilities.map(capability => `${capability.name} ${capability.description || ''}`.toLowerCase());
  assert.ok(capabilityText.some(text => /fuel/.test(text)), `no fuel capability: ${capabilityText.join(' | ')}`);
  assert.ok(capabilityText.some(text => /vehicle|fleet/.test(text)), `no vehicle capability: ${capabilityText.join(' | ')}`);
  assert.ok(capabilityText.some(text => /invoice|settle|billing/.test(text)), `no invoice capability: ${capabilityText.join(' | ')}`);
});
