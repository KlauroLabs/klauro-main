import * as fs from 'fs-extra';
import * as path from 'path';
import { discoverRealRepos, type RealRepoTarget } from './repo-discovery';
import { analyzeProject } from './analyzer';
import type {
  CASOutput,
  CASEntryPoint,
  CASExitPoint,
  CASArchitectureSummary,
} from '../../backend/src/types/cas.types';

interface GeneratorOptions {
  devRoot: string;
  outputDir: string;
  maxRepos?: number;
  resume?: boolean;
}

interface RepoDocumentationResult {
  name: string;
  slug: string;
  path: string;
  status: 'documented' | 'failed';
  docFile?: string;
  systemType?: string;
  stack?: string;
  nodeCount?: number;
  embeddingCoverage?: string;
  durationMs: number;
  error?: string;
}

function parseArgs(argv: string[]): GeneratorOptions {
  let devRoot = path.join(process.env.HOME || '', 'dev');
  let outputDir = path.join(process.cwd(), '.unravl-repo-documentation');
  let maxRepos: number | undefined;
  let resume = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dev-root') {
      devRoot = path.resolve(argv[++i]);
    } else if (arg === '--output') {
      outputDir = path.resolve(argv[++i]);
    } else if (arg === '--max-repos') {
      maxRepos = Number(argv[++i]);
    } else if (arg === '--resume') {
      resume = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: tsx src/repo-documentation.ts [--dev-root <path>] [--output <dir>] [--max-repos <n>] [--resume]');
      process.exit(0);
    }
  }

  return { devRoot, outputDir, maxRepos, resume };
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
}

function parseExistingDoc(markdown: string): {
  systemType?: string;
  stack?: string;
  nodeCount?: number;
  embeddingCoverage?: string;
} {
  const match = (re: RegExp): string | undefined => {
    const found = markdown.match(re);
    return found ? found[1].trim() : undefined;
  };
  const systemType = match(/- \*\*System type:\*\* (.+)/);
  const stack = match(/- \*\*Languages:\*\* (.+)/);
  const nodeCountText = match(/- \*\*Nodes:\*\* (\d+)/);
  const coverage = markdown.match(
    /- \*\*Embedding coverage:\*\* (\d+) embedded, (\d+) skipped, (\d+) failed/,
  );

  let embeddingCoverage: string | undefined;
  if (coverage) {
    const embedded = Number(coverage[1]);
    const total = embedded + Number(coverage[2]) + Number(coverage[3]);
    embeddingCoverage = total === 0 ? '0%' : `${((embedded / total) * 100).toFixed(0)}%`;
  } else if (/- \*\*Embedding index:\*\* not generated/.test(markdown)) {
    embeddingCoverage = 'none';
  }

  return {
    systemType,
    stack: stack || 'unknown',
    nodeCount: nodeCountText ? Number(nodeCountText) : undefined,
    embeddingCoverage,
  };
}

function groupByType<T extends { type: string }>(items: T[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item.type, (counts.get(item.type) || 0) + 1);
  }
  return counts;
}

function describePurpose(cas: CASOutput): string {
  const enhanced = cas.enhanced_system_purpose;
  if (enhanced?.inferred_description) {
    return enhanced.inferred_description;
  }
  const purpose = cas.system_purpose;
  if (purpose) {
    const evidence = purpose.evidence?.slice(0, 3).join('; ');
    return `Inferred as a ${purpose.primary_type} system (confidence ${(purpose.confidence * 100).toFixed(0)}%).${evidence ? ` Evidence: ${evidence}.` : ''}`;
  }
  return cas.system.description || 'No inferred purpose available.';
}

function renderLayer(label: string, layer: Record<string, number | undefined> | undefined): string | undefined {
  if (!layer) return undefined;
  const parts = Object.entries(layer)
    .filter(([, value]) => typeof value === 'number' && value > 0)
    .map(([key, value]) => `${key.replace(/_/g, ' ')}: ${value}`);
  if (parts.length === 0) return undefined;
  return `- **${label}** — ${parts.join(', ')}`;
}

function renderArchitecture(summary: CASArchitectureSummary | undefined): string {
  if (!summary) return '_No architecture summary available._';
  const lines: string[] = [];
  const layers = [
    renderLayer('Presentation', summary.layers.presentation),
    renderLayer('Business', summary.layers.business),
    renderLayer('Data', summary.layers.data),
    renderLayer('Infrastructure', summary.layers.infrastructure),
  ].filter((line): line is string => Boolean(line));
  if (layers.length > 0) {
    lines.push('Architecture layers:', '', ...layers);
  } else {
    lines.push('_No populated architecture layers._');
  }
  return lines.join('\n');
}

function renderPointGroups(label: string, counts: Map<string, number>): string {
  if (counts.size === 0) return `_No ${label.toLowerCase()} detected._`;
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([type, count]) => `- ${type}: ${count}`)
    .join('\n');
}

function buildRepoMarkdown(cas: CASOutput, durationMs: number): string {
  const system = cas.system;
  const lines: string[] = [];

  lines.push(`# ${system.name}`);
  lines.push('');

  lines.push('## What it is');
  lines.push('');
  lines.push(`- **Name:** ${system.name}`);
  lines.push(`- **System type:** ${system.type}`);
  lines.push(`- **Root path:** ${system.root_path}`);
  lines.push('');
  lines.push(describePurpose(cas));
  lines.push('');

  lines.push('## What it does');
  lines.push('');
  const concepts = (cas.domain_concepts || [])
    .slice()
    .sort((left, right) => right.frequency - left.frequency)
    .slice(0, 12);
  if (concepts.length > 0) {
    lines.push('Domain concepts:');
    lines.push('');
    for (const concept of concepts) {
      lines.push(`- **${concept.name}** (${concept.classification}, frequency ${concept.frequency})`);
    }
  } else {
    lines.push('_No domain concepts detected._');
  }
  lines.push('');
  const workflows = (cas.workflows || cas.workflow_graph?.workflows || [])
    .filter(workflow => workflow.classification === 'primary')
    .slice(0, 8);
  if (workflows.length > 0) {
    lines.push('Top workflows:');
    lines.push('');
    for (const workflow of workflows) {
      lines.push(`- **${workflow.name}** (${workflow.workflow_type}, ${workflow.criticality}) — ${workflow.description}`);
    }
    lines.push('');
  }
  const capabilities = (cas.system_capabilities || [])
    .filter(capability => capability.category === 'core')
    .slice(0, 8);
  if (capabilities.length > 0) {
    lines.push('Core capabilities:');
    lines.push('');
    for (const capability of capabilities) {
      lines.push(`- **${capability.name}** (${capability.criticality}) — ${capability.description}`);
    }
    lines.push('');
  }

  lines.push('## How it\'s built');
  lines.push('');
  const tech = system.technologies;
  const languages = (tech?.languages || [])
    .map(language => language.version ? `${language.name} ${language.version}` : language.name);
  if (languages.length > 0) {
    lines.push(`- **Languages:** ${languages.join(', ')}`);
  }
  const frameworks = (tech?.frameworks || []).map(framework => framework.name);
  if (frameworks.length > 0) {
    lines.push(`- **Frameworks:** ${frameworks.join(', ')}`);
  }
  if (tech?.runtime) {
    lines.push(`- **Runtime:** ${tech.runtime}`);
  }
  if (tech?.databases && tech.databases.length > 0) {
    lines.push(`- **Databases:** ${tech.databases.join(', ')}`);
  }
  const validLibraryName = /^@?[a-zA-Z0-9][\w./-]*$/;
  const validLibraryVersion = /^[0-9a-zA-Z][\w.+-]*$/;
  const topLibraries = (cas.libraries || [])
    .filter(library => validLibraryName.test((library.name || '').trim()))
    .slice()
    .sort((left, right) => (right.usage_statistics?.import_count || 0) - (left.usage_statistics?.import_count || 0))
    .slice(0, 10)
    .map(library => {
      const version = (library.version || '').trim();
      return validLibraryVersion.test(version) ? `${library.name}@${version}` : library.name;
    });
  if (topLibraries.length > 0) {
    lines.push(`- **Libraries:** ${topLibraries.join(', ')}`);
  }
  lines.push('');
  lines.push(renderArchitecture(cas.architecture_summary));
  lines.push('');
  lines.push('Entry points by type:');
  lines.push('');
  lines.push(renderPointGroups('entry points', groupByType<CASEntryPoint>(cas.entry_points || [])));
  lines.push('');
  lines.push('Exit points by type:');
  lines.push('');
  lines.push(renderPointGroups('exit points', groupByType<CASExitPoint>(cas.exit_points || [])));
  lines.push('');
  const externalServices = cas.external_services || [];
  if (externalServices.length > 0) {
    lines.push('External services:');
    lines.push('');
    for (const service of externalServices.slice(0, 12)) {
      lines.push(`- **${service.name}** (${service.type})`);
    }
    lines.push('');
  }

  lines.push('## Metrics');
  lines.push('');
  lines.push(`- **Nodes:** ${cas.nodes.length}`);
  lines.push(`- **Edges:** ${cas.edges.length}`);
  lines.push(`- **Entry points:** ${(cas.entry_points || []).length}`);
  lines.push(`- **Exit points:** ${(cas.exit_points || []).length}`);
  const test = cas.test_summary;
  if (test) {
    lines.push(`- **Tests:** ${test.total_tests} total (${test.by_status.passing} passing, ${test.by_status.failing} failing, ${test.by_status.skipped} skipped)`);
    if (typeof test.coverage.overall_percentage === 'number') {
      lines.push(`- **Test coverage:** ${test.coverage.overall_percentage.toFixed(1)}%`);
    }
  } else {
    lines.push('- **Tests:** no test summary available');
  }
  const quality = system.quality;
  if (quality) {
    const round = (value: number): string => (Number.isInteger(value) ? String(value) : value.toFixed(1));
    const qualityParts: string[] = [];
    if (typeof quality.code_quality_score === 'number') qualityParts.push(`code quality ${round(quality.code_quality_score)}`);
    if (typeof quality.maintainability_index === 'number') qualityParts.push(`maintainability ${round(quality.maintainability_index)}`);
    if (typeof quality.complexity_score === 'number') qualityParts.push(`complexity ${round(quality.complexity_score)}`);
    if (typeof quality.documentation_coverage === 'number') qualityParts.push(`documentation coverage ${quality.documentation_coverage.toFixed(1)}%`);
    if (qualityParts.length > 0) {
      lines.push(`- **Quality:** ${qualityParts.join(', ')}`);
    }
  }
  const riskSummary = cas.change_risk_summary;
  if (riskSummary) {
    lines.push(`- **High-risk nodes:** ${riskSummary.high_risk_nodes.length}, untested critical paths: ${riskSummary.untested_critical_paths.length}, recent hotspots: ${riskSummary.recent_hotspots.length}`);
  }
  lines.push('');

  lines.push('## Benchmarks');
  lines.push('');
  const embedding = cas.embedding_index;
  if (embedding) {
    lines.push(`- **Embedding model:** ${embedding.model} (${embedding.provider}, ${embedding.dimensions}d, store ${embedding.store})`);
    lines.push(`- **Embedding coverage:** ${embedding.coverage.embedded} embedded, ${embedding.coverage.skipped} skipped, ${embedding.coverage.failed} failed`);
    if (embedding.degraded) {
      lines.push(`- **Embedding status:** degraded${embedding.degraded_reason ? ` — ${embedding.degraded_reason}` : ''}`);
    } else {
      lines.push('- **Embedding status:** healthy');
    }
  } else {
    lines.push('- **Embedding index:** not generated');
  }
  lines.push(`- **Analysis duration:** ${(durationMs / 1000).toFixed(1)}s`);
  const errors = cas.analysis_errors || [];
  const errorCount = errors.filter(error => error.severity === 'error').length;
  const warningCount = errors.filter(error => error.severity === 'warning').length;
  lines.push(`- **Analysis errors:** ${errorCount} errors, ${warningCount} warnings`);
  lines.push('');
  lines.push(`_Generated ${new Date().toISOString()} from analysis ${cas.analysis_id}._`);
  lines.push('');

  return lines.join('\n');
}

function embeddingCoverageLabel(cas: CASOutput): string {
  const embedding = cas.embedding_index;
  if (!embedding) return 'none';
  const total = embedding.coverage.embedded + embedding.coverage.skipped + embedding.coverage.failed;
  if (total === 0) return '0%';
  return `${((embedding.coverage.embedded / total) * 100).toFixed(0)}%`;
}

function stackLabel(cas: CASOutput): string {
  const languages = (cas.system.technologies?.languages || []).map(language => language.name);
  return languages.length > 0 ? languages.join(', ') : 'unknown';
}

function buildIndexMarkdown(results: RepoDocumentationResult[], devRoot: string): string {
  const lines: string[] = [];
  lines.push('# Repository Documentation Index');
  lines.push('');
  lines.push(`Generated ${new Date().toISOString()} from \`${devRoot}\`.`);
  lines.push('');

  const documented = results.filter(result => result.status === 'documented');
  const failed = results.filter(result => result.status === 'failed');

  lines.push('| Repository | Type | Stack | Nodes | Embedding coverage | Doc |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const result of results) {
    if (result.status === 'documented') {
      lines.push(`| ${result.name} | ${result.systemType || '-'} | ${result.stack || '-'} | ${result.nodeCount ?? '-'} | ${result.embeddingCoverage || '-'} | [${result.slug}.md](./${result.slug}.md) |`);
    } else {
      lines.push(`| ${result.name} | failed | - | - | - | - |`);
    }
  }
  lines.push('');
  lines.push('## Totals');
  lines.push('');
  lines.push(`- **Repositories documented:** ${documented.length}`);
  lines.push(`- **Failures:** ${failed.length}`);
  lines.push(`- **Total nodes across documented repos:** ${documented.reduce((sum, result) => sum + (result.nodeCount || 0), 0)}`);
  if (failed.length > 0) {
    lines.push('');
    lines.push('## Failures');
    lines.push('');
    for (const result of failed) {
      lines.push(`- **${result.name}** (\`${result.path}\`) — ${result.error}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

async function generateDocumentation(options: GeneratorOptions): Promise<RepoDocumentationResult[]> {
  const discovery = await discoverRealRepos(options.devRoot);
  const eligible: RealRepoTarget[] = discovery.repos.filter(repo => repo.status === 'eligible');

  const canonicalSeen = new Set<string>();
  let targets: RealRepoTarget[] = eligible.filter(target => {
    let canonical = target.path;
    try {
      canonical = fs.realpathSync(target.path);
    } catch {
      canonical = path.resolve(target.path);
    }
    if (canonicalSeen.has(canonical)) return false;
    canonicalSeen.add(canonical);
    return true;
  });

  if (typeof options.maxRepos === 'number') {
    targets = targets.slice(0, options.maxRepos);
  }

  await fs.ensureDir(options.outputDir);
  const results: RepoDocumentationResult[] = [];

  const nameCounts = new Map<string, number>();
  for (const target of targets) {
    nameCounts.set(target.name, (nameCounts.get(target.name) || 0) + 1);
  }

  console.log(`Documenting ${targets.length} eligible repos under ${discovery.dev_root}`);

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const slug = (nameCounts.get(target.name) || 0) > 1
      ? slugify(`${path.basename(path.dirname(target.path))}-${target.name}`)
      : slugify(target.name);
    const progress = `[${i + 1}/${targets.length}]`;
    const docFile = path.join(options.outputDir, `${slug}.md`);

    if (options.resume && await fs.pathExists(docFile)) {
      const parsed = parseExistingDoc(await fs.readFile(docFile, 'utf8'));
      results.push({
        name: target.name,
        slug,
        path: target.path,
        status: 'documented',
        docFile,
        systemType: parsed.systemType,
        stack: parsed.stack,
        nodeCount: parsed.nodeCount,
        embeddingCoverage: parsed.embeddingCoverage,
        durationMs: 0,
      });
      console.log(`${progress} skipped ${target.name} (already documented)`);
      continue;
    }

    const startedAt = Date.now();
    try {
      const cas = await analyzeProject(target.path);
      const durationMs = Date.now() - startedAt;
      const markdown = buildRepoMarkdown(cas, durationMs);
      await fs.writeFile(docFile, markdown, 'utf8');
      results.push({
        name: target.name,
        slug,
        path: target.path,
        status: 'documented',
        docFile,
        systemType: cas.system.type,
        stack: stackLabel(cas),
        nodeCount: cas.nodes.length,
        embeddingCoverage: embeddingCoverageLabel(cas),
        durationMs,
      });
      console.log(`${progress} documented ${target.name} (${cas.nodes.length} nodes, ${(durationMs / 1000).toFixed(1)}s)`);
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        name: target.name,
        slug,
        path: target.path,
        status: 'failed',
        durationMs,
        error: message,
      });
      console.log(`${progress} FAILED ${target.name} - ${message}`);
    }
  }

  const indexFile = path.join(options.outputDir, 'INDEX.md');
  await fs.writeFile(indexFile, buildIndexMarkdown(results, discovery.dev_root), 'utf8');

  const documented = results.filter(result => result.status === 'documented').length;
  const failed = results.filter(result => result.status === 'failed').length;
  console.log(`Done: ${documented} documented, ${failed} failed. Index at ${indexFile}`);

  return results;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await generateDocumentation(options);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

export { generateDocumentation, buildRepoMarkdown, buildIndexMarkdown };
