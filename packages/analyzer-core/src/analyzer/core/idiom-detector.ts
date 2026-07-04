import { globSync } from 'glob';
import * as nodePath from 'path';
import type {
  CASAnalysisFact,
  CASBehavioralInvariant,
  CASCodebaseIdiom,
  CASDatabaseSchema,
  CASDecorator,
  CASEdge,
  CASEntryPoint,
  CASExitPoint,
  CASIdiomCategory,
  CASIdiomExample,
  CASIdiomEvidence,
  CASIdiomSummary,
  CASIdiomViolation,
  CASLibrary,
  CASNode,
  CASPattern,
  CASTestSuite,
  CASConfiguration,
} from '../../types/cas.types';

export interface IdiomDetectionInput {
  projectPath: string;
  nodes: CASNode[];
  edges: CASEdge[];
  entryPoints: CASEntryPoint[];
  exitPoints: CASExitPoint[];
  databaseSchema?: CASDatabaseSchema;
  testSuites: CASTestSuite[];
  behavioralInvariants: CASBehavioralInvariant[];
  decorators: CASDecorator[];
  patterns: CASPattern[];
  libraries: CASLibrary[];
  configuration?: CASConfiguration;
  analysisFacts: CASAnalysisFact[];
}

export interface IdiomDetectionResult {
  idioms: CASCodebaseIdiom[];
  examples: CASIdiomExample[];
  violations: CASIdiomViolation[];
  summary: CASIdiomSummary;
}

interface FileInventory {
  all: string[];
  source: string[];
  tests: string[];
  migrations: string[];
  config: string[];
  schema: string[];
}

interface IdiomDraft {
  category: CASIdiomCategory;
  name: string;
  description: string;
  confidence: number;
  prevalence: number;
  evidence: CASIdiomEvidence[];
  positive_examples: CASIdiomExample[];
  affected_scopes?: CASCodebaseIdiom['affected_scopes'];
  agent_guidance: CASCodebaseIdiom['agent_guidance'];
  deviations?: CASIdiomViolation[];
  stats?: {
    population: number;
    matching: number;
    derivation: string;
  };
}

const EMPTY_CATEGORY_COUNTS: Record<CASIdiomCategory, number> = {
  naming: 0,
  'file-organization': 0,
  'module-boundary': 0,
  'dependency-injection': 0,
  'data-access': 0,
  'error-handling': 0,
  validation: 0,
  'auth-tenant-scope': 0,
  logging: 0,
  testing: 0,
  migrations: 0,
  'async-style': 0,
  configuration: 0,
};

const SOURCE_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|cs|java|php|dart|tf|tfvars)$/i;
const TEST_PATH = /(^|\/)(__tests__|tests?|spec|e2e|cypress)(\/|$)|(\.|_|-)(test|spec|cy)\.[a-z0-9]+$/i;
const MIGRATION_PATH = /(^|\/)(migrations?|db\/migrate|prisma\/migrations)(\/|$)|migration/i;
const SCHEMA_PATH = /(^|\/)(schema|models?|entities?|database|prisma)(\/|$)|(\.prisma|schema\.sql)$/i;
const CONFIG_PATH = /(^|\/)(\.env|config|configs|settings)(\/|$)|(^|\/)(package\.json|tsconfig\.json|pyproject\.toml|Cargo\.toml|go\.mod|composer\.json|pubspec\.yaml|appsettings\.json)$/i;

export function detectCodebaseIdioms(input: IdiomDetectionInput): IdiomDetectionResult {
  const files = buildFileInventory(input);
  const detectedDrafts = [
    ...detectNamingIdioms(input),
    ...detectFileOrganizationIdioms(input, files),
    ...detectModuleBoundaryIdioms(input),
    ...detectDependencyInjectionIdioms(input),
    ...detectDataAccessIdioms(input, files),
    ...detectErrorHandlingIdioms(input),
    ...detectValidationIdioms(input),
    ...detectAuthTenantIdioms(input),
    ...detectLoggingIdioms(input),
    ...detectTestingIdioms(input, files),
    ...detectMigrationIdioms(input, files),
    ...detectAsyncStyleIdioms(input),
    ...detectConfigurationIdioms(input, files),
  ];
  const drafts = [
    ...detectedDrafts,
    ...detectFallbackIdioms(input, files, detectedDrafts),
  ];

  const idioms = drafts
    .filter(draft => draft.evidence.length > 0 && draft.confidence >= 0.45)
    .map((draft, index) => toIdiom(normalizeDraftPaths(input.projectPath, draft), index));
  const examples = idioms.flatMap(idiom => idiom.positive_examples);
  const violations = idioms.flatMap(idiom => idiom.deviations || []);
  return {
    idioms,
    examples,
    violations,
    summary: summarizeIdioms(idioms, violations),
  };
}

function detectFallbackIdioms(
  input: IdiomDetectionInput,
  files: FileInventory,
  existingDrafts: IdiomDraft[]
): IdiomDraft[] {
  const existingCategories = new Set(existingDrafts.map(draft => draft.category));
  const drafts: IdiomDraft[] = [];

  if (!existingCategories.has('file-organization') && files.source.length > 0) {
    const rootCounts = countBy(files.source.map(file => file.includes('/') ? file.split('/')[0] : '<repo-root>'));
    const [dominantRoot, dominantCount] = [...rootCounts.entries()]
      .sort((left, right) => right[1] - left[1])[0] || ['<repo-root>', files.source.length];
    const rootFiles = files.source.filter(file => (file.includes('/') ? file.split('/')[0] : '<repo-root>') === dominantRoot);
    const idiomId = 'file-organization-dominant-source-location';
    const rootLabel = dominantRoot === '<repo-root>' ? 'the repository root' : `${dominantRoot}/`;
    drafts.push({
      category: 'file-organization',
      name: `Source edits stay near ${rootLabel}`,
      description: `The strongest observable placement convention is to keep source files near ${rootLabel}.`,
      confidence: confidenceFromPrevalence(dominantCount / files.source.length, files.source.length),
      prevalence: dominantCount / files.source.length,
      evidence: rootFiles.slice(0, 8).map(fileEvidence(`Source file follows dominant ${rootLabel} placement`)),
      positive_examples: rootFiles.slice(0, 5).map((file, index) => fileExample(idiomId, file, index, `Shows the local source placement convention near ${rootLabel}.`)),
      affected_scopes: {
        file_globs: [dominantRoot === '<repo-root>' ? '*.{ts,tsx,js,jsx,py,go,rs,cs,java,php,dart}' : `${dominantRoot}/**/*`],
        files: rootFiles.slice(0, 25),
      },
      agent_guidance: {
        do: [`Make new production edits next to the existing peer files in ${rootLabel}.`, 'Prefer modifying a local peer over creating a new top-level area.'],
        avoid: ['Do not introduce a parallel source layout unless the task explicitly creates a new package boundary.'],
        validation: ['Check that new or moved source files follow the dominant repository layout.'],
      },
    });
  }

  if (!existingCategories.has('configuration') && files.config.length > 0) {
    const idiomId = 'configuration-observed-config-surface';
    drafts.push({
      category: 'configuration',
      name: 'Configuration changes use the observed config surface',
      description: 'The repository has explicit configuration or manifest files that should be updated instead of hard-coding runtime settings.',
      confidence: confidenceFromPrevalence(Math.min(1, files.config.length / Math.max(1, files.all.length)), files.config.length),
      prevalence: Math.min(1, files.config.length / Math.max(1, files.all.length)),
      evidence: files.config.slice(0, 8).map(fileEvidence('Configuration or manifest file found')),
      positive_examples: files.config.slice(0, 5).map((file, index) => fileExample(idiomId, file, index, 'Shows where this repo keeps configuration and package metadata.')),
      affected_scopes: { files: files.config.slice(0, 25), file_globs: files.config.slice(0, 8) },
      agent_guidance: {
        do: ['Use the existing config or manifest surface for runtime settings, package metadata, and tool settings.'],
        avoid: ['Do not bury new runtime configuration inside feature code when a config surface exists.'],
        validation: ['Review config edits for defaults, environment names, and local naming style.'],
      },
    });
  }

  if (!existingCategories.has('naming') && input.nodes.length > 0) {
    const symbolNodes = input.nodes.filter(node =>
      Boolean(node.name) &&
      !['file', 'import', 'dependency'].includes(node.type) &&
      !/^[/.]/.test(node.name)
    );
    const namingStyle = dominantNamingStyle(symbolNodes.map(node => node.name));
    if (namingStyle) {
      const examples = symbolNodes.filter(node => nameMatchesStyle(node.name, namingStyle.style)).slice(0, 5);
      const idiomId = `naming-dominant-${namingStyle.style}`;
      drafts.push({
        category: 'naming',
        name: `Symbols generally use ${namingStyle.label}`,
        description: `The visible symbol graph mostly follows ${namingStyle.label} naming.`,
        confidence: confidenceFromPrevalence(namingStyle.prevalence, symbolNodes.length),
        prevalence: namingStyle.prevalence,
        evidence: examples.slice(0, 8).map(nodeEvidence(`Symbol uses ${namingStyle.label}`)),
        positive_examples: examples.map((node, index) => nodeExample(idiomId, node, index, `Follows the dominant ${namingStyle.label} naming style.`)),
        affected_scopes: {
          node_types: unique(symbolNodes.map(node => node.type)).slice(0, 20),
          files: unique(symbolNodes.map(node => node.source?.file).filter(Boolean) as string[]).slice(0, 25),
        },
        agent_guidance: {
          do: [`Name new local symbols using ${namingStyle.label} when adding peers in this area.`],
          avoid: ['Do not import a naming style from another language or framework area without local examples.'],
          validation: ['Check added symbols against nearby names before finalizing.'],
        },
      });
    }
  }

  return drafts;
}

function detectNamingIdioms(input: IdiomDetectionInput): IdiomDraft[] {
  const suffixRules: Array<{ suffix: string; category: string; nodeType?: RegExp; file?: RegExp; label: string }> = [
    { suffix: 'Controller', category: 'controller', nodeType: /controller/i, file: /\.controller\./i, label: 'controllers' },
    { suffix: 'Service', category: 'service', nodeType: /service/i, file: /\.service\./i, label: 'services' },
    { suffix: 'Repository', category: 'repository', nodeType: /repository/i, file: /\.repository\./i, label: 'repositories' },
    { suffix: 'Guard', category: 'guard', nodeType: /guard/i, file: /\.guard\./i, label: 'guards' },
    { suffix: 'Module', category: 'module', nodeType: /module/i, file: /\.module\./i, label: 'modules' },
    { suffix: 'Dto', category: 'dto', nodeType: /dto/i, file: /\.dto\./i, label: 'DTOs' },
    { suffix: 'Resolver', category: 'resolver', nodeType: /resolver/i, file: /\.resolver\./i, label: 'resolvers' },
  ];

  const drafts: IdiomDraft[] = [];
  for (const rule of suffixRules) {
    const candidates = input.nodes.filter(node =>
      rule.nodeType?.test(node.type) ||
      rule.nodeType?.test(node.name) ||
      Boolean(node.source?.file && rule.file?.test(node.source.file))
    );
    if (candidates.length < 2) continue;
    const matching = candidates.filter(node => node.name.endsWith(rule.suffix));
    const prevalence = matching.length / candidates.length;
    if (prevalence < 0.6) continue;
    const idiomId = `naming-${slug(rule.category)}-${rule.suffix.toLowerCase()}`;
    drafts.push({
      category: 'naming',
      name: `${rule.label} use ${rule.suffix} suffixes`,
      description: `Repo-local ${rule.label} are named with the ${rule.suffix} suffix.`,
      confidence: confidenceFromPrevalence(prevalence, candidates.length),
      prevalence,
      evidence: matching.slice(0, 8).map(nodeEvidence(`Names ending in ${rule.suffix}`)),
      positive_examples: matching.slice(0, 5).map((node, index) => nodeExample(idiomId, node, index, `Follows the ${rule.suffix} suffix convention.`)),
      affected_scopes: {
        node_types: unique(candidates.map(node => node.type)),
        files: unique(candidates.map(node => node.source?.file).filter(Boolean) as string[]).slice(0, 25),
      },
      agent_guidance: {
        do: [`Name new ${rule.label} with the ${rule.suffix} suffix.`, `Place the suffix on the exported class or primary symbol.`],
        avoid: [`Do not introduce alternate names for ${rule.label} when the repo already uses ${rule.suffix}.`],
        validation: [`Check changed ${rule.label} for the ${rule.suffix} suffix before finalizing.`],
      },
      deviations: candidates
        .filter(node => !node.name.endsWith(rule.suffix))
        .slice(0, 10)
        .map((node, index) => violation(idiomId, 'naming', 'warning', node, `${node.name} does not use the ${rule.suffix} suffix.`, `Rename or justify the exception so it matches surrounding ${rule.label}.`, index)),
    });
  }

  const componentNodes = input.nodes.filter(node =>
    /\.(tsx|jsx)$/i.test(node.source?.file || '') &&
    /component|function|class/i.test(node.type) &&
    /^[A-Z][A-Za-z0-9]*$/.test(node.name)
  );
  const componentCandidates = input.nodes.filter(node =>
    /\.(tsx|jsx)$/i.test(node.source?.file || '') && /component|function|class/i.test(node.type)
  );
  if (componentCandidates.length >= 3 && componentNodes.length / componentCandidates.length >= 0.65) {
    const idiomId = 'naming-react-pascal-case-components';
    drafts.push({
      category: 'naming',
      name: 'React components use PascalCase',
      description: 'Component-like TSX/JSX symbols use PascalCase names.',
      confidence: confidenceFromPrevalence(componentNodes.length / componentCandidates.length, componentCandidates.length),
      prevalence: componentNodes.length / componentCandidates.length,
      evidence: componentNodes.slice(0, 8).map(nodeEvidence('Component symbol is PascalCase')),
      positive_examples: componentNodes.slice(0, 5).map((node, index) => nodeExample(idiomId, node, index, 'Follows PascalCase component naming.')),
      affected_scopes: { languages: ['TypeScript', 'JavaScript'], node_types: ['component', 'function', 'class'], file_globs: ['**/*.{tsx,jsx}'] },
      agent_guidance: {
        do: ['Use PascalCase for new React components and exported component symbols.'],
        avoid: ['Do not add lowercase component exports unless the local file pattern already requires it.'],
        validation: ['Inspect changed TSX/JSX exports for PascalCase component names.'],
      },
    });
  }

  const functionNodes = input.nodes.filter(node => /function|method/i.test(node.type));
  const snakeCaseNodes = functionNodes.filter(node =>
    /python|rust/i.test(node.metadata?.language || '') &&
    /^[a-z][a-z0-9_]*$/.test(node.name)
  );
  const snakeCaseCandidates = functionNodes.filter(node => /python|rust/i.test(node.metadata?.language || ''));
  if (snakeCaseCandidates.length >= 5 && snakeCaseNodes.length / snakeCaseCandidates.length >= 0.7) {
    const idiomId = 'naming-python-rust-snake-case-functions';
    drafts.push({
      category: 'naming',
      name: 'Python and Rust functions use snake_case',
      description: 'Function-like symbols in Python/Rust areas prefer snake_case.',
      confidence: confidenceFromPrevalence(snakeCaseNodes.length / snakeCaseCandidates.length, snakeCaseCandidates.length),
      prevalence: snakeCaseNodes.length / snakeCaseCandidates.length,
      evidence: snakeCaseNodes.slice(0, 8).map(nodeEvidence('Function symbol is snake_case')),
      positive_examples: snakeCaseNodes.slice(0, 5).map((node, index) => nodeExample(idiomId, node, index, 'Follows snake_case function naming.')),
      affected_scopes: { languages: ['Python', 'Rust'], node_types: unique(snakeCaseCandidates.map(node => node.type)) },
      agent_guidance: {
        do: ['Use snake_case for Python and Rust functions when adding behavior in those areas.'],
        avoid: ['Do not copy TypeScript camelCase naming into Python/Rust code.'],
        validation: ['Check new Python/Rust functions for snake_case names.'],
      },
    });
  }

  return drafts;
}

function detectFileOrganizationIdioms(input: IdiomDetectionInput, files: FileInventory): IdiomDraft[] {
  const drafts: IdiomDraft[] = [];
  if (files.source.length >= 4) {
    const srcFiles = files.source.filter(file => file.startsWith('src/'));
    const prevalence = srcFiles.length / files.source.length;
    if (prevalence >= 0.6) {
      const idiomId = 'file-organization-source-under-src';
      drafts.push({
        category: 'file-organization',
        name: 'Application source lives under src/',
        description: 'Most analyzable source files are rooted under src/.',
        confidence: confidenceFromPrevalence(prevalence, files.source.length),
        prevalence,
        evidence: srcFiles.slice(0, 8).map(fileEvidence('Source file is under src/')),
        positive_examples: srcFiles.slice(0, 5).map((file, index) => fileExample(idiomId, file, index, 'Source placement follows the repo root convention.')),
        affected_scopes: { file_globs: ['src/**/*'], files: srcFiles.slice(0, 25) },
        agent_guidance: {
          do: ['Place new application source under src/ unless a nearby existing package has its own root.'],
          avoid: ['Do not create new top-level source folders when src/ is the dominant convention.'],
          validation: ['Check new source files are under src/ or next to an existing peer module.'],
        },
        deviations: files.source
          .filter(file => !file.startsWith('src/') && !isConfigPath(file))
          .slice(0, 10)
          .map((file, index) => fileViolation(idiomId, 'file-organization', 'info', file, `${file} is outside src/ while src/ is the dominant source root.`, 'Prefer src/ for new source unless this file belongs to a documented subproject.', index)),
      });
    }
  }

  const byFeatureDirs = input.nodes
    .filter(node => node.source?.file && /controller|service|module|repository|dto|guard/i.test(node.name + node.type))
    .map(node => node.source!.file!)
    .filter(file => /\/[^/]+\/[^/]+\.(controller|service|module|repository|dto|guard)\./i.test(file));
  if (byFeatureDirs.length >= 4) {
    const idiomId = 'file-organization-feature-modules';
    drafts.push({
      category: 'file-organization',
      name: 'Framework files are grouped by feature/module',
      description: 'Controllers, services, modules, repositories, DTOs, and guards appear together under feature directories.',
      confidence: confidenceFromPrevalence(0.82, byFeatureDirs.length),
      prevalence: Math.min(1, byFeatureDirs.length / Math.max(1, input.nodes.filter(node => node.source?.file).length)),
      evidence: byFeatureDirs.slice(0, 8).map(fileEvidence('Framework file is located in a feature directory')),
      positive_examples: byFeatureDirs.slice(0, 5).map((file, index) => fileExample(idiomId, file, index, 'Placed next to sibling framework files for the same feature.')),
      affected_scopes: { file_globs: ['**/*.{controller,service,module,repository,dto,guard}.*'] },
      agent_guidance: {
        do: ['Add new framework files beside the related feature files.'],
        avoid: ['Do not scatter feature behavior into unrelated shared folders just because the filename is generic.'],
        validation: ['Compare new file location against nearby controller/service/module peers.'],
      },
    });
  }

  return drafts;
}

function detectModuleBoundaryIdioms(input: IdiomDetectionInput): IdiomDraft[] {
  const moduleNodes = input.nodes.filter(node => /module/i.test(node.type) || /Module$/.test(node.name));
  const containsEdges = input.edges.filter(edge => /contain|export|import|provide|depends/i.test(edge.type));
  if (moduleNodes.length === 0 || containsEdges.length < 2) return [];
  const connectedModuleIds = new Set([...containsEdges.map(edge => edge.source), ...containsEdges.map(edge => edge.target)]);
  const connectedModules = moduleNodes.filter(node => connectedModuleIds.has(node.id));
  if (connectedModules.length === 0) return [];
  const idiomId = 'module-boundary-explicit-modules';
  return [{
    category: 'module-boundary',
    name: 'Module boundaries are explicit graph objects',
    description: `${connectedModules.length} of ${moduleNodes.length} module nodes participate in ${containsEdges.length} containment/dependency edge(s); edits should preserve these boundaries.`,
    confidence: confidenceFromPrevalence(connectedModules.length / moduleNodes.length, connectedModules.length),
    prevalence: Math.min(1, moduleNodes.length / Math.max(1, input.nodes.length)),
    stats: {
      population: moduleNodes.length,
      matching: connectedModules.length,
      derivation: `${connectedModules.length} of ${moduleNodes.length} module nodes appear in ${containsEdges.length} boundary edges.`,
    },
    evidence: [
      ...moduleNodes.slice(0, 5).map(nodeEvidence('Module node defines a local boundary')),
      ...containsEdges.slice(0, 3).map(edge => edgeEvidence(edge, 'Boundary relationship found')),
    ],
    positive_examples: moduleNodes.slice(0, 5).map((node, index) => nodeExample(idiomId, node, index, 'Module participates in the local boundary graph.')),
    affected_scopes: { node_ids: moduleNodes.map(node => node.id).slice(0, 25), node_types: unique(moduleNodes.map(node => node.type)) },
    agent_guidance: {
      do: ['Add dependencies through the existing module/package boundary mechanism.'],
      avoid: ['Do not bypass local module exports/imports with deep cross-boundary imports.'],
      validation: ['Before finalizing, verify changed imports still respect module/package ownership.'],
    },
  }];
}

function detectDependencyInjectionIdioms(input: IdiomDetectionInput): IdiomDraft[] {
  if (isInfrastructureOnlyInput(input)) return [];
  const decoratorNames = input.decorators.map(decorator => decorator.decorator_info.name.toLowerCase());
  const injectableNodes = input.nodes.filter(node =>
    /injectable|controller|module|service|provider/i.test([node.name, node.type, node.source?.raw || '', node.metadata?.annotations?.join(' ') || ''].join(' '))
  );
  const constructorInjectionNodes = input.nodes.filter(node =>
    /constructor\s*\([^)]*(private|protected|readonly|inject|@Inject)/i.test(node.source?.raw || '') ||
    /dependency-injection|provider/i.test(node.category || '')
  );
  const diDecorators = decoratorNames.filter(name => /injectable|inject|controller|module|component|service|autowired|provide/.test(name));
  if (injectableNodes.length + constructorInjectionNodes.length < 5 && diDecorators.length < 3) {
    return [];
  }
  const allDiNodes = uniqueNodes([...injectableNodes, ...constructorInjectionNodes]);
  const examples = uniqueNodes([...constructorInjectionNodes, ...injectableNodes]).slice(0, 5);
  const mechanism = diDecorators.length >= constructorInjectionNodes.length
    ? `decorator-marked providers (${topCounted(diDecorators, 3).join(', ')})`
    : 'constructor injection';
  const idiomId = 'dependency-injection-framework-providers';
  return [{
    category: 'dependency-injection',
    name: `Dependencies are wired through ${mechanism}`,
    description: `${allDiNodes.length} provider-style node(s) and ${diDecorators.length} DI decorator(s) show collaborators are injected via ${mechanism}, not ad hoc instantiation.`,
    confidence: confidenceFromPrevalence(Math.min(1, (allDiNodes.length + diDecorators.length) / 20), allDiNodes.length + diDecorators.length),
    prevalence: Math.min(1, allDiNodes.length / Math.max(1, input.nodes.length)),
    stats: {
      population: input.nodes.length,
      matching: allDiNodes.length,
      derivation: `${allDiNodes.length} provider-style nodes plus ${diDecorators.length} DI decorators; dominant mechanism: ${mechanism}.`,
    },
    evidence: [
      ...examples.map(nodeEvidence('Node participates in dependency injection')),
      ...input.decorators.slice(0, 4).map(decorator => ({
        kind: 'decorator' as const,
        file: decorator.decorator_info.source_location.file,
        line: decorator.decorator_info.source_location.line,
        node_id: decorator.target_node,
        claim: `Decorator ${decorator.decorator_info.name} participates in DI or provider wiring.`,
        confidence: 0.8,
      })),
    ],
    positive_examples: examples.map((node, index) => nodeExample(idiomId, node, index, 'Uses local provider/decorator injection style.')),
    affected_scopes: { node_ids: examples.map(node => node.id), file_globs: ['**/*.{service,controller,module,provider}.*'] },
    agent_guidance: {
      do: ['Inject collaborators through the existing framework/provider mechanism.'],
      avoid: ['Do not new-up services or repositories inside handlers when the repo uses DI.'],
      validation: ['Search changed constructors/providers for preserved injection wiring.'],
    },
  }];
}

function detectDataAccessIdioms(input: IdiomDetectionInput, files: FileInventory): IdiomDraft[] {
  if (isInfrastructureOnlyInput(input)) return [];
  const dataNodes = input.nodes.filter(node =>
    /repository|model|entity|schema|prisma|orm|database|dao/i.test([node.name, node.type, node.source?.file || ''].join(' ')) &&
    Boolean(node.source?.file && !isConfigPath(node.source.file) && !isMigrationPath(node.source.file) && !isTestPath(node.source.file))
  );
  const dataLibraries = input.libraries.filter(library => /prisma|typeorm|mikro|sequelize|mongoose|sqlalchemy|diesel|sqlx|entity framework|ef core/i.test(library.name));
  const exitPoints = input.exitPoints.filter(exitPoint => exitPoint.type === 'database');
  if (dataNodes.length < 3 && dataLibraries.length === 0 && exitPoints.length < 3) return [];
  const schemaFiles = files.schema.filter(file => !isConfigPath(file) && !isMigrationPath(file) && !isTestPath(file));
  const ormLabel = dataLibraries.length > 0
    ? dataLibraries.map(library => library.name).slice(0, 2).join('/')
    : 'repository/entity classes';
  const idiomId = 'data-access-through-repositories-or-orm';
  return [{
    category: 'data-access',
    name: `Data access goes through ${ormLabel}`,
    description: `${dataNodes.length} data-access node(s), ${exitPoints.length} database exit point(s), and ${dataLibraries.length} ORM library(ies) show persistence is mediated by ${ormLabel}.`,
    confidence: confidenceFromPrevalence(Math.min(1, (dataNodes.length + exitPoints.length) / 20), dataNodes.length + dataLibraries.length + exitPoints.length),
    prevalence: Math.min(1, (dataNodes.length + exitPoints.length) / Math.max(1, input.nodes.length + input.exitPoints.length)),
    stats: {
      population: input.nodes.length + input.exitPoints.length,
      matching: dataNodes.length + exitPoints.length,
      derivation: `${dataNodes.length} data-access nodes, ${exitPoints.length} database exits, libraries: ${dataLibraries.map(library => library.name).join(', ') || 'none detected'}.`,
    },
    evidence: [
      ...dataNodes.slice(0, 6).map(nodeEvidence('Data access node identified')),
      ...dataLibraries.slice(0, 3).map(library => ({ kind: 'analysis-fact' as const, claim: `Data library detected: ${library.name}.`, confidence: 0.78 })),
      ...schemaFiles.slice(0, 3).map(fileEvidence('Schema/model file participates in data access')),
    ],
    positive_examples: dataNodes.slice(0, 5).map((node, index) => nodeExample(idiomId, node, index, 'Uses the local data access boundary.')),
    affected_scopes: { files: unique([...dataNodes.map(node => node.source?.file).filter(Boolean) as string[], ...schemaFiles]).slice(0, 25), file_globs: ['**/*{repository,model,entity,schema,prisma}*'] },
    agent_guidance: {
      do: ['Route persistence changes through existing repository/ORM/entity patterns.'],
      avoid: ['Do not add direct database calls from unrelated controller/component layers when a repository/ORM boundary exists.'],
      validation: ['Check data edits for matching schema/entity/repository updates and focused tests.'],
    },
  }];
}

function detectErrorHandlingIdioms(input: IdiomDetectionInput): IdiomDraft[] {
  const exceptionNodes = input.nodes.filter(node =>
    /throw\s+new\s+\w*Exception|raise\s+HTTPException|Result<|anyhow::Result|thiserror|BadRequestException|NotFoundException|ForbiddenException/i.test(node.source?.raw || '')
  );
  if (exceptionNodes.length < 3) return [];
  const styleCounts = new Map<string, number>();
  for (const node of exceptionNodes) {
    const raw = node.source?.raw || '';
    const style = /Result<|anyhow::Result|thiserror/.test(raw) ? 'typed Result errors'
      : /raise\s+HTTPException/.test(raw) ? 'HTTPException raises'
      : /BadRequestException|NotFoundException|ForbiddenException/.test(raw) ? 'framework HTTP exceptions'
      : 'domain exception throws';
    styleCounts.set(style, (styleCounts.get(style) || 0) + 1);
  }
  const dominantStyle = [...styleCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const idiomId = 'error-handling-framework-specific-errors';
  return [{
    category: 'error-handling',
    name: `Errors use ${dominantStyle}`,
    description: `${exceptionNodes.length} node(s) raise typed errors; the dominant style is ${dominantStyle} (${styleCounts.get(dominantStyle)} of ${exceptionNodes.length}).`,
    confidence: confidenceFromPrevalence(Math.min(1, exceptionNodes.length / 20), exceptionNodes.length),
    prevalence: Math.min(1, exceptionNodes.length / Math.max(1, input.nodes.length)),
    stats: {
      population: input.nodes.length,
      matching: exceptionNodes.length,
      derivation: `${exceptionNodes.length} typed-error nodes; dominant style ${dominantStyle}.`,
    },
    evidence: exceptionNodes.slice(0, 8).map(nodeEvidence('Framework/domain error pattern found')),
    positive_examples: exceptionNodes.slice(0, 5).map((node, index) => nodeExample(idiomId, node, index, 'Uses the repo-local error-handling style.')),
    affected_scopes: { files: unique(exceptionNodes.map(node => node.source?.file).filter(Boolean) as string[]).slice(0, 25) },
    agent_guidance: {
      do: ['Use the nearby framework/domain error type for new failure paths.'],
      avoid: ['Do not introduce bare throw new Error or string errors when local code uses typed/framework errors.'],
      validation: ['Inspect new error paths for the same exception/result style as nearby code.'],
    },
  }];
}

function detectValidationIdioms(input: IdiomDetectionInput): IdiomDraft[] {
  const validationNodes = input.nodes.filter(node =>
    /class-validator|zod|joi|pydantic|validate|validator|dto|schema/i.test([node.name, node.type, node.source?.file || '', node.source?.raw || ''].join(' ')) &&
    Boolean(node.source?.file && !isConfigPath(node.source.file) && !isMigrationPath(node.source.file) && !isTestPath(node.source.file))
  );
  if (validationNodes.length < 5) return [];
  const mechanismCounts = new Map<string, number>();
  for (const node of validationNodes) {
    const haystack = [node.name, node.source?.file || '', node.source?.raw || ''].join(' ');
    for (const [label, pattern] of [
      ['class-validator', /class-validator/i],
      ['zod', /\bzod\b/i],
      ['joi', /\bjoi\b/i],
      ['pydantic', /pydantic/i],
      ['DTO classes', /dto/i],
      ['schema objects', /schema/i],
      ['validator classes', /validat/i],
    ] as const) {
      if (pattern.test(haystack)) {
        mechanismCounts.set(label, (mechanismCounts.get(label) || 0) + 1);
        break;
      }
    }
  }
  const dominantMechanism = [...mechanismCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'validator objects';
  const idiomId = 'validation-dtos-schemas-or-validators';
  return [{
    category: 'validation',
    name: `Inputs are validated through ${dominantMechanism}`,
    description: `${validationNodes.length} validation node(s) found; the dominant mechanism is ${dominantMechanism} (${mechanismCounts.get(dominantMechanism) || validationNodes.length} of ${validationNodes.length}).`,
    confidence: confidenceFromPrevalence(Math.min(1, validationNodes.length / 20), validationNodes.length),
    prevalence: Math.min(1, validationNodes.length / Math.max(1, input.nodes.length)),
    stats: {
      population: input.nodes.length,
      matching: validationNodes.length,
      derivation: `${validationNodes.length} validation nodes; dominant mechanism ${dominantMechanism}.`,
    },
    evidence: validationNodes.slice(0, 8).map(nodeEvidence('Validation convention evidence')),
    positive_examples: validationNodes.slice(0, 5).map((node, index) => nodeExample(idiomId, node, index, 'Uses local validation structure.')),
    affected_scopes: { files: unique(validationNodes.map(node => node.source?.file).filter(Boolean) as string[]).slice(0, 25), file_globs: ['**/*{dto,schema,validator}*'] },
    agent_guidance: {
      do: ['Add or update the local DTO/schema/validator when request or config shape changes.'],
      avoid: ['Do not validate ad hoc inside unrelated business logic if the repo has a validation layer.'],
      validation: ['Check changed inputs for corresponding validator/DTO/schema updates.'],
    },
  }];
}

function detectAuthTenantIdioms(input: IdiomDetectionInput): IdiomDraft[] {
  if (isInfrastructureOnlyInput(input)) return [];
  const invariants = input.behavioralInvariants.filter(invariant =>
    ['tenant-scope', 'auth-boundary', 'authorization'].includes(invariant.invariant_type)
  );
  const authNodes = input.nodes.filter(node =>
    /auth|tenant|organization|org|guard|permission|role|scope/i.test([node.name, node.type, node.source?.file || '', node.source?.raw || ''].join(' '))
  );
  if (invariants.length === 0 && authNodes.length < 5) return [];
  const invariantTypes = unique(invariants.map(invariant => invariant.invariant_type));
  const scopeLabel = invariantTypes.length > 0 ? invariantTypes.join('/') : 'auth';
  const idiomId = 'auth-tenant-scope-preserved-through-boundaries';
  return [{
    category: 'auth-tenant-scope',
    name: `${scopeLabel} scope is enforced at boundaries`,
    description: `${invariants.length} ${scopeLabel} invariant(s) and ${authNodes.length} auth/tenant node(s) show access scope is a boundary-level concern in this repo.`,
    confidence: confidenceFromPrevalence(Math.min(1, (invariants.length * 4 + authNodes.length) / 20), invariants.length + authNodes.length),
    prevalence: Math.min(1, (invariants.length + authNodes.length) / Math.max(1, input.nodes.length + input.behavioralInvariants.length)),
    stats: {
      population: input.nodes.length + input.behavioralInvariants.length,
      matching: invariants.length + authNodes.length,
      derivation: `${invariants.length} invariant(s) of type ${scopeLabel}; ${authNodes.length} auth/tenant-related nodes.`,
    },
    evidence: [
      ...invariants.slice(0, 5).map(invariant => ({
        kind: 'invariant' as const,
        claim: `${invariant.invariant_type}: ${invariant.name}`,
        confidence: invariant.confidence === 'high' ? 0.9 : invariant.confidence === 'medium' ? 0.72 : 0.55,
      })),
      ...authNodes.slice(0, 5).map(nodeEvidence('Auth/tenant-scoped node found')),
    ],
    positive_examples: authNodes.slice(0, 5).map((node, index) => nodeExample(idiomId, node, index, 'Participates in auth or tenant boundary enforcement.')),
    affected_scopes: {
      files: unique([...authNodes.map(node => node.source?.file).filter(Boolean) as string[], ...invariants.flatMap(invariant => invariant.scope.file_paths || [])]).slice(0, 25),
      node_ids: unique([...authNodes.map(node => node.id), ...invariants.flatMap(invariant => invariant.scope.node_ids || [])]).slice(0, 25),
    },
    agent_guidance: {
      do: ['Preserve auth, authorization, and tenant/org filters in reads, writes, uniqueness checks, and route handlers.'],
      avoid: ['Do not add bypass paths around guards, scoped repositories, or tenant filters.'],
      validation: ['Run validate_behavioral_invariants and validate_codebase_idioms after edits touching scoped behavior.'],
    },
  }];
}

function detectLoggingIdioms(input: IdiomDetectionInput): IdiomDraft[] {
  const loggingNodes = input.nodes.filter(node =>
    /logger|logging|log\.|this\.logger|Logger\(/i.test([node.name, node.type, node.source?.raw || ''].join(' '))
  );
  if (loggingNodes.length < 5) return [];
  const idiomId = 'logging-local-logger-abstraction';
  return [{
    category: 'logging',
    name: 'Logging goes through the local logger abstraction',
    description: `${loggingNodes.length} node(s) use logger fields/classes/helpers instead of scattered console prints.`,
    confidence: confidenceFromPrevalence(Math.min(1, loggingNodes.length / 20), loggingNodes.length),
    prevalence: Math.min(1, loggingNodes.length / Math.max(1, input.nodes.length)),
    stats: {
      population: input.nodes.length,
      matching: loggingNodes.length,
      derivation: `${loggingNodes.length} logger-usage nodes detected.`,
    },
    evidence: loggingNodes.slice(0, 8).map(nodeEvidence('Logger usage found')),
    positive_examples: loggingNodes.slice(0, 5).map((node, index) => nodeExample(idiomId, node, index, 'Uses local logger convention.')),
    affected_scopes: { files: unique(loggingNodes.map(node => node.source?.file).filter(Boolean) as string[]).slice(0, 25) },
    agent_guidance: {
      do: ['Use the existing logger abstraction for new diagnostic output.'],
      avoid: ['Do not add console.log/print debugging as committed behavior when logger usage exists nearby.'],
      validation: ['Inspect changed files for console/print statements that should use the logger.'],
    },
  }];
}

function detectTestingIdioms(input: IdiomDetectionInput, files: FileInventory): IdiomDraft[] {
  const testFiles = unique([
    ...files.tests,
    ...input.testSuites.map(suite => suite.file_path).filter(Boolean) as string[],
  ]);
  if (testFiles.length < 2) return [];
  const specFiles = testFiles.filter(file => /\.(spec|test)\./i.test(file));
  const pythonTests = testFiles.filter(file => /(^|\/)test_[^/]+\.py$|_test\.py$/i.test(file));
  const colocated = testFiles.filter(file => /src\/.*\.(spec|test)\./i.test(file));
  const dominantLabel = specFiles.length >= pythonTests.length ? 'spec/test files' : 'test_*.py files';
  const prevalence = Math.max(specFiles.length, pythonTests.length, colocated.length) / testFiles.length;
  const idiomId = 'testing-local-focused-test-files';
  return [{
    category: 'testing',
    name: `Tests use ${dominantLabel}`,
    description: `${testFiles.length} test file(s) found; ${Math.max(specFiles.length, pythonTests.length, colocated.length)} follow the dominant ${dominantLabel} convention.`,
    confidence: confidenceFromPrevalence(Math.max(0.62, prevalence), testFiles.length),
    prevalence,
    stats: {
      population: testFiles.length,
      matching: Math.max(specFiles.length, pythonTests.length, colocated.length),
      derivation: `${testFiles.length} test files; dominant convention ${dominantLabel}.`,
    },
    evidence: testFiles.slice(0, 8).map(fileEvidence('Test file follows a local testing convention')),
    positive_examples: testFiles.slice(0, 5).map((file, index) => fileExample(idiomId, file, index, 'Represents local test placement/naming.')),
    affected_scopes: { file_globs: ['**/*.{spec,test}.*', '**/test_*.py', '**/*_test.py'], files: testFiles.slice(0, 25) },
    agent_guidance: {
      do: ['Update or add focused tests using the existing test file naming and placement style.'],
      avoid: ['Do not skip tests for behavior changes when matching test files are present.'],
      validation: ['Check changed behavior against nearby focused test files and run the narrowest available test command.'],
    },
  }];
}

function detectMigrationIdioms(input: IdiomDetectionInput, files: FileInventory): IdiomDraft[] {
  if (files.migrations.length === 0 && !input.behavioralInvariants.some(invariant => invariant.invariant_type === 'migration-contract')) {
    return [];
  }
  const migrationDirCounts = countBy(files.migrations.map(file => {
    const parts = normalizePath(file).split('/');
    const migrationIndex = parts.findIndex(part => /migrations?$|^migrate$/i.test(part));
    return migrationIndex >= 0 ? parts.slice(0, migrationIndex + 1).join('/') : parts.slice(0, -1).join('/');
  }).filter(Boolean));
  const dominantMigrationDir = [...migrationDirCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const migrationLocation = dominantMigrationDir ? `${dominantMigrationDir}/` : 'migration artifacts';
  const idiomId = 'migrations-schema-changes-use-migrations';
  return [{
    category: 'migrations',
    name: `Schema changes go through ${migrationLocation}`,
    description: `${files.migrations.length} migration file(s) under ${migrationLocation} show database/schema changes are paired with migration artifacts.`,
    confidence: files.migrations.length > 0 ? 0.86 : 0.72,
    prevalence: Math.min(1, files.migrations.length / Math.max(1, files.schema.length)),
    stats: {
      population: files.schema.length,
      matching: files.migrations.length,
      derivation: `${files.migrations.length} migration files; dominant location ${migrationLocation}.`,
    },
    evidence: [
      ...files.migrations.slice(0, 8).map(fileEvidence('Migration file found')),
      ...input.behavioralInvariants
        .filter(invariant => invariant.invariant_type === 'migration-contract')
        .slice(0, 3)
        .map(invariant => ({ kind: 'invariant' as const, claim: `Migration invariant: ${invariant.name}`, confidence: 0.82 })),
    ],
    positive_examples: files.migrations.slice(0, 5).map((file, index) => fileExample(idiomId, file, index, 'Uses the repo migration path.')),
    affected_scopes: { file_globs: ['**/migrations/**', '**/prisma/migrations/**'], files: files.migrations.slice(0, 25) },
    agent_guidance: {
      do: ['Add or update a migration when changing schema, entity, or persisted field shape.'],
      avoid: ['Do not edit schema/model files without migration coverage when migrations exist.'],
      validation: ['Run validate_codebase_idioms and validate_behavioral_invariants after schema changes.'],
    },
  }];
}

function detectAsyncStyleIdioms(input: IdiomDetectionInput): IdiomDraft[] {
  const asyncNodes = input.nodes.filter(node => node.metadata?.is_async || /\basync\b|Promise<|await\s+/i.test(node.source?.raw || ''));
  const asyncCandidates = input.nodes.filter(node => /function|method|handler|service/i.test(node.type));
  if (asyncCandidates.length < 5 || asyncNodes.length < 3) return [];
  const prevalence = asyncNodes.length / asyncCandidates.length;
  const idiomId = 'async-style-async-await-for-io';
  return [{
    category: 'async-style',
    name: 'Asynchronous I/O uses async/await or typed async results',
    description: 'I/O-heavy nodes use async metadata, Promise/await, or typed async result conventions.',
    confidence: confidenceFromPrevalence(Math.min(1, Math.max(0.55, prevalence)), asyncNodes.length),
    prevalence,
    evidence: asyncNodes.slice(0, 8).map(nodeEvidence('Async style evidence')),
    positive_examples: asyncNodes.slice(0, 5).map((node, index) => nodeExample(idiomId, node, index, 'Uses local async style.')),
    affected_scopes: { node_ids: asyncNodes.map(node => node.id).slice(0, 25) },
    agent_guidance: {
      do: ['Use the same async/await or typed async result style as the surrounding code.'],
      avoid: ['Do not mix callbacks or unawaited promises into async/await code paths.'],
      validation: ['Inspect changed I/O paths for awaited async work and preserved return types.'],
    },
  }];
}

function isInfrastructureOnlyInput(input: IdiomDetectionInput): boolean {
  const projectPath = normalizePath(input.projectPath);
  if (/(^|\/)(infra|infrastructure|terraform|opentofu|pulumi|helm|k8s|charts)(\/|$)/i.test(projectPath)) return true;
  const sourceFiles = unique(input.nodes.map(node => node.source?.file).filter(Boolean) as string[]);
  if (sourceFiles.length === 0) return false;
  const infraFiles = sourceFiles.filter(file => /\.(tf|tfvars|hcl|ya?ml)$/i.test(file) || /(^|\/)(terraform|opentofu|pulumi|helm|k8s|charts)(\/|$)/i.test(file));
  const appFiles = sourceFiles.filter(file => /\.(ts|tsx|js|jsx|py|go|rs|cs|java|php|dart|rb)$/i.test(file));
  const projectLooksLikeCiInfra = /(^|\/)[^/]*(?:ci|infra|infrastructure|terraform|opentofu|pulumi|helm|k8s|charts)[^/]*(?:\/|$)/i.test(projectPath);
  return (infraFiles.length >= Math.max(3, sourceFiles.length * 0.7) && appFiles.length === 0) ||
    (projectLooksLikeCiInfra && infraFiles.length >= Math.max(1, sourceFiles.length * 0.45));
}

function detectConfigurationIdioms(input: IdiomDetectionInput, files: FileInventory): IdiomDraft[] {
  const envVars = input.configuration?.environment_variables || [];
  if (envVars.length === 0 && files.config.length < 2) return [];
  const configSurface = files.config.slice(0, 3).map(file => normalizePath(file).split('/').pop()).filter(Boolean).join(', ');
  const idiomId = 'configuration-central-config-and-env';
  return [{
    category: 'configuration',
    name: 'Configuration is centralized in config files or environment declarations',
    description: `${files.config.length} config file(s) (${configSurface || 'none named'}) and ${envVars.length} declared environment variable(s) carry runtime settings.`,
    confidence: envVars.length > 0 ? 0.84 : 0.68,
    prevalence: Math.min(1, (envVars.length + files.config.length) / Math.max(1, files.all.length)),
    stats: {
      population: files.all.length,
      matching: files.config.length + envVars.length,
      derivation: `${files.config.length} config files (${configSurface || 'unnamed'}); ${envVars.length} environment variables.`,
    },
    evidence: [
      ...files.config.slice(0, 6).map(fileEvidence('Config file found')),
      ...envVars.slice(0, 4).map(env => ({ kind: 'analysis-fact' as const, claim: `Environment variable declared: ${env.name}.`, confidence: env.required ? 0.82 : 0.68 })),
    ],
    positive_examples: files.config.slice(0, 5).map((file, index) => fileExample(idiomId, file, index, 'Configuration belongs to the local config surface.')),
    affected_scopes: { file_globs: ['**/config/**', '**/.env*', '**/settings*'], files: files.config.slice(0, 25) },
    agent_guidance: {
      do: ['Add configuration through the existing config/env surface and document required values when the repo does so.'],
      avoid: ['Do not hard-code runtime settings in feature logic when config metadata exists.'],
      validation: ['Check config changes for environment documentation, defaults, and tests where applicable.'],
    },
  }];
}

function buildFileInventory(input: IdiomDetectionInput): FileInventory {
  const fromNodes = input.nodes.map(node => node.source?.file).filter(Boolean) as string[];
  const fromTests = input.testSuites.map(suite => suite.file_path).filter(Boolean) as string[];
  const fromEntryExit = [
    ...input.entryPoints.map(entry => entry.handler?.file).filter(Boolean) as string[],
    ...input.exitPoints.flatMap(exitPoint => exitPoint.metadata?.file ? [String(exitPoint.metadata.file)] : []),
  ];
  const fromFilesystem = safeGlob(input.projectPath);
  const all = unique([...fromNodes, ...fromTests, ...fromEntryExit, ...fromFilesystem]
    .map(file => normalizeProjectPath(input.projectPath, file))
    .map(normalizePath));
  return {
    all,
    source: all.filter(file => SOURCE_EXTENSIONS.test(file) && !isTestPath(file) && !isMigrationPath(file)),
    tests: all.filter(isTestPath),
    migrations: all.filter(isMigrationPath),
    config: all.filter(isConfigPath),
    schema: all.filter(file => SCHEMA_PATH.test(file) || /entity|model|schema|prisma/i.test(file)),
  };
}

function safeGlob(projectPath: string): string[] {
  try {
    return globSync('**/*', {
      cwd: projectPath,
      nodir: true,
      ignore: [
        'node_modules/**',
        '**/.git/**',
        '.git/**',
        '**/.claude/**',
        '.claude/**',
        '**/.codex/**',
        '.codex/**',
        '**/.scannerwork/**',
        '.scannerwork/**',
        '**/node_modules/**',
        'vendor/**',
        '**/vendor/**',
        'vendors/**',
        '**/vendors/**',
        'dist/**',
        '**/dist/**',
        'build/**',
        '**/build/**',
        'target/**',
        '**/target/**',
        'coverage/**',
        '**/coverage/**',
        '.next/**',
        '**/.next/**',
        '.turbo/**',
        '**/.turbo/**',
        '.cache/**',
        '**/.cache/**',
        '.sourcemaps/**',
        '**/.sourcemaps/**',
        'sourcemaps/**',
        '**/sourcemaps/**',
        '**/*.js.map',
        '**/*.css.map',
        '**/*.bundle.js',
        '**/*.bundle.css',
        '**/*.min.js',
        '**/*.min.css',
        '.venv/**',
        '**/.venv/**',
        '.venv*/**',
        '**/.venv*/**',
        'venv/**',
        '**/venv/**',
        'venv*/**',
        '**/venv*/**',
        'env/**',
        '**/env/**',
        'env*/**',
        '**/env*/**',
        'site-packages/**',
        '**/site-packages/**',
        '.tox/**',
        '**/.tox/**',
        '.pytest_cache/**',
        '**/.pytest_cache/**',
        '.mypy_cache/**',
        '**/.mypy_cache/**',
        '.ruff_cache/**',
        '**/.ruff_cache/**',
        '.dart_tool/**',
        '**/.dart_tool/**',
        '__pycache__/**',
        '**/__pycache__/**',
        '.klauro*/**',
        '**/.klauro*/**',
      ],
    }).slice(0, 2000);
  } catch {
    return [];
  }
}

function toIdiom(draft: IdiomDraft, index: number): CASCodebaseIdiom {
  const id = `${slug(draft.category)}-${slug(draft.name)}` || `idiom-${index + 1}`;
  const examples = draft.positive_examples.map(example => ({ ...example, idiom_id: id }));
  const deviations = draft.deviations?.map(item => ({ ...item, idiom_id: id })) || [];
  const evidence = draft.evidence.slice(0, 12).map(item => ({ ...item, confidence: roundRatio(item.confidence) }));
  const evidenceFiles = unique(draft.evidence.map(item => item.file || '').filter(Boolean)).length;
  const evidenceNodes = draft.evidence.filter(item => item.kind === 'node').length;
  const matching = draft.stats?.matching ?? draft.evidence.length;
  const population = draft.stats?.population ?? matching;
  return {
    id,
    category: draft.category,
    name: draft.name,
    description: draft.description,
    confidence: roundRatio(draft.confidence),
    prevalence: roundRatio(draft.prevalence),
    evidence,
    positive_examples: examples,
    affected_scopes: draft.affected_scopes || {},
    agent_guidance: draft.agent_guidance,
    deviations: deviations.length > 0 ? deviations : undefined,
    provenance: {
      evidence_files: evidenceFiles,
      evidence_nodes: evidenceNodes,
      population,
      matching,
      derivation: draft.stats?.derivation
        ?? `Derived from ${matching} matching item(s) across ${evidenceFiles} evidence file(s).`,
    },
  };
}

function summarizeIdioms(idioms: CASCodebaseIdiom[], violations: CASIdiomViolation[]): CASIdiomSummary {
  const byCategory = { ...EMPTY_CATEGORY_COUNTS };
  for (const idiom of idioms) byCategory[idiom.category]++;
  return {
    total: idioms.length,
    high_confidence: idioms.filter(idiom => idiom.confidence >= 0.8).length,
    violations: violations.length,
    by_category: byCategory,
    top_idioms: [...idioms]
      .sort((left, right) => right.confidence - left.confidence || right.prevalence - left.prevalence)
      .slice(0, 8)
      .map(idiom => idiom.id),
    guidance_digest: idioms
      .sort((left, right) => right.confidence - left.confidence)
      .slice(0, 8)
      .flatMap(idiom => idiom.agent_guidance.do.slice(0, 1)),
  };
}

function nodeEvidence(claim: string): (node: CASNode) => CASIdiomEvidence {
  return node => ({
    kind: 'node',
    file: node.source?.file,
    line: node.source?.line,
    node_id: node.id,
    claim: `${claim}: ${node.name}.`,
    confidence: 0.78,
  });
}

function edgeEvidence(edge: CASEdge, claim: string): CASIdiomEvidence {
  return {
    kind: 'edge',
    edge_id: edge.id,
    file: edge.metadata?.locations?.[0]?.file,
    line: edge.metadata?.locations?.[0]?.line,
    claim: `${claim}: ${edge.source} -> ${edge.target} (${edge.type}).`,
    confidence: edge.metadata?.confidence || 0.72,
  };
}

function fileEvidence(claim: string): (file: string) => CASIdiomEvidence {
  return file => ({
    kind: isMigrationPath(file) ? 'migration' : isTestPath(file) ? 'test' : 'file',
    file,
    claim: `${claim}: ${file}.`,
    confidence: 0.74,
  });
}

function nodeExample(idiomId: string, node: CASNode, index: number, explanation: string): CASIdiomExample {
  return {
    id: `${idiomId}-example-${index + 1}`,
    idiom_id: idiomId,
    file: node.source?.file || 'unknown',
    line: node.source?.line,
    node_id: node.id,
    name: node.name,
    excerpt: compactExcerpt(node.source?.raw),
    explanation,
  };
}

function fileExample(idiomId: string, file: string, index: number, explanation: string): CASIdiomExample {
  return {
    id: `${idiomId}-example-${index + 1}`,
    idiom_id: idiomId,
    file,
    explanation,
  };
}

function violation(
  idiomId: string,
  category: CASIdiomCategory,
  severity: CASIdiomViolation['severity'],
  node: CASNode,
  description: string,
  recommendation: string,
  index: number
): CASIdiomViolation {
  return {
    id: `${idiomId}-violation-${index + 1}`,
    idiom_id: idiomId,
    category,
    severity,
    file: node.source?.file,
    line: node.source?.line,
    node_id: node.id,
    description,
    recommendation,
    evidence: [nodeEvidence('Deviation candidate')(node)],
  };
}

function fileViolation(
  idiomId: string,
  category: CASIdiomCategory,
  severity: CASIdiomViolation['severity'],
  file: string,
  description: string,
  recommendation: string,
  index: number
): CASIdiomViolation {
  return {
    id: `${idiomId}-violation-${index + 1}`,
    idiom_id: idiomId,
    category,
    severity,
    file,
    description,
    recommendation,
    evidence: [fileEvidence('Deviation candidate')(file)],
  };
}

function isTestPath(file: string): boolean {
  return TEST_PATH.test(normalizePath(file));
}

function isMigrationPath(file: string): boolean {
  return MIGRATION_PATH.test(normalizePath(file));
}

function isConfigPath(file: string): boolean {
  return CONFIG_PATH.test(normalizePath(file));
}

function normalizePath(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '');
}

function normalizeProjectPath(projectPath: string, file: string): string {
  const normalizedFile = file.replace(/\\/g, '/');
  if (!nodePath.isAbsolute(normalizedFile)) return normalizedFile;
  const relative = nodePath.relative(projectPath, normalizedFile).replace(/\\/g, '/');
  if (!relative || relative.startsWith('..') || nodePath.isAbsolute(relative)) return normalizedFile;
  return relative;
}

/**
 * Rewrites an evidence's `claim` text to use the relativized file path
 * instead of whatever raw (possibly workspace-absolute, possibly
 * hash-directory-rooted) path it was originally built with. `claim` is a
 * free-text string baked at construction time (fileEvidence/nodeEvidence
 * interpolate `file` directly into the sentence), so relativizing the
 * sibling `file` field alone isn't enough — the same raw path can still be
 * sitting inside the sentence. Only rewrites when the original raw file
 * value actually appears in the claim, to avoid mangling unrelated text.
 */
function normalizeEvidenceClaim(evidence: CASIdiomEvidence, rawFile: string | undefined, normalizedFile: string): CASIdiomEvidence {
  if (!rawFile || !evidence.claim || !evidence.claim.includes(rawFile)) return { ...evidence, file: normalizedFile };
  return { ...evidence, file: normalizedFile, claim: evidence.claim.split(rawFile).join(normalizedFile) };
}

function normalizeDraftPaths(projectPath: string, draft: IdiomDraft): IdiomDraft {
  return {
    ...draft,
    evidence: draft.evidence.map(evidence => evidence.file
      ? normalizeEvidenceClaim(evidence, evidence.file, normalizeProjectPath(projectPath, evidence.file))
      : evidence),
    positive_examples: draft.positive_examples.map(example => example.file
      ? { ...example, file: normalizeProjectPath(projectPath, example.file) }
      : example),
    affected_scopes: draft.affected_scopes ? {
      ...draft.affected_scopes,
      files: draft.affected_scopes.files?.map(file => normalizeProjectPath(projectPath, file)),
    } : draft.affected_scopes,
    deviations: draft.deviations?.map(deviation => ({
      ...deviation,
      file: deviation.file ? normalizeProjectPath(projectPath, deviation.file) : deviation.file,
      evidence: deviation.evidence?.map(evidence => evidence.file
        ? normalizeEvidenceClaim(evidence, evidence.file, normalizeProjectPath(projectPath, evidence.file))
        : evidence),
    })),
  };
}

function countBy(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return counts;
}

function topCounted(values: string[], limit: number): string[] {
  return [...countBy(values).entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([value]) => value);
}

function dominantNamingStyle(names: string[]): { style: 'snake_case' | 'camelCase' | 'PascalCase'; label: string; prevalence: number } | undefined {
  const candidates = names.filter(name => name.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
  if (candidates.length === 0) return undefined;
  const styles = [
    { style: 'snake_case' as const, label: 'snake_case' },
    { style: 'camelCase' as const, label: 'camelCase' },
    { style: 'PascalCase' as const, label: 'PascalCase' },
  ].map(item => ({
    ...item,
    count: candidates.filter(name => nameMatchesStyle(name, item.style)).length,
  })).sort((left, right) => right.count - left.count);
  const top = styles[0];
  const prevalence = top.count / candidates.length;
  return prevalence >= 0.45 ? { style: top.style, label: top.label, prevalence } : undefined;
}

function nameMatchesStyle(name: string, style: 'snake_case' | 'camelCase' | 'PascalCase'): boolean {
  if (style === 'snake_case') return /^[a-z][a-z0-9_]*$/.test(name) && name.includes('_');
  if (style === 'camelCase') return /^[a-z][A-Za-z0-9]*$/.test(name) && /[A-Z]/.test(name);
  return /^[A-Z][A-Za-z0-9]*$/.test(name);
}

function confidenceFromPrevalence(prevalence: number, count: number): number {
  const countBoost = Math.min(0.16, Math.log10(Math.max(1, count)) / 8);
  return Math.max(0.45, Math.min(0.98, prevalence * 0.82 + countBoost));
}

function roundRatio(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000;
}

function slug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function uniqueNodes(nodes: CASNode[]): CASNode[] {
  const seen = new Set<string>();
  return nodes.filter(node => {
    if (seen.has(node.id)) return false;
    seen.add(node.id);
    return true;
  });
}

function compactExcerpt(raw?: string): string | undefined {
  if (!raw) return undefined;
  const line = raw.split('\n').map(item => item.trim()).find(Boolean);
  if (!line) return undefined;
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}
