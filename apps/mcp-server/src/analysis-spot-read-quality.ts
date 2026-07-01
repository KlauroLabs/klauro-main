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
  const descriptionSource = clean(cas.enhanced_system_purpose?.description_source);
  const capabilities = cas.system_capabilities || [];
  const concepts = cas.domain_concepts || [];
  const hasConcreteOrientation =
    descriptionSource === 'ai' &&
    description.length >= 120 &&
    capabilities.length > 0 &&
    concepts.length >= 2 &&
    domain &&
    !/^(unknown|application|service|app|system)$/i.test(domain);
  const problems: string[] = [];
  let score = 100;

  if (!domain || /^(unknown|application|service|app|system|using|specs|linq|language)$/i.test(domain)) problems.push(`weak primary domain (${domain || 'missing'})`);
  const domainTokens = domain.split('-').filter(Boolean);
  if (domainTokens.some(token => ['arbit', 'analys', 'synchron', 'authentic', 'configur', 'manag'].includes(token))) {
    problems.push(`truncated primary domain token (${domain})`);
  }
  if (Number.isFinite(confidence) && confidence > 0 && confidence < 0.35 && !hasConcreteOrientation) {
    problems.push(`low-confidence system_purpose ${primaryType || 'unknown'} (${confidence})`);
  }
  if (/^(authentication|auth|identity|login|user|users)$/i.test(domain) && hasBroadNonAuthEvidence(cas)) {
    problems.push(`primary domain "${domain}" is narrower than the repo evidence`);
  }
  const unsupportedDomain = domainUnsupportedByEvidence(domain, cas);
  if (unsupportedDomain) problems.push(unsupportedDomain);
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
  if (/^(?:it|this|the)\s+(?:software\s+)?(?:system\s+)?(?:provides|supports|handles|coordinates|manages|uses|defines|processes)\b/i.test(description)) {
    problems.push('system narrative starts generically instead of naming the system or domain');
  }
  if (looksLikeInventorySummary(description)) problems.push('system narrative is a CAS inventory/template summary');
  if (/\bentry points?\b/i.test(description)) problems.push('system narrative describes analyzer mechanics instead of product behavior');
  if (/\b(main interaction surfaces?|configured interaction surfaces?|interaction surfaces?|http endpoints?|route surfaces?|application routes?|page routes?|application pages?|cli commands?|command-line workflows?|schedule surfaces?|scheduled workflows?|state stores?)\b/i.test(description) ||
    /\b(?:http|api|route|websocket|page|ui|application)(?:,?\s+(?:and\s+)?(?:http|api|route|websocket|page|ui|application))*[-\s]*(?:based\s+)?(?:workflows?|interactions?)\b/i.test(description)) {
    problems.push('system narrative describes source/entry mechanics instead of product behavior');
  }
  if (isKlauroSelfAnalysis(cas) && /\bfocus(?:ed|es|ing)?\s+on\s+security,\s+access control,\s+and\s+verification\b/i.test(description)) {
    problems.push('Klauro self narrative overweights security instead of codebase visibility');
  }
  if (/\b(?:@[\w.-]+\/[\w./-]+|[\w.-]+\/[\w./-]+\.js|lit\/directives\/|dist\/providers\/)\b/i.test(description) ||
    /(?:^|\s)(?:@\/|~\/|\.{1,2}\/|\/)[\w./-]+/.test(description)) {
    problems.push('system narrative includes source module paths as external services');
  }
  if (/\bexternal services?\b/i.test(description)) {
    problems.push('system narrative uses generic implementation/service wording instead of concrete product behavior');
  }
  if (/\b(?:controller|service|repository) outputs?\b/i.test(description) ||
    /\b(?:controller|service|repository) components?\b/i.test(description) ||
    /\bdeterministic stages?\b/i.test(description) ||
    /\bserver routes?\b/i.test(description) ||
    /\b(?:react components?|express routes?|route handlers?|api routes?|framework routes?)\b/i.test(description) ||
    /\bsdk interactions?\b/i.test(description) ||
    /\bdatabase quer(?:y|ies)\b/i.test(description) ||
    /\bfile existence\b/i.test(description) ||
    /\bbusiness logic\b/i.test(description) ||
    /\bexternal stores?\b/i.test(description) ||
    /\broute transitions?\b/i.test(description) ||
    /\bstate mutations?\b/i.test(description) ||
    /\bexception handling\b/i.test(description) ||
    /\btoken-based access control\b/i.test(description) ||
    /\b[A-Za-z_]\w*(?:Service|Repository|Controller|Store)\b/.test(description) ||
    /\b[A-Za-z_]\w*\.slice\b/i.test(description) ||
    /\b[a-z][\w-]*\.store\b/i.test(description)) {
    problems.push('system narrative includes internal code symbols instead of product concepts');
  }
  if (/\bworkflows\s+workflows\b/i.test(description) || /\bmodel centers on\s+user\b/i.test(description)) {
    problems.push('system narrative contains generic or malformed workflow wording');
  }
  if (/\bbuilt with\s+none detected\b/i.test(description) ||
    (/\b(scheduling-platform|developer-platform|commerce-platform|knowledge-base)\b/.test(`${clean(cas.enhanced_system_purpose?.primary_domain)} ${clean(cas.enhanced_system_purpose?.primary_type || cas.system_purpose?.primary_type)}`) &&
      /\bbuilt with\s+(?:react|express|react router|next(?:\.js|js)?|none detected)(?:,|\s|\.|$)/i.test(description))) {
    problems.push('system narrative leads with framework/runtime inventory instead of product behavior');
  }
  if (/\bbuilt with\s+(?:a\s+)?mixed\s+[^.]{0,80}\s+monorepo\b/i.test(description) ||
    /\bmixed\s+[^.]{0,80}\s+monorepo\s+that\s+coordinates\b/i.test(description) ||
    /\b(canvas objects?|synced objects?|travelNodes|archivedInCollection|inCollection|removeDocument|unarchivedInCollection)\b/i.test(description)) {
    problems.push('system narrative is polluted by example/internal entities instead of product identity');
  }
  if (/\b(codebase focused|c# analysis|json processing|request\s+\d{1,3}(?:\.\d{1,3}){3}|database interactions?|command-line interfaces?|toolchain tools|processing stages?|context-level operations?|terminal command execution|structured operations)\b/i.test(description)) {
    problems.push('system narrative includes low-level implementation mechanics instead of product concepts');
  }
  if (/\bintegrates with postgres\b/i.test(description) ||
    /\bmanages\s+[a-z ]{3,80}\s+workflows\b/i.test(description)) {
    problems.push('system narrative uses generic workflow/storage phrasing instead of product boundaries');
  }
  if (/\b(authentication criteria|resource checks?|data lookup behavior|content-related operations|reads and writes data related)\b/i.test(description) ||
    /\bmain grounded concepts are\b[^.]*\b(?:soap|ext|management|theme|usage|payment|user|alert|analytics)\b/i.test(description)) {
    problems.push('system narrative uses generic data mechanics instead of product concepts');
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
  if (source === 'deterministic') problems.push(`deterministic system narrative (${generation?.status || 'no generation status'}); default CAS analysis requires AI or degraded provenance`);
  if (problems.length > 0) score = problems.some(problem => /AI narrative generation|stale reused|deterministic/.test(problem)) ? 55 : 70;
  return gate('narrative-provenance', score, problems.length ? problems.join('; ') : `${source || 'unknown'} narrative`);
}

function scoreCapabilityQuality(cas: CASOutput): SpotReadGate {
  const capabilities = cas.system_capabilities || [];
  if (capabilities.length === 0) return gate('capability-quality', 0, 'no capabilities inferred');
  const visibleCapabilities = Array.isArray((cas as any).product_map?.capabilities)
    ? (cas as any).product_map.capabilities
    : capabilities;
  const domain = clean(cas.enhanced_system_purpose?.primary_domain);
  const primaryType = clean(cas.enhanced_system_purpose?.primary_type || cas.system_purpose?.primary_type);
  const weak = capabilities.filter(capability => isWeakCapability(capability));
  const weakPrimary = capabilities.slice(0, Math.min(8, capabilities.length)).filter(capability => isWeakCapability(capability));
  const weakVisiblePrimary = visibleCapabilities
    .slice(0, Math.min(8, visibleCapabilities.length))
    .filter((capability: any) => isWeakCapability(capability));
  const networkCapabilities = capabilities.filter(capability =>
    /\b(Network Connection Control|Device Enrollment|Organization Access Context|Signal Synchronization)\b/i.test(clean(capability.name))
  );
  const networkCapabilityMismatch = networkCapabilities.length > 0 &&
    !/\b(zero-trust-security|network-access-management|network-access-control|network-access-platform|security-scanning-tool)\b/i.test(`${domain} ${primaryType}`);
  const primaryCapabilities = capabilities.slice(0, Math.min(6, capabilities.length));
  const genericPrimary = primaryCapabilities.filter(capability => isGenericPrimaryCapability(capability));
  const primaryDomainSpecificCount = primaryCapabilities.filter(capability => isDomainSpecificCapabilityForDomain(capability, domain)).length;
  const domainSpecificLater = capabilities.slice(3).some(capability => isDomainSpecificCapabilityForDomain(capability, domain));
  const genericPrimaryMismatch = domainSpecificLater && genericPrimary.length >= 2;
  const visiblePrimaryCapabilities = visibleCapabilities.slice(0, Math.min(6, visibleCapabilities.length));
  const visibleGenericPrimary = visiblePrimaryCapabilities.filter((capability: any) => isGenericPrimaryCapability(capability));
  const visiblePrimaryDomainSpecificCount = visiblePrimaryCapabilities.filter((capability: any) => isDomainSpecificCapabilityForDomain(capability, domain)).length;
  const visibleDomainSpecificLater = visibleCapabilities
    .slice(3)
    .some((capability: any) => isDomainSpecificCapabilityForDomain(capability, domain));
  const visibleGenericPrimaryMismatch = visibleDomainSpecificLater && visibleGenericPrimary.length >= 2;
  const expectsDomainSpecificPrimary = Boolean(domain) && !/^(unknown|application|service|library-package|testing-utilities)$/i.test(domain);
  const primaryDomainMismatch = expectsDomainSpecificPrimary && primaryCapabilities.length >= 4 && primaryDomainSpecificCount < 3;
  const visiblePrimaryDomainMismatch = expectsDomainSpecificPrimary && visiblePrimaryCapabilities.length >= 4 && visiblePrimaryDomainSpecificCount < 3;
  const weakRatio = weak.length / capabilities.length;
  let score = 100 - Math.round(weakRatio * 100);
  if (weakPrimary.length > 0) score = Math.min(score, 65);
  if (weakVisiblePrimary.length > 0) score = Math.min(score, 65);
  if (networkCapabilityMismatch) score = Math.min(score, 50);
  if (genericPrimaryMismatch) score = Math.min(score, 60);
  if (visibleGenericPrimaryMismatch) score = Math.min(score, 55);
  if (primaryDomainMismatch) score = Math.min(score, 60);
  if (visiblePrimaryDomainMismatch) score = Math.min(score, 55);
  const problems: string[] = [];
  if (weak.length) problems.push(`weak capability labels/descriptions (${weak.length}/${capabilities.length}): ${weak.slice(0, 8).map(capability => clean(capability.name) || capability.id).join(', ')}`);
  if (weakVisiblePrimary.length) problems.push(`weak visible primary capabilities: ${weakVisiblePrimary.map((capability: any) => clean(capability.name) || capability.id).join(', ')}`);
  if (networkCapabilityMismatch) problems.push(`network-access capabilities conflict with domain ${domain || 'missing'}`);
  if (genericPrimaryMismatch) problems.push(`generic capabilities outrank domain capabilities: ${genericPrimary.map(capability => clean(capability.name)).join(', ')}`);
  if (visibleGenericPrimaryMismatch) problems.push(`generic product-map capabilities outrank domain capabilities: ${visibleGenericPrimary.map((capability: any) => clean(capability.name)).join(', ')}`);
  if (primaryDomainMismatch) problems.push(`primary capabilities do not match domain ${domain}: ${primaryCapabilities.map(capability => clean(capability.name)).join(', ')}`);
  if (visiblePrimaryDomainMismatch) problems.push(`visible product-map capabilities do not match domain ${domain}: ${visiblePrimaryCapabilities.map((capability: any) => clean(capability.name)).join(', ')}`);
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
  const domain = clean(cas.enhanced_system_purpose?.primary_domain);
  const problems: string[] = [];
  for (const idiom of idioms) {
    const category = clean(idiom.category);
    if (category === 'migrations' && !idiomHasMigrationEvidence(idiom)) {
      problems.push(`migration idiom has no migration evidence (${idiom.name})`);
    }
    if (profileKind === 'infrastructure' && domain === 'cloud-infrastructure' && INFRA_IDIOM_FALSE_POSITIVE_CATEGORIES.has(category)) {
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
  if (/\b(?:Backup Code Management|Billing Management|Network Access Control|Amount Settlement|Trading Management|Token Balance Discovery|Token Launch Monitoring)\b/i.test(name) && description.length >= 50) return false;
  if (/^(Container|Scaffold|Sized|Result|Layer|Layers|Call|Forward|Weight Norm|Jit|Nets|Gui|Prepare Scriptable|Drag|Edit|Javascript|Day|Migrate|Type|Timezone|Require Access|Duplicate Task|Printt|Hooks Hooks|Boundary|Sentry|Mutate|Settled|Capture Exception|Token|Prefetch|Fallback|Material|Gesture Detector|Len|Matmul Relative|Atom|Bulk|Busy|Duplicate|Allowed|Boolean|Code|Define|Doc|Docs|Gen|Mdx|Meta|Tabs|Tick|And|Can|Definitions|Emoji|Field|Fields|Array|Attributes|Description|Functions?|Regular|Duration|Factory|Fixtures? Fixture|Background|Design|Loader|Mobile|Multiplayer|Socket|Category|Confirm|Hashed|Non|Upload|Synced|Static|Canvas|Klauro|Number|Avatar|Game|Lobby|Mfaenroll|Mfaverify|Rectangle|Rendered|Splash|Circle|Alert|Alerts?|Sign|Signs?)\s+(Management|Workflow|Capability|Settlement)$/i.test(name)) return true;
  if (/\b(?:bin\/console|events handlers|message handlers|http handlers)\b/i.test(combined)) return true;
  if (/\b([a-z]+)s?\s+(analysis|management|workflow|reporting|generation)\s+\1\s+\2\b/i.test(name)) return true;
  if (/\b(?:bad|not|tab|web|poll|usd|pnl|alpha|config|save|destroy|bind|branding|graph|control|picker|radius|seed|merge|has|serializer|lookup|javascript|migrate|timezone|printt|boundary|sentry|mutate|settled|token|prefetch|material|gesture detector|len|matmul relative|atom|bulk|busy|duplicate|allowed|boolean|code|define|doc|docs|gen|mdx|meta|tabs|tick|and|can|definitions|emoji|field|fields|array|attributes|description|function|functions|regular|duration|factory|fixtures? fixture|background|design|loader|mobile|multiplayer|socket|category|confirm|hashed|non|upload|synced|static|canvas|klauro|number|avatar|game|lobby|mfaenroll|mfaverify|rectangle|rendered|splash|circle|alert|alerts|sign|signs)\s+management\b/i.test(name)) return true;
  if (/\bCapability$/i.test(name)) return true;
  if (/^[A-Z]?[a-z]+(?:[A-Z][a-z0-9]+)+(?: Workflow| Management| Capability)?$/.test(name)) return true;
  if (/\b(?:mutation|query|handler|controller|route|page|component|command|function|method|file|event|message|http|api|graphql)\s+management\b/i.test(name)) return true;
  if (description.length < 50) return true;
  if (/\b(?:operations for|handles? operations|coordinates? operations|internal files?|specific functions?|helper functions?|routes?|handlers?|ui components?|source components?)\b/i.test(description)) return true;
  return false;
}

function isGenericPrimaryCapability(capability: any): boolean {
  const name = clean(capability?.name);
  return /\b(user|users|auth|authentication|login|register|signup|sign|payments?|billing|alerts?|analytics|database|admin|settings?|styles?|theme|logo|facebook)\s+(management|reporting|generation|workflow)\b/i.test(name);
}

function isDomainSpecificCapabilityForDomain(capability: any, domain: string): boolean {
  const text = `${clean(capability?.name)} ${clean(capability?.description)} ${(capability?.related_domains || []).join(' ')}`.toLowerCase();
  if (/solana|trading|arbitrage|portfolio/.test(domain)) {
    return /\b(arbitrage|trade|trading|wallet|wallets|market|signal|price|token|balance|jupiter|raydium|drift|swap|transfer|passkey|portfolio|allocation|position|risk|limit|hedge|geyser)\b/.test(text);
  }
  if (/user-identity|identity|auth|access-control|webauthn/.test(domain)) {
    return /\b(identity|user|account|credential|password|token|session|refresh|authorize|authorization|permission|role|scope|access|webauthn|mfa|backup code|device|organization|network|signal|username)\b/.test(text);
  }
  if (/venue|booking/.test(domain)) {
    return /\b(venue|booking|host|geo|geocode|availability|checkout)\b/.test(text);
  }
  if (/fleet/.test(domain)) {
    return /\b(fleet|vehicle|driver|fuel|maintenance|odometer|ifta|dispatch)\b/.test(text);
  }
  if (/clinical|medical/.test(domain)) {
    return /\b(clinical|patient|measurement|muscle|force|device|report)\b/.test(text);
  }
  if (/publishing|content-publishing/.test(domain)) {
    return /\b(publishing|post|page|author|member|newsletter|theme|publication|content)\b/.test(text);
  }
  if (/no-code-database/.test(domain)) {
    return /\b(no-code|database|table|field|relation|spreadsheet|view|api|workspace)\b/.test(text);
  }
  if (/audio|content/.test(domain)) {
    return /\b(audio|song|track|transcript|voice|vocal|demucs|rmvpe|fcpe|music)\b/.test(text);
  }
  if (/cloud-infrastructure|infrastructure/.test(domain)) {
    return /\b(cloud|aws|iam|access|security group|network|compute|instance|ssm|database|rds|subnet|vpc|container|registry|ecr|load balancer|lb|listener|route53|terraform|opentofu|infrastructure|deployment)\b/.test(text);
  }
  if (/website|marketing|frontend/.test(domain)) {
    return /\b(platform|product|solution|company|careers|contact|privacy|terms|page|website|marketing|landing|content)\b/.test(text);
  }
  if (/network|zero-trust|security/.test(domain)) {
    return /\b(network|device|organization|access|posture|policy|gateway|signal|connection|connect|enrollment|auth0|webauthn|username|backup code|endpoint)\b/.test(text);
  }
  if (/codebase-analysis|devtools/.test(domain)) {
    return /\b(codebase|analysis|cas|agent|mcp|runtime|idiom|incremental)\b/.test(text);
  }
  if (/scheduling|booking/.test(domain)) {
    return /\b(scheduling|booking|calendar|availability|appointment|meeting|event type|routing form)\b/.test(text);
  }
  if (/developer-platform|backend-as-a-service|database-platform/.test(domain)) {
    return /\b(developer|database|postgres|authentication|realtime|storage|function|sdk|api|project|deployment)\b/.test(text);
  }
  if (/commerce-platform|ecommerce/.test(domain)) {
    return /\b(commerce|product|cart|checkout|order|inventory|payment|fulfillment|customer)\b/.test(text);
  }
  if (/knowledge|wiki|document/.test(domain)) {
    return /\b(knowledge|wiki|document|collection|comment|revision|permission|search|share)\b/.test(text);
  }
  if (/internal-tools|low-code/.test(domain)) {
    return /\b(app builder|internal tool|data source|automation|workspace|permission|deployment)\b/.test(text);
  }
  if (/photo|media/.test(domain)) {
    return /\b(photo|video|media|asset|album|backup|upload|face|sharing|search)\b/.test(text);
  }
  if (/federated-social|social/.test(domain)) {
    return /\b(social|timeline|account|status|follow|activitypub|federation|moderation|notification)\b/.test(text);
  }
  if (/product-analytics/.test(domain)) {
    return /\b(product analytics|event|funnel|cohort|feature flag|experiment|session replay|dashboard)\b/.test(text);
  }
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

function domainUnsupportedByEvidence(domain: string, cas: CASOutput): string | undefined {
  const values = [
    clean(cas.enhanced_system_purpose?.inferred_description),
    ...(cas.system_capabilities || []).map(capability => `${capability.name} ${capability.description || ''}`),
    ...(cas.domain_concepts || []).map(concept => concept.name),
    ...(cas.data_entities || []).map(entity => entity.name),
    ...(cas.nodes || []).slice(0, 300).map(node => `${node.name} ${node.source?.file || ''}`),
  ].join(' ').toLowerCase();
  if (/^portfolio-management$/.test(domain)) {
    const financeSignals = /\b(portfolio|investment|investor|trading|trade|asset|assets|crypto|token|wallet|account balance|liquidation|settlement|payment|billing|invoice|checkout|cart)\b/.test(values);
    const networkSignals = ['network', 'device', 'access', 'policy', 'tenant', 'central', 'onboard', 'gateway']
      .filter(token => new RegExp(`\\b${token}\\b`).test(values)).length;
    const venueSignals = /\b(venue|venues|booking|bookings|host|style|styles)\b/.test(values);
    const tradingSignals = /\b(solana|arbitrage|dex|swap|token balance|trade execution|portfolio holdings|investment)\b/.test(values);
    if (venueSignals && !tradingSignals) {
      return `portfolio-management domain conflicts with venue-booking evidence`;
    }
    if (!financeSignals && networkSignals >= 4) {
      return `portfolio-management domain lacks finance/trading evidence or conflicts with network/device evidence`;
    }
  }
  if (domain === 'tray-icon-library') {
    const artifact = clean((cas.enhanced_system_purpose as any)?.artifact_type).toLowerCase();
    const root = clean(cas.system?.root_path || (cas as any).project?.root_path).toLowerCase();
    const hasTrayArtifactEvidence = artifact === 'library' || /\b(ztray|tray[-_]?icon|system[-_]?tray)\b/.test(root);
    if (!hasTrayArtifactEvidence) {
      return `tray-icon-library domain lacks library/artifact evidence`;
    }
  }
  if (/^clinical-testing$/.test(domain)) {
    const hasClinicalProjectEvidence = /\b(patient|clinical|muscle|myotest|rehabilitation|inclinometry|grip|pinch)\b/.test(values);
    if (!hasClinicalProjectEvidence) {
      return `clinical-testing domain lacks clinical product evidence`;
    }
  }
  if (/\b(clinical measurements|clinical reporting|patient records|device connectivity)\b/.test(values) &&
    !/\b(clinical|patient|muscle|myotest|rehabilitation|inclinometry|grip|pinch)\b/.test(values)) {
    return `clinical capabilities appear without clinical product evidence`;
  }
  if (domain === 'developer-platform') {
    const hasDeveloperPlatformEvidence = /\b(supabase|appwrite|developer platform|backend as a service|open source firebase alternative|postgres|realtime|storage|edge functions)\b/.test(values);
    if (!hasDeveloperPlatformEvidence) return `developer-platform domain lacks platform evidence`;
  }
  if (domain === 'scheduling-platform') {
    const hasSchedulingEvidence = /\b(scheduling|booking|bookings|calendar|availability|appointment|meeting|event type)\b/.test(values);
    if (!hasSchedulingEvidence) return `scheduling-platform domain lacks scheduling evidence`;
  }
  if (domain === 'knowledge-base') {
    const hasKnowledgeEvidence = /\b(knowledge base|team wiki|documents|collections|revision|collaborative documentation|outline)\b/.test(values);
    if (!hasKnowledgeEvidence) return `knowledge-base domain lacks document collaboration evidence`;
  }
  if (/^solana-arbitrage$/.test(domain) && !/\barbitrage\b/.test(values)) {
    return `solana-arbitrage domain lacks explicit arbitrage evidence`;
  }
  if (/^(product-data-management|product-management)$/.test(domain)) {
    const networkSignals = ['zero trust', 'network', 'device', 'access', 'policy', 'verification', 'gateway']
      .filter(token => values.includes(token)).length;
    if (networkSignals >= 4) return `product-data domain hides network-access/security evidence`;
  }
  if (/\bportfolio\b/.test(domain) && /\b(audio|voice|venue|device|game|security)\b/.test(domain)) {
    return `portfolio domain is mixed with unrelated product vocabulary (${domain})`;
  }
  if (/\bgame-security\b/.test(domain)) {
    return `game domain is mislabeled as security (${domain})`;
  }
  if (domain === 'codebase-analysis' && !isKlauroSelfAnalysis(cas)) {
    return `codebase-analysis domain lacks Klauro/self-analysis evidence`;
  }
  return undefined;
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
      pattern: /\bportfolio management system\b|\bportfolio management context\b|\binvestment management system\b|\bmanaged investments?\b/,
      allowed: /\b(portfolio[-a-z]*management|investment|trading-automation|solana-arbitrage|solana-trading)\b/,
    },
    {
      label: 'trading-automation claim conflicts with purpose/domain',
      pattern: /\btrading automation system\b|\barbitrage trading system\b|\btoken purchase execution\b/,
      allowed: /\b(trading-automation|solana-arbitrage|solana-trading)\b/,
    },
    {
      label: 'network-access/security claim conflicts with purpose/domain',
      pattern: /\bzero[- ]trust\b|\bnetwork access management system\b|\bsecurity scanning tool\b/,
      allowed: /\b(zero-trust-security|zero-trust-website|network-access-management|security-scanning-tool|network-access-platform)\b/,
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
      pattern: /\bcodebase analysis\b|\bcas graph\b|\bagent contexts?\b/,
      allowed: /\b(codebase-analysis)\b/,
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
