import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { aiService } from '../../../packages/analyzer-core/src/ai/ai-service';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { generateElementDescription, validateDescription, type DescriptionTargetKind } from './description-enrichment';
import { loadAnalysis, saveAnalysis } from './storage';

interface ScenarioResult {
  name: string;
  status: 'pass' | 'fail';
  detail: string;
  target_kind?: string;
  description?: string;
}

export async function runDescriptionQualityBenchmark(options: { outputPath?: string; markdownPath?: string } = {}) {
  const startedAt = Date.now();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-description-quality-'));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-description-quality-storage-'));
  const previousStorage = process.env.KLAURO_STORAGE_PATH;
  const previousLocal = process.env.AI_LOCAL_ENABLED;
  const originalGenerate = aiService.generateComponentDescription;
  const results: ScenarioResult[] = [];
  const calls = new Map<string, number>();

  process.env.KLAURO_STORAGE_PATH = storage;
  process.env.AI_LOCAL_ENABLED = 'true';

  try {
    await seedDescriptionProject(root);
    await saveAnalysis(root, buildDescriptionBenchmarkCas(root));

    aiService.generateComponentDescription = async (context: any) => {
      const target = context.additionalContext?.target || {};
      const key = `${target.kind}:${target.name}`;
      const count = (calls.get(key) || 0) + 1;
      calls.set(key, count);
      if (count === 1) return firstBadDescription(target.kind, target.name);
      return repairedDescription(target.kind, target.name);
    };

    for (const target of [
      { kind: 'service' as const, target: 'EvidenceReviewService' },
      { kind: 'capability' as const, target: 'Evidence Review' },
      { kind: 'entity' as const, target: 'EvidenceRequest' },
      { kind: 'entry_point' as const, target: 'Approve Evidence Request' },
    ]) {
      try {
        const generated = await generateElementDescription({
          projectPath: root,
          target: target.target,
          targetKind: target.kind,
        });
        const validation = validateDescription(
          generated.description,
          { kind: target.kind, name: generated.target.name, target: { related_domains: ['evidence-review'], related_entities: ['EvidenceRequest'] } },
          await loadAnalysis(root) || undefined,
        );
        const sourceOk = generated.stored && validation.ok && !/\[object Object\]|Key capabilities:|Data model:|Entry points:|operations for|functionality/i.test(generated.description);
        results.push({
          name: `generate-${target.kind}`,
          status: sourceOk ? 'pass' : 'fail',
          target_kind: target.kind,
          description: generated.description,
          detail: sourceOk ? 'AI description repaired and stored with useful behavior text' : validation.reason || 'description contained inventory/generic text',
        });
      } catch (error) {
        results.push({
          name: `generate-${target.kind}`,
          status: 'fail',
          target_kind: target.kind,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const storedCas = await loadAnalysis(root);
    const sourceChecks = [
      storedCas?.nodes.find(node => node.name === 'EvidenceReviewService') as any,
      storedCas?.system_capabilities?.find(capability => capability.name === 'Evidence Review') as any,
      storedCas?.data_entities?.find(entity => entity.name === 'EvidenceRequest') as any,
      storedCas?.entry_points?.find(entry => entry.name === 'Approve Evidence Request') as any,
    ].filter(Boolean);
    results.push({
      name: 'stored-descriptions-are-ai-sourced',
      status: sourceChecks.length === 4 && sourceChecks.every(target => target.description_source === 'ai' && target.description_generation?.status === 'ai_applied')
        ? 'pass'
        : 'fail',
      detail: `${sourceChecks.filter(target => target.description_source === 'ai').length}/4 stored targets are AI-sourced`,
    });

    const badSamples = [
      {
        name: 'reject-inventory-summary',
        kind: 'capability' as const,
        target: 'Evidence Review',
        description: 'Evidence Review. Key capabilities: Evidence Review. Data model: EvidenceRequest. Entry points: POST /reviews.',
      },
      {
        name: 'reject-file-coordination-summary',
        kind: 'service' as const,
        target: 'EvidenceReviewService',
        description: 'EvidenceReviewService manages the creation and coordination of files related to evidence review and source files like evidence-review.service.ts.',
      },
      {
        name: 'reject-local-model-marketing',
        kind: 'entry_point' as const,
        target: 'Approve Evidence Request',
        description: 'Approve Evidence Request facilitates seamless and efficient evidence workflows to enhance productivity and user experience.',
      },
      {
        name: 'reject-object-leak',
        kind: 'entity' as const,
        target: 'EvidenceRequest',
        description: 'EvidenceRequest represents [object Object] and supports operations for evidence data.',
      },
    ];

    for (const sample of badSamples) {
      const validation = validateDescription(
        sample.description,
        { kind: sample.kind, name: sample.target, target: { related_domains: ['evidence-review'], related_entities: ['EvidenceRequest'] } },
        storedCas || undefined,
      );
      results.push({
        name: sample.name,
        status: validation.ok ? 'fail' : 'pass',
        target_kind: sample.kind,
        detail: validation.ok ? 'bad sample passed validation' : `rejected: ${validation.reason}`,
      });
    }
  } finally {
    aiService.generateComponentDescription = originalGenerate;
    if (previousStorage === undefined) delete process.env.KLAURO_STORAGE_PATH;
    else process.env.KLAURO_STORAGE_PATH = previousStorage;
    if (previousLocal === undefined) delete process.env.AI_LOCAL_ENABLED;
    else process.env.AI_LOCAL_ENABLED = previousLocal;
    await fs.remove(root);
    await fs.remove(storage);
  }

  const passed = results.filter(result => result.status === 'pass').length;
  const total = results.length;
  const report = {
    generated_at: new Date().toISOString(),
    benchmark_type: 'description-quality-ai-proof',
    status: passed === total ? 'pass' : 'fail',
    score: Math.round((passed / Math.max(1, total)) * 100),
    duration_ms: Date.now() - startedAt,
    summary: {
      passed,
      total,
      generated_target_kinds: ['service', 'capability', 'entity', 'entry_point'],
      bad_samples_rejected: results.filter(result => result.name.startsWith('reject-') && result.status === 'pass').length,
    },
    results,
  };

  if (options.outputPath) {
    await fs.ensureDir(path.dirname(options.outputPath));
    await fs.writeJson(options.outputPath, report, { spaces: 2 });
  }
  if (options.markdownPath) {
    await fs.ensureDir(path.dirname(options.markdownPath));
    await fs.writeFile(options.markdownPath, renderMarkdown(report));
  }

  return report;
}

async function seedDescriptionProject(root: string) {
  await fs.outputFile(path.join(root, 'src/domain/evidence.ts'), `
export interface EvidenceRequest { id: string; controlId: string; reviewerId: string; status: 'open' | 'approved'; }
export interface ReviewDecision { id: string; evidenceRequestId: string; reviewerId: string; outcome: 'approved' | 'rejected'; }
`);
  await fs.outputFile(path.join(root, 'src/services/evidence-review.service.ts'), `
import type { EvidenceRequest, ReviewDecision } from '../domain/evidence';
export class EvidenceReviewService {
  approveEvidenceRequest(request: EvidenceRequest, reviewerId: string): ReviewDecision {
    return { id: request.id, evidenceRequestId: request.id, reviewerId, outcome: 'approved' };
  }
}
`);
}

function buildDescriptionBenchmarkCas(root: string): CASOutput {
  return {
    cas_version: '1.10.0',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: 'analysis-description-quality-benchmark',
    system: { id: 'system-description-quality', name: 'compliance-evidence', type: 'service', root_path: root },
    nodes: [{
      id: 'node-evidence-review-service',
      name: 'EvidenceReviewService',
      type: 'service',
      source: { file: 'src/services/evidence-review.service.ts', line: 3 },
      metadata: {},
    }],
    edges: [],
    data_entities: [{
      id: 'entity-evidence-request',
      name: 'EvidenceRequest',
      fields: [{ name: 'controlId' }, { name: 'reviewerId' }, { name: 'status' }],
      relationships: [],
      schema_source: 'src/domain/evidence.ts',
    }] as any,
    entry_points: [{
      id: 'entry-approve-evidence-request',
      name: 'Approve Evidence Request',
      trigger: { type: 'http', method: 'POST', path: '/evidence/:id/approve' },
      handler: { node_id: 'node-evidence-review-service', file: 'src/services/evidence-review.service.ts', line: 4 },
      security: { requires_auth: true },
      criticality: 'high',
    }] as any,
    system_capabilities: [{
      id: 'cap-evidence-review',
      name: 'Evidence Review',
      description: 'Evidence Review tracks review decisions for submitted evidence.',
      category: 'core',
      criticality: 'critical',
      criticality_factors: [],
      operations: [{ action: 'approve', entry_point_id: 'entry-approve-evidence-request', entry_point_type: 'http', path_or_command: 'POST /evidence/:id/approve' }],
      related_entities: ['entity-evidence-request'],
      related_domains: ['evidence-review'],
    }] as any,
    analyzer_contributions: [],
    progressive_levels: { levels: {}, level_definitions: [] } as any,
    enhanced_system_purpose: {
      primary_type: 'backend-service',
      confidence: 0.9,
      evidence: [],
      primary_domain: 'evidence-review',
      core_concepts: ['evidence request', 'review decision', 'control'],
      inferred_description: 'A compliance evidence review backend that records reviewer decisions for submitted evidence requests.',
      supporting_workflow_ids: [],
    },
  };
}

function firstBadDescription(kind: DescriptionTargetKind, name: string): string {
  if (kind === 'entity') return `${name} represents [object Object] and supports operations for evidence data.`;
  return `${name} facilitates seamless and efficient functionality for evidence-related components.`;
}

function repairedDescription(kind: DescriptionTargetKind, name: string): string {
  if (kind === 'service') {
    return `${name} owns the evidence review behavior that turns an open evidence request into a recorded reviewer decision.`;
  }
  if (kind === 'capability') {
    return `${name} lets reviewers approve submitted evidence requests and leaves a review decision tied to the original control evidence.`;
  }
  if (kind === 'entity') {
    return `${name} represents a submitted evidence item awaiting review, including the control, assigned reviewer, and current review status.`;
  }
  return `${name} starts the approval path for an evidence request and hands the reviewer decision to the evidence review service.`;
}

function renderMarkdown(report: Awaited<ReturnType<typeof runDescriptionQualityBenchmark>>): string {
  return [
    '# Description Quality Benchmark',
    '',
    `Status: ${report.status.toUpperCase()} (${report.score}/100)`,
    '',
    `Passed: ${report.summary.passed}/${report.summary.total}`,
    `Bad samples rejected: ${report.summary.bad_samples_rejected}`,
    '',
    '| Scenario | Status | Detail |',
    '| --- | --- | --- |',
    ...report.results.map(result => `| ${result.name} | ${result.status} | ${String(result.detail).replace(/\|/g, '\\|')} |`),
    '',
  ].join('\n');
}

if (require.main === module) {
  const outputPath = process.argv.includes('--output')
    ? process.argv[process.argv.indexOf('--output') + 1]
    : undefined;
  const markdownPath = process.argv.includes('--markdown')
    ? process.argv[process.argv.indexOf('--markdown') + 1]
    : undefined;
  runDescriptionQualityBenchmark({ outputPath, markdownPath })
    .then(report => {
      process.stdout.write(`Status: ${report.status.toUpperCase()} (${report.score}/100)\n`);
      if (outputPath) process.stdout.write(`Report: ${outputPath}\n`);
    })
    .catch(error => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
