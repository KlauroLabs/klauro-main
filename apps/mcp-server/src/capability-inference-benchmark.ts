import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { isDirectCliInvocation } from './cli-invocation';
import { analyzeForBench } from './gauntlet/product-analysis';

type GateStatus = 'pass' | 'fail';

interface BenchmarkGate {
  id: string;
  status: GateStatus;
  detail: string;
}

interface CapabilityInferenceBenchmarkReport {
  generated_at: string;
  status: GateStatus;
  score: number;
  summary: {
    capability_count: number;
    generic_capability_count: number;
    primary_domain: string;
    gates_passed: number;
    total_gates: number;
  };
  capabilities: Array<{
    name: string;
    domains: string[];
    description: string;
  }>;
  gates: BenchmarkGate[];
}

export async function runCapabilityInferenceBenchmark(options: { outputPath?: string; markdownPath?: string } = {}): Promise<CapabilityInferenceBenchmarkReport> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-capability-inference-'));
  try {
    await seedSymfonyFleetFixture(root);
    const cas = await analyzeForBench(root);
    const inferredCapabilities = cas.capabilities?.length
      ? cas.capabilities
      : cas.structural_capability_candidates || [];
    const capabilities = inferredCapabilities.map(capability => ({
      name: capability.name,
      domains: capability.related_domains || [],
      description: capability.description || '',
    }));
    const names = capabilities.map(capability => capability.name);
    const capabilityText = capabilities.map(capability => `${capability.name} ${capability.description}`.toLowerCase());
    const primaryDomain = cas.enhanced_system_purpose?.primary_domain || '';







    const domainSource = cas.enhanced_system_purpose?.domain_source || '';
    const descriptionStatus = cas.enhanced_system_purpose?.description_generation?.status || '';
    const aiEnrichment = cas.ai_enrichment || '';
    const domainProvenanceOk = primaryDomain
      ? domainSource === 'ai' || domainSource === 'ai-refined'
      : ['ai_skipped', 'ai_rejected', 'ai_failed'].includes(descriptionStatus) || aiEnrichment === 'disabled';
    const genericCapabilities = capabilities.filter(capability => isGenericCapabilityName(capability.name));
    const isolatedDomainCapabilities = ['vehicle', 'fuel', 'invoice'].filter(domain =>
      capabilityText.some(text => text.includes(domain) &&
        ['vehicle', 'fuel', 'invoice'].filter(other => other !== domain).every(other => !text.includes(other)))
    );
    const publishableDescriptions = (cas.capabilities || []).filter(capability =>
      capability.description_source &&
      ['ai', 'manual', 'reused'].includes(capability.description_source) &&
      String(capability.description || '').trim().split(/\s+/).length >= 8 &&
      capability.description_generation?.status !== 'ai_rejected'
    );
    const gates = [
      gate('capability-inference:primary-domain-provenance', domainProvenanceOk, `primary domain ${primaryDomain || 'absent'} (domain_source=${domainSource || 'unset'}, description_generation=${descriptionStatus || 'unset'}, ai_enrichment=${aiEnrichment || 'unset'})`),
      gate('capability-inference:no-generic-primary-capabilities', genericCapabilities.length === 0, `${genericCapabilities.length} generic capabilities: ${genericCapabilities.map(item => item.name).join(', ') || 'none'}`),
      gate('capability-inference:canonical-language-authored', (cas.capabilities || []).every(capability =>
        ['ai', 'manual', 'reused'].includes(capability.name_source || '')
      ), `${cas.capabilities?.length || 0} canonical capabilities; unauthored candidates remain structural evidence`),
      gate('capability-inference:publishable-descriptions',
        (cas.capabilities || []).length > 0 && publishableDescriptions.length === (cas.capabilities || []).length,
        `${publishableDescriptions.length}/${cas.capabilities?.length || 0} canonical descriptions passed authored quality validation`),
      gate('capability-inference:distinct-domain-capabilities',
        isolatedDomainCapabilities.length === 3,
        `${isolatedDomainCapabilities.length}/3 domains have independently expressed capabilities: ${names.join(', ')}`),







      gate('capability-inference:vehicle-capability', capabilityText.some(t => /vehicle|fleet/.test(t)), names.join(', ')),
      gate('capability-inference:fuel-purchase-capability', capabilityText.some(t => /fuel/.test(t)), names.join(', ')),
      gate('capability-inference:invoice-capability', capabilityText.some(t => /invoice|settle|billing/.test(t)), names.join(', ')),
      gate('capability-inference:no-cross-domain-description-leak',
        capabilities.every(capability => !/\bportfolio|investment|account funding\b/i.test(capability.description)),
        capabilities.map(capability => `${capability.name}: ${capability.description}`).join(' | ')
      ),
    ];
    const passed = gates.filter(item => item.status === 'pass').length;
    const report: CapabilityInferenceBenchmarkReport = {
      generated_at: new Date().toISOString(),
      status: passed === gates.length ? 'pass' : 'fail',
      score: Math.round((passed / gates.length) * 100),
      summary: {
        capability_count: capabilities.length,
        generic_capability_count: genericCapabilities.length,
        primary_domain: primaryDomain,
        gates_passed: passed,
        total_gates: gates.length,
      },
      capabilities,
      gates,
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
  } finally {
    await fs.remove(root);
  }
}

async function seedSymfonyFleetFixture(root: string): Promise<void> {
  await fs.outputJson(path.join(root, 'composer.json'), {
    require: {
      'php': '^8.2',
      'symfony/framework-bundle': '^6.0',
    },
  });
  await fs.outputFile(path.join(root, 'bin/console'), '#!/usr/bin/env php\n<?php\n');
  await fs.outputFile(path.join(root, 'src/Entity/Vehicle.php'), [
    '<?php',
    'namespace App\\Entity;',
    'class Vehicle { public int $id; public string $unitNumber; }',
  ].join('\n'));
  await fs.outputFile(path.join(root, 'src/Entity/Invoice.php'), [
    '<?php',
    'namespace App\\Entity;',
    'class Invoice { public int $id; public int $amount; }',
  ].join('\n'));
  await fs.outputFile(path.join(root, 'src/Entity/FuelPurchase.php'), [
    '<?php',
    'namespace App\\Entity;',
    'class FuelPurchase { public int $id; public float $gallons; }',
  ].join('\n'));
  await fs.outputFile(path.join(root, 'src/Controller/FleetController.php'), [
    '<?php',
    'namespace App\\Controller;',
    'use App\\Entity\\FuelPurchase;',
    'use App\\Entity\\Invoice;',
    'use App\\Service\\FuelPurchaseService;',
    'use App\\Service\\InvoiceSettlementService;',
    'use App\\Service\\VehicleService;',
    'use Symfony\\Component\\Routing\\Annotation\\Route;',
    'class FleetController {',
    "  #[Route('/vehicles', name: 'fleet_vehicles', methods: ['GET'])]",
    '  public function vehicles(VehicleService $vehicles): array { return $vehicles->listVehicles(); }',
    "  #[Route('/fuel-purchases', name: 'record_fuel_purchase', methods: ['POST'])]",
    '  public function fuel(FuelPurchaseService $fuel, FuelPurchase $purchase): FuelPurchase { return $fuel->recordFuelPurchase($purchase); }',
    "  #[Route('/invoices/{id}/settle', name: 'settle_invoice', methods: ['POST'])]",
    '  public function invoices(InvoiceSettlementService $invoices, Invoice $invoice): Invoice { return $invoices->settleInvoice($invoice); }',
    '}',
  ].join('\n'));
  await fs.outputFile(path.join(root, 'src/EventHandler/InvoiceSettledHandler.php'), [
    '<?php',
    'namespace App\\EventHandler;',
    'class InvoiceSettledHandler { public function __invoke() {} }',
  ].join('\n'));
  await fs.outputFile(path.join(root, 'src/Service/InvoiceSettlementService.php'), [
    '<?php',
    'namespace App\\Service;',
    'use App\\Entity\\Invoice;',
    'class InvoiceSettlementService { public function settleInvoice(Invoice $invoice): Invoice { return $invoice; } public function captureInvoicePayment() {} }',
  ].join('\n'));
  await fs.outputFile(path.join(root, 'src/Service/VehicleService.php'), [
    '<?php',
    'namespace App\\Service;',
    'use App\\Entity\\Vehicle;',
    'class VehicleService { public function listVehicles(): array { return []; } public function findVehicle(Vehicle $vehicle): Vehicle { return $vehicle; } public function updateVehicle(Vehicle $vehicle): Vehicle { return $vehicle; } }',
  ].join('\n'));
  await fs.outputFile(path.join(root, 'src/Service/FuelPurchaseService.php'), [
    '<?php',
    'namespace App\\Service;',
    'use App\\Entity\\FuelPurchase;',
    'class FuelPurchaseService { public function recordFuelPurchase(FuelPurchase $purchase): FuelPurchase { return $purchase; } public function listFuelPurchases(): array { return []; } }',
  ].join('\n'));
  await fs.outputFile(path.join(root, 'src/Repository/InvoiceRepository.php'), [
    '<?php',
    'namespace App\\Repository;',
    'class InvoiceRepository { public function findOpenInvoices() {} public function markSettled() {} }',
  ].join('\n'));
}

function isGenericCapabilityName(name: string): boolean {
  return /\b(bin\/console|console commands?|commands commands?|event(s)? handlers?|message handlers?|route handlers?|invoke capability)\b/i.test(name);
}

function gate(id: string, condition: boolean, detail: string): BenchmarkGate {
  return {
    id,
    status: condition ? 'pass' : 'fail',
    detail,
  };
}

function renderMarkdown(report: CapabilityInferenceBenchmarkReport): string {
  return [
    '# Capability Inference Benchmark',
    '',
    `Status: **${report.status.toUpperCase()}** (${report.score}/100)`,
    '',
    `Primary domain: ${report.summary.primary_domain}`,
    `Capabilities: ${report.capabilities.map(capability => capability.name).join(', ') || 'none'}`,
    '',
    ...report.gates.map(item => `- ${item.status === 'pass' ? 'PASS' : 'FAIL'} ${item.id}: ${item.detail}`),
    '',
  ].join('\n');
}

function parseArgs(argv: string[]): { outputPath: string; markdownPath: string } {
  let outputPath = path.join(process.cwd(), '.klauro-capability-inference-benchmark', 'latest-report.json');
  let markdownPath = path.join(process.cwd(), '.klauro-capability-inference-benchmark', 'latest-report.md');
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--output') outputPath = path.resolve(argv[++i]);
    else if (arg === '--markdown') markdownPath = path.resolve(argv[++i]);
    else if (arg === '--help' || arg === '-h') {
      console.log([
        'Usage: npm run capability-inference-benchmark -- [options]',
        '',
        'Options:',
        '  --output /path/report.json    Write JSON report.',
        '  --markdown /path/report.md    Write Markdown report.',
      ].join('\n'));
      process.exit(0);
    }
  }
  return { outputPath, markdownPath };
}

if (isDirectCliInvocation('capability-inference-benchmark')) {
  const args = parseArgs(process.argv.slice(2));
  runCapabilityInferenceBenchmark(args).then(report => {
    console.log(`Capability inference benchmark: ${report.status.toUpperCase()} (${report.score}/100)`);
    for (const item of report.gates) {
      console.log(`${item.status.toUpperCase()} ${item.id} - ${item.detail}`);
    }
    if (report.status !== 'pass') process.exitCode = 1;
  }).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
