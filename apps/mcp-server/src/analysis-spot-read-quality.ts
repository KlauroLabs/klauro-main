import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { globSync } from 'glob';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { classifyAnalysisProfile } from './analysis-profile';
import { isDirectCliInvocation } from './cli-invocation';

type GateStatus = 'pass' | 'warn' | 'fail';

interface SpotReadGate {
  id: string;
  status: GateStatus;
  score: number;
  detail: string;
}

interface SpotReadItem {
  analysis_file: string;
  repo_path: string;
  repo_name: string;
  profile_kind: string;
  status: GateStatus;
  score: number;
  gates: SpotReadGate[];
  summary: {
    nodes: number;
    edges: number;
    capabilities: number;
    weak_capabilities: string[];
    architectural_patterns: number;
    description_source?: string;
    description_generation_status?: string;
    system_purpose_type?: string;
    system_purpose_confidence?: number;
    primary_domain?: string;
  };
}

interface SpotReadReport {
  generated_at: string;
  benchmark_type: 'analysis-spot-read-quality';
  analysis_dir: string;
  status: GateStatus;
  score: number;
  summary: {
    sampled_analyses: number;
    pass: number;
    warn: number;
    fail: number;
    average_score: number;
  };
  analyses: SpotReadItem[];
}

interface ParsedArgs {
  analysisDir: string;
  maxTargets: number;
  outputPath?: string;
  markdownPath?: string;
  repoFilters: string[];
  includeEphemeral: boolean;
}

const DEFAULT_ANALYSIS_DIR = path.join(os.homedir(), '.klauro', 'analyses');
const DEFAULT_MAX_TARGETS = 25;
const MIGRATION_PATH = /(^|\/)(migrations?|db\/migrate|prisma\/migrations)(\/|$)|migration/i;
const INFRA_IDIOM_FALSE_POSITIVE_CATEGORIES = new Set(['dependency-injection', 'data-access', 'auth-tenant-scope']);

export async function runAnalysisSpotReadQuality(options: Partial<ParsedArgs> = {}): Promise<SpotReadReport> {
  const analysisDir = path.resolve(options.analysisDir || DEFAULT_ANALYSIS_DIR);
  const repoFilters = options.repoFilters || [];
  const maxTargets = options.maxTargets || DEFAULT_MAX_TARGETS;
  const files = selectLatestAnalysisFiles(analysisDir, maxTargets, repoFilters, Boolean(options.includeEphemeral));
  const analyses: SpotReadItem[] = [];

  for (const file of files) {
    try {
      const cas = readCasFile(file);
      analyses.push(evaluateSpotReadCas(cas, file));
    } catch (error) {
      analyses.push({
        analysis_file: file,
        repo_path: 'unknown',
        repo_name: path.basename(file),
        profile_kind: 'unknown',
        status: 'fail',
        score: 0,
        gates: [gate('read-analysis', 0, error instanceof Error ? error.message : String(error))],
        summary: {
          nodes: 0,
          edges: 0,
          capabilities: 0,
          weak_capabilities: [],
          architectural_patterns: 0,
        },
      });
    }
  }

  const reportStatus = aggregateStatus(analyses.map(item => item.status));
  const averageScore = Math.round(average(analyses.map(item => item.score)));
  const reportScore = reportStatus === 'fail'
    ? Math.min(averageScore, ...analyses.filter(item => item.status === 'fail').map(item => item.score))
    : averageScore;
  const report: SpotReadReport = {
    generated_at: new Date().toISOString(),
    benchmark_type: 'analysis-spot-read-quality',
    analysis_dir: analysisDir,
    status: reportStatus,
    score: reportScore,
    summary: {
      sampled_analyses: analyses.length,
      pass: analyses.filter(item => item.status === 'pass').length,
      warn: analyses.filter(item => item.status === 'warn').length,
      fail: analyses.filter(item => item.status === 'fail').length,
      average_score: averageScore,
    },
    analyses,
  };

  if (options.outputPath) {
    await fs.ensureDir(path.dirname(options.outputPath));
    await fs.writeJson(options.outputPath, report, { spaces: 2 });
  }
  if (options.markdownPath) {
    await fs.ensureDir(path.dirname(options.markdownPath));
    await fs.writeFile(options.markdownPath, renderMarkdown(report), 'utf8');
  }

  return report;
}

export function evaluateSpotReadCas(cas: CASOutput, analysisFile = ''): SpotReadItem {
  const runtimeCas = cas as any;
  const repoPath = String(cas.system?.root_path || runtimeCas.project?.root_path || cas.system?.name || 'unknown');
  const profile = classifyAnalysisProfile(cas, repoPath);
  const gates = [
    scorePurposeCoherence(cas),
    scoreNarrativeProvenance(cas),
    scoreCapabilityQuality(cas),
    scoreArchitecturePatterns(cas, profile.kind),
    scoreIdiomPrecision(cas, profile.kind),
    scoreConceptInventory(cas, profile.kind),
    scoreCoverageSerialization(cas),
    scoreEntrySurface(cas, repoPath, profile.kind),
  ];
  const status = aggregateStatus(gates.map(item => item.status));
  const score = Math.round(average(gates.map(item => item.score)));
  const weakCapabilities = (cas.system_capabilities || [])
    .filter(capability => isWeakCapability(capability))
    .slice(0, 10)
    .map(capability => clean(capability.name) || String(capability.id || 'unnamed'));

  return {
    analysis_file: analysisFile,
    repo_path: repoPath,
    repo_name: path.basename(repoPath),
    profile_kind: profile.kind,
    status,
    score,
    gates,
    summary: {
      nodes: cas.nodes?.length || 0,
      edges: cas.edges?.length || 0,
      capabilities: cas.system_capabilities?.length || 0,
      weak_capabilities: weakCapabilities,
      architectural_patterns: cas.architecture_summary?.architectural_patterns?.length || 0,
      description_source: cas.enhanced_system_purpose?.description_source,
      description_generation_status: cas.enhanced_system_purpose?.description_generation?.status,
      system_purpose_type: cas.system_purpose?.primary_type,
      system_purpose_confidence: cas.system_purpose?.confidence,
      primary_domain: cas.enhanced_system_purpose?.primary_domain,
    },
  };
}

function scorePurposeCoherence(cas: CASOutput): SpotReadGate {
  const primaryType = clean(cas.system_purpose?.primary_type);
  const confidence = Number(cas.system_purpose?.confidence);
  const domain = clean(cas.enhanced_system_purpose?.primary_domain);
  const description = clean(cas.enhanced_system_purpose?.inferred_description || cas.system?.description);
  const problems: string[] = [];
  let score = 100;

  if (!domain || /^(unknown|application|service|app|system)$/i.test(domain)) problems.push(`weak primary domain (${domain || 'missing'})`);
  const domainTokens = domain.split('-').filter(Boolean);
  if (domainTokens.some(token => ['arbit', 'analys', 'synchron', 'authentic', 'configur', 'manag'].includes(token))) {
    problems.push(`truncated primary domain token (${domain})`);
  }
  if (Number.isFinite(confidence) && confidence > 0 && confidence < 0.35) problems.push(`low-confidence system_purpose ${primaryType || 'unknown'} (${confidence})`);
  if (/^(authentication|auth|identity|login|user|users)$/i.test(domain) && hasBroadNonAuthEvidence(cas)) {
    problems.push(`primary domain "${domain}" is narrower than the repo evidence`);
  }
  if (/-client-library$/.test(domain) && !/^(client-sdk|library-package)$/.test(primaryType)) {
    problems.push(`client-library domain conflicts with purpose "${primaryType || 'missing'}"`);
  }
  if (/-library$/.test(domain) && !/^(client-sdk|library-package|tray-icon-library)$/.test(primaryType)) {
    problems.push(`library domain conflicts with purpose "${primaryType || 'missing'}"`);
  }
  const contradiction = descriptionContradictsPurposeFamily(description, domain, primaryType);
  if (contradiction) problems.push(contradiction);
  if (description && domain && !description.toLowerCase().includes(domain.toLowerCase().split(/[-\s]/)[0])) {
    score -= 10;
  }
  if (problems.length > 0) score = Math.min(score, problems.some(problem => problem.includes('low-confidence')) ? 60 : 70);
  return gate('purpose-coherence', score, problems.length ? problems.join('; ') : `domain ${domain || 'recorded'}`);
}

function scoreNarrativeProvenance(cas: CASOutput): SpotReadGate {
  const description = clean(cas.enhanced_system_purpose?.inferred_description || cas.system?.description);
  const source = clean(cas.enhanced_system_purpose?.description_source);
  const generation = cas.enhanced_system_purpose?.description_generation as any;
  const problems: string[] = [];
  let score = 100;

  if (description.length < 120) problems.push('system narrative is too short for human/agent orientation');
  if (looksLikeInventorySummary(description)) problems.push('system narrative is a CAS inventory/template summary');
  if (/\bentry points?\b/i.test(description)) problems.push('system narrative describes analyzer mechanics instead of product behavior');
  if (isKlauroSelfAnalysis(cas) && /\bfocus(?:ed|es|ing)?\s+on\s+security,\s+access control,\s+and\s+verification\b/i.test(description)) {
    problems.push('Klauro self narrative overweights security instead of codebase visibility');
  }
  if (/\b(?:@[\w.-]+\/[\w./-]+|[\w.-]+\/[\w./-]+\.js|lit\/directives\/|dist\/providers\/)\b/i.test(description)) {
    problems.push('system narrative includes source module paths as external services');
  }
  const contradiction = descriptionContradictsPurposeFamily(
    description,
    clean(cas.enhanced_system_purpose?.primary_domain),
    clean(cas.enhanced_system_purpose?.primary_type || cas.system_purpose?.primary_type),
  );
  if (contradiction) problems.push(contradiction);
  if (!source) problems.push('description source is missing');
  if (generation?.status === 'ai_failed' || generation?.status === 'ai_rejected') problems.push(`AI narrative generation ${generation.status}`);
  if (generation?.status === 'reused_previous' && /ai-unavailable|stale/i.test(`${generation.reason || ''} ${generation.may_be_stale || ''}`)) {
    problems.push(`stale reused narrative (${generation.reason || 'no reason'})`);
  }
  if (source === 'deterministic') problems.push(`deterministic system narrative (${generation?.status || 'no generation status'})`);
  if (problems.length > 0) score = problems.some(problem => /AI narrative generation|stale reused|deterministic/.test(problem)) ? 55 : 70;
  return gate('narrative-provenance', score, problems.length ? problems.join('; ') : `${source || 'unknown'} narrative`);
}

function scoreCapabilityQuality(cas: CASOutput): SpotReadGate {
  const capabilities = cas.system_capabilities || [];
  if (capabilities.length === 0) return gate('capability-quality', 0, 'no capabilities inferred');
  const domain = clean(cas.enhanced_system_purpose?.primary_domain);
  const primaryType = clean(cas.enhanced_system_purpose?.primary_type || cas.system_purpose?.primary_type);
  const weak = capabilities.filter(capability => isWeakCapability(capability));
  const weakPrimary = capabilities.slice(0, Math.min(8, capabilities.length)).filter(capability => isWeakCapability(capability));
  const networkCapabilities = capabilities.filter(capability =>
    /\b(Network Connection Control|Device Enrollment|Organization Access Context|Signal Synchronization)\b/i.test(clean(capability.name))
  );
  const networkCapabilityMismatch = networkCapabilities.length > 0 &&
    !/\b(zero-trust-security|network-access-management|network-access-control|network-access-platform|security-scanning-tool)\b/i.test(`${domain} ${primaryType}`);
  const weakRatio = weak.length / capabilities.length;
  let score = 100 - Math.round(weakRatio * 100);
  if (weakPrimary.length > 0) score = Math.min(score, 65);
  if (networkCapabilityMismatch) score = Math.min(score, 50);
  const problems: string[] = [];
  if (weak.length) problems.push(`weak capability labels/descriptions (${weak.length}/${capabilities.length}): ${weak.slice(0, 8).map(capability => clean(capability.name) || capability.id).join(', ')}`);
  if (networkCapabilityMismatch) problems.push(`network-access capabilities conflict with domain ${domain || 'missing'}`);
  const detail = problems.length ? problems.join('; ') : `${capabilities.length} capabilities look behavior-oriented`;
  return gate('capability-quality', score, detail);
}

function scoreArchitecturePatterns(cas: CASOutput, profileKind: string): SpotReadGate {
  const patterns = cas.architecture_summary?.architectural_patterns || [];
  const inventory = cas.architecture_summary?.architectural_inventory || {};
  const patternBalance = cas.architecture_summary?.pattern_balance as any;
  const inventoryCount = Object.values(inventory).reduce<number>((sum, value) => sum + (Array.isArray(value) ? value.length : 0), 0);
  const nodes = cas.nodes?.length || 0;
  if (['empty', 'infrastructure', 'test-package'].includes(profileKind)) {
    return gate('architecture-patterns', 100, `${profileKind} does not require application pattern inventory`);
  }
  const problems: string[] = [];
  if (nodes > 50 && patterns.length === 0) problems.push('no architecture patterns detected for non-trivial repo');
  if (nodes > 50 && inventoryCount === 0) problems.push('architecture inventory is empty');
  const highConfidencePatterns = patterns.filter((pattern: any) => Number(pattern.confidence || 0) >= 0.65);
  const primaryPatternCount = Array.isArray(patternBalance?.primary_patterns) ? patternBalance.primary_patterns.length : 0;
  if (patternBalance?.status === 'over-patterned' ||
    primaryPatternCount > 8 ||
    (patterns.length > 10 && highConfidencePatterns.length > 8 && !/shared backbone|layered|module/i.test(String(patternBalance?.rationale || '')))) {
    problems.push(`pattern splurge (${patterns.length} patterns, ${highConfidencePatterns.length} high-confidence)`);
  }
  const score = problems.length ? 60 - (problems.length - 1) * 15 : 100;
  return gate('architecture-patterns', score, problems.length ? problems.join('; ') : `${patterns.length} patterns, ${inventoryCount} inventory items`);
}

function scoreIdiomPrecision(cas: CASOutput, profileKind: string): SpotReadGate {
  const idioms = cas.codebase_idioms || [];
  const problems: string[] = [];
  for (const idiom of idioms) {
    const category = clean(idiom.category);
    if (category === 'migrations' && !idiomHasMigrationEvidence(idiom)) {
      problems.push(`migration idiom has no migration evidence (${idiom.name})`);
    }
    if (profileKind === 'infrastructure' && INFRA_IDIOM_FALSE_POSITIVE_CATEGORIES.has(category)) {
      problems.push(`infrastructure analysis emitted app-code idiom ${category}`);
    }
  }
  if (idioms.length === 0 && !['empty'].includes(profileKind)) {
    return gate('idiom-precision', 70, 'no idioms emitted to inspect');
  }
  const score = problems.length ? 45 : 100;
  return gate('idiom-precision', score, problems.length ? problems.slice(0, 5).join('; ') : `${idioms.length} idioms have plausible evidence`);
}

function scoreConceptInventory(cas: CASOutput, profileKind: string): SpotReadGate {
  if (['empty', 'infrastructure', 'test-package'].includes(profileKind)) return gate('concept-inventory', 100, `${profileKind} has relaxed concept inventory requirements`);
  const entities = [
    ...(cas.data_entities || []),
    ...((cas.database_schema?.entities || []) as any[]),
  ];
  const concepts = cas.domain_concepts || [];
  const nodes = cas.nodes || [];
  const modelLikeNodes = nodes.filter(node => /\b(model|entity|dto|schema|viewmodel|view model|type|interface|record)\b/i.test(`${node.type} ${node.name} ${node.source?.file || ''}`));
  if (entities.length > 0 || concepts.length >= 3 || modelLikeNodes.length >= 2) {
    return gate('concept-inventory', 100, `${entities.length} entities, ${concepts.length} concepts, ${modelLikeNodes.length} model-like nodes`);
  }
  return gate('concept-inventory', nodes.length > 50 ? 60 : 80, 'non-trivial repo has no entity/concept/model inventory');
}

function scoreCoverageSerialization(cas: CASOutput): SpotReadGate {
  const testSummary = cas.test_summary as any;
  const totalTests = Number(testSummary?.total_tests || testSummary?.tests?.total || (cas.test_suites || []).length || 0);
  const coverage = testSummary?.coverage ?? cas.test_coverage;
  if (totalTests <= 0) return gate('coverage-serialization', 100, 'no tests counted');
  if (coverage && typeof coverage === 'object' && Object.keys(coverage).length === 0) {
    return gate('coverage-serialization', 65, `coverage is an empty object despite ${totalTests} tests`);
  }
  if (typeof coverage === 'string' && coverage.includes('[object Object]')) {
    return gate('coverage-serialization', 40, 'coverage serializes as [object Object]');
  }
  return gate('coverage-serialization', 100, `coverage is serialized for ${totalTests} tests`);
}

function scoreEntrySurface(cas: CASOutput, repoPath: string, profileKind: string): SpotReadGate {
  const entryPoints = cas.entry_points || [];
  if (['empty', 'infrastructure', 'library-package', 'test-package'].includes(profileKind)) {
    return gate('entry-surface', 100, `${profileKind} has relaxed entry surface requirements`);
  }
  if (entryPoints.length === 0) return gate('entry-surface', 50, 'no entry points detected for app/service repo');
  const types = new Set(entryPoints.map(entry => entry.type));
  const text = `${repoPath} ${cas.system?.name || ''} ${(cas.nodes || []).slice(0, 250).map(node => `${node.name} ${node.type} ${node.source?.file || ''}`).join(' ')}`.toLowerCase();
  if (/mcp|cli|server/.test(text) && types.size === 1 && types.has('test')) {
    return gate('entry-surface', 45, 'entry surface is test-only despite CLI/server/MCP repo signals');
  }
  return gate('entry-surface', 100, `${entryPoints.length} entry points across ${Array.from(types).join(', ')}`);
}

function selectLatestAnalysisFiles(analysisDir: string, maxTargets: number, repoFilters: string[], includeEphemeral: boolean): string[] {
  if (!fs.existsSync(analysisDir)) return [];
  const files = globSync(['**/*.json', '**/*.json.zst'], {
    cwd: analysisDir,
    absolute: true,
    nodir: true,
    ignore: ['**/node_modules/**', '**/*.meta.json', '**/snapshots/**', '**/embeddings/**', '**/incremental-state.json', '**/file-cache.json'],
  }).sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
  const selected = new Map<string, string>();
  for (const file of files) {
    const lower = file.toLowerCase();
    if (repoFilters.length > 0 && !repoFilters.some(filter => lower.includes(filter.toLowerCase()))) continue;
    let key = path.basename(file).replace(/\.json(?:\.zst)?$/i, '');
    try {
      const cas = readCasFile(file);
      if (!looksLikeCasOutput(cas)) continue;
      if (!includeEphemeral && !isRealDurableRepoAnalysis(cas)) continue;
      key = String(cas.system?.root_path || (cas as any).project?.root_path || key);
    } catch {
      continue;
    }
    if (!selected.has(key)) selected.set(key, file);
    if (selected.size >= maxTargets) break;
  }
  return Array.from(selected.values());
}

function looksLikeCasOutput(value: any): value is CASOutput {
  return value &&
    typeof value === 'object' &&
    value.system &&
    Array.isArray(value.nodes) &&
    Array.isArray(value.edges);
}

function isRealDurableRepoAnalysis(cas: CASOutput): boolean {
  const root = clean(cas.system?.root_path || (cas as any).project?.root_path).replace(/\\/g, '/');
  if (!root) return false;
  const devRoot = path.join(os.homedir(), 'dev').replace(/\\/g, '/');
  if (!root.startsWith(`${devRoot}/`)) return false;
  return !/(^|\/)(\.klauro[^/]*|klauro-(?:existing-task-benchmark|build-memory|domain-folder|adjacent|growing|scratch|live|greenfield)|agent-proof|benchmark|tmp)(?:\/|$)/i.test(root);
}

function readCasFile(file: string): CASOutput {
  const buffer = file.endsWith('.zst')
    ? execFileSync('zstd', ['-dc', file], { maxBuffer: 512 * 1024 * 1024 })
    : fs.readFileSync(file);
  return JSON.parse(buffer.toString('utf8'));
}

function isWeakCapability(capability: any): boolean {
  const name = clean(capability?.name);
  const description = clean(capability?.description);
  const combined = `${name} ${description}`;
  if (!name) return true;
  if (/\bInfrastructure$/i.test(name) && description.length >= 50) return false;
  if (/\b(?:bin\/console|events handlers|message handlers|http handlers)\b/i.test(combined)) return true;
  if (/\b(?:bad|not|tab|web|poll|usd|pnl|alpha|config|save|destroy|bind|booking|branding|graph|control|picker|radius|seed|merge|has|serializer|lookup)\s+management\b/i.test(name)) return true;
  if (/\bCapability$/i.test(name)) return true;
  if (/^[A-Z]?[a-z]+(?:[A-Z][a-z0-9]+)+(?: Workflow| Management| Capability)?$/.test(name)) return true;
  if (/\b(?:mutation|query|handler|controller|route|page|component|command|function|method|file|event|message|http|api|graphql)\s+management\b/i.test(name)) return true;
  if (description.length < 50) return true;
  if (/\b(?:operations for|handles? operations|coordinates? operations|internal files?|specific functions?|helper functions?|routes?|handlers?|ui components?|source components?)\b/i.test(description)) return true;
  return false;
}

function hasBroadNonAuthEvidence(cas: CASOutput): boolean {
  const values = [
    ...(cas.system_capabilities || []).map(capability => capability.name),
    ...(cas.domain_concepts || []).map(concept => concept.name),
    ...(cas.data_entities || []).map(entity => entity.name),
  ].map(value => clean(value).toLowerCase());
  const nonAuth = values.filter(value =>
    value &&
    !/\b(auth|login|password|token|identity|session|user|role|permission)\b/.test(value) &&
    /\b(network|resource|policy|gateway|organization|portfolio|trade|vehicle|driver|fuel|invoice|clinical|patient|device|order|payment|report)\b/.test(value)
  );
  return nonAuth.length >= 3;
}

function isKlauroSelfAnalysis(cas: CASOutput): boolean {
  const root = clean(cas.system?.root_path || (cas as any).project?.root_path).replace(/\\/g, '/').toLowerCase();
  const name = clean(cas.system?.name).toLowerCase();
  return /\/(?:unravl|klauro)\/proof-of-concept(?:\/|$)/.test(root) || name === 'klauro' || name === 'proof-of-concept';
}

function looksLikeInventorySummary(description: string): boolean {
  const labels = [/Key capabilities:/i, /Data model:/i, /Entry points:/i, /Integrations:/i, /System Health/i, /See Diagram/i];
  return labels.filter(pattern => pattern.test(description)).length >= 2 ||
    /\bbuilt with [^.]+\. Key capabilities:/i.test(description);
}

function descriptionContradictsPurposeFamily(description: string, domain?: string, primaryType?: string): string | undefined {
  const lower = clean(description).toLowerCase();
  const authority = `${clean(domain)} ${clean(primaryType)}`.toLowerCase();
  const claims: Array<{ label: string; pattern: RegExp; allowed: RegExp }> = [
    {
      label: 'portfolio-management claim conflicts with purpose/domain',
      pattern: /\bportfolio management system\b|\binvestment management system\b|\bmanaged investments?\b/,
      allowed: /\b(portfolio-management|investment|trading-automation|solana-arbitrage)\b/,
    },
    {
      label: 'trading-automation claim conflicts with purpose/domain',
      pattern: /\btrading automation system\b|\barbitrage trading system\b|\btoken purchase execution\b/,
      allowed: /\b(trading-automation|solana-arbitrage)\b/,
    },
    {
      label: 'network-access/security claim conflicts with purpose/domain',
      pattern: /\bzero[- ]trust\b|\bnetwork access management system\b|\bsecurity scanning tool\b/,
      allowed: /\b(zero-trust-security|network-access-management|security-scanning-tool|network-access-platform)\b/,
    },
    {
      label: 'fleet-management claim conflicts with purpose/domain',
      pattern: /\bfleet management system\b|\bvehicle operations\b|\bfuel tracking\b/,
      allowed: /\b(fleet-management|fleet-management-platform|backend-service)\b/,
    },
    {
      label: 'clinical-testing claim conflicts with purpose/domain',
      pattern: /\bclinical testing system\b|\bpatient testing\b|\bclinical measurements?\b/,
      allowed: /\b(clinical-testing|clinical-testing-platform|medical-device)\b/,
    },
    {
      label: 'codebase-analysis claim conflicts with purpose/domain',
      pattern: /\bcodebase analysis\b|\bcas graph\b|\bagent work packets?\b/,
      allowed: /\b(codebase-analysis|devtools-platform)\b/,
    },
  ];
  return claims.find(claim => claim.pattern.test(lower) && !claim.allowed.test(authority))?.label;
}

function idiomHasMigrationEvidence(idiom: any): boolean {
  const files = [
    ...(idiom.evidence || []).map((item: any) => item.file || item.path || item.source?.file),
    ...(idiom.positive_examples || []).map((item: any) => item.file || item.path || item.source?.file),
    ...(idiom.affected_scopes?.files || []),
    ...(idiom.affected_scopes?.file_globs || []),
  ].map(value => clean(value).replace(/\\/g, '/')).filter(Boolean);
  return files.some(file => MIGRATION_PATH.test(file));
}

function gate(id: string, score: number, detail: string): SpotReadGate {
  const bounded = Math.max(0, Math.min(100, Math.round(score)));
  return {
    id,
    score: bounded,
    status: bounded >= 85 ? 'pass' : bounded >= 70 ? 'warn' : 'fail',
    detail,
  };
}

function aggregateStatus(statuses: GateStatus[]): GateStatus {
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('warn')) return 'warn';
  return 'pass';
}

function average(values: number[]): number {
  const finite = values.filter(value => Number.isFinite(value));
  if (finite.length === 0) return 0;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function clean(value: unknown): string {
  return String(value || '').trim();
}

function renderMarkdown(report: SpotReadReport): string {
  const lines = [
    '# Klauro Analysis Spot-Read Quality',
    '',
    `Generated: ${report.generated_at}`,
    `Status: **${report.status.toUpperCase()}** (${report.score}/100)`,
    `Analysis dir: ${report.analysis_dir}`,
    '',
    '## Summary',
    '',
    `- Sampled analyses: ${report.summary.sampled_analyses}`,
    `- Pass: ${report.summary.pass}`,
    `- Warn: ${report.summary.warn}`,
    `- Fail: ${report.summary.fail}`,
    '',
    '## Analyses',
    '',
    '| Repo | Status | Score | Profile | Domain | Purpose | Weak Capabilities | Failed Gates |',
    '|---|---|---:|---|---|---|---|---|',
  ];
  for (const item of report.analyses) {
    const failed = item.gates
      .filter(gate => gate.status === 'fail')
      .map(gate => `${gate.id}: ${gate.detail}`)
      .join('<br>') || 'none';
    lines.push([
      item.repo_name,
      item.status,
      String(item.score),
      item.profile_kind,
      item.summary.primary_domain || '',
      `${item.summary.system_purpose_type || ''} ${item.summary.system_purpose_confidence ?? ''}`.trim(),
      item.summary.weak_capabilities.slice(0, 5).join('<br>') || 'none',
      failed,
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }
  return `${lines.join('\n')}\n`;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    analysisDir: DEFAULT_ANALYSIS_DIR,
    maxTargets: DEFAULT_MAX_TARGETS,
    repoFilters: [],
    includeEphemeral: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--analysis-dir') args.analysisDir = path.resolve(argv[++index]);
    else if (arg === '--max-targets') args.maxTargets = Number(argv[++index]);
    else if (arg === '--repo-filter') args.repoFilters.push(argv[++index]);
    else if (arg === '--include-ephemeral') args.includeEphemeral = true;
    else if (arg === '--output') args.outputPath = path.resolve(argv[++index]);
    else if (arg === '--markdown') args.markdownPath = path.resolve(argv[++index]);
    else if (arg === '--help' || arg === '-h') {
      console.log([
        'Usage: npm run analysis-spot-read-quality -- [options]',
        '',
        'Options:',
        '  --analysis-dir /path       Stored analysis directory. Default ~/.klauro/analyses.',
        '  --max-targets n            Number of latest unique repo analyses to inspect. Default 25.',
        '  --repo-filter text         Only include analysis paths containing text. May repeat.',
        '  --include-ephemeral        Include temp/proof/greenfield analyses outside ~/dev.',
        '  --output /path/report.json Write JSON report.',
        '  --markdown /path/report.md Write Markdown report.',
      ].join('\n'));
      process.exit(0);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const report = await runAnalysisSpotReadQuality(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(report, null, 2));
  if (report.status === 'fail') process.exitCode = 1;
}

if (isDirectCliInvocation('analysis-spot-read-quality')) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
