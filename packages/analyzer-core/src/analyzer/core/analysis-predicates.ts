import * as fs from 'fs-extra';
import * as path from 'path';
import {
  CASOutput,
  CASNestedRepository,
  CASAnalysisPhase,
  CASAnalysisTimings,
  CASContribution,
  CASProgressiveLevels,
  CASCategories,
  CASPattern,
  CASBehavior,
  CASTag,
  CASIndex,
  CASPerspective,
  CASArchitectureSummary,
  CASRouteTableEntry,
  CASDatabaseSchema,
  CASDatabaseEntity,
  CASDatabaseRelationship,
  CASExternalService,
  CASEntryPoint,
  ENTRY_POINT_TYPES,
  EXIT_POINT_TYPES,
  CASExitPoint,
  CASExitPointType,
  CASIntent,
  CASFlowSummary,
  CASChangeRisk,
  ChangeRiskFactor,
  CASChangeRiskSummary,
  CASDataEntity,
  CASUserJourney,
  CASDescriptionGeneration,
  CASDataSummary,
  CASDataEntityKind,
  CASBehavioralInvariant,
  CASBehavioralInvariantSummary,
  CASSecurityBoundary,
  CASSecuritySummary,
  CASFlowCoverage,
  CASTestGap,
  CASTemporalStability,
  CASStabilitySummary,
  CASCallChain,
  SystemCapability,
  SystemPurpose,
  CASDomainConcept,
  EnhancedSystemPurpose,
  CASFlowGraph,
  CASFlowRef,
  CASCapabilityDependency,
  CASTestSuite,
  CASTestCase,
  CASMock,
  CASFixture,
  CASTestSummary,
  CASAnalysisError,
  CASValidation,
  CASConfiguration,
  CASRuntime,
  CASRuntimeStaticLink,
  CASAnalysisFact,
  CASDistributionUnit,
  DeployableEvidence,
  CASCrossRepositoryLink,
  CASMethodCall,
  CASDecorator,
  CASDocumentationSummary,
  CASTodoSummary,
  CASImplementationHealth,
  CASSystemHealth,
  CASSecurityContext,
  CASCallGraph,
  CASNodePerspective,
  CASLibrary,
  IncrementalState,
  ChangeSet,
  FileAnalysisRecord,
  ChangeReport,
  ChangeSemanticImpact,
  FileAnalysisResult,
  CAS_VERSION,
  INCREMENTAL_STATE_VERSION,
  CASArtifactType
} from '../../types/cas.types';
import {
  isBareNounCapabilityLabel as sharedIsBareNounCapabilityLabel,
  isStructuralPlaceholderCapabilityDescription as sharedIsStructuralPlaceholderCapabilityDescription,
  deriveCapabilityNameFromOperations as sharedDeriveCapabilityNameFromOperations,
  buildCapabilityDescriptionFromOperations as sharedBuildCapabilityDescriptionFromOperations,
  namingSubjectFromPath,
  stripSourceFileExtension,
  isPathDerivedCapabilityName,
  isStoragePathToken,
  isMalformedCapabilityLabel,
  collapseDuplicateAdjacentWords
} from './capability-naming';
import { aiConfig, getAIConfig } from '../../config/ai.config';
import { buildUserJourneys, USER_FACING_ENTRY_TYPES } from './journey-builder';
import { isRegisteredManifest, isRegisteredSourceExtension, isPackageBoundaryManifest } from './language-registry';
import { AnalyzerRegistration, CAPABILITY_STRUCTURAL_AREA_NAMES } from './orchestrator';
import { CASEdge, CASNode } from '../../types/cas.types';
export function isIgnoredInventoryFile(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/').toLowerCase();
    if (normalized.endsWith('.min.js') || normalized.endsWith('.min.css')) return true;
    return [
      '/lib/waypoints/',
      '/lib/owlcarousel/',
      '/lib/chart/',
      '/lib/easing/',
      '/lib/tempusdominus/',
      '/lib/bootstrap/',
      '/lib/jquery/',
      '/www/build/',
      '/www/assets/',
      '/public/assets/',
      '/static/assets/',
      '/downloads/'
    ].some(fragment => `/${normalized}`.includes(fragment));
  }

export function isCiPipelineConfigFile(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/').toLowerCase();
    const basename = path.basename(normalized);
    if (basename === '.gitlab-ci.yml') return true;
    if (basename === 'jenkinsfile') return true;
    if (basename === 'azure-pipelines.yml' || basename === 'azure-pipelines.yaml') return true;
    if (basename === '.travis.yml') return true;
    if (basename === '.drone.yml' || basename === '.drone.yaml') return true;
    if (basename === 'bitbucket-pipelines.yml' || basename === 'bitbucket-pipelines.yaml') return true;
    return normalized.startsWith('.github/workflows/') ||
      normalized === '.circleci/config.yml' ||
      normalized === '.buildkite/pipeline.yml' ||
      normalized === '.buildkite/pipeline.yaml' ||
      normalized.startsWith('.teamcity/');
  }

export function isManifestFile(filePath: string): boolean {
    return isRegisteredManifest(filePath);
  }

export function isLocalImportSpecifier(imported: string): boolean {
    return imported.startsWith('.') || imported.startsWith('/') || /\.(ts|tsx|js|jsx|mjs|cjs|py|cs|java|go|rs|php|dart)$/i.test(imported);
  }

export function isBehavioralIncrementalNode(node: CASNode): boolean {
    return [
      'controller',
      'route',
      'handler',
      'service',
      'repository',
      'entity',
      'model',
      'serializer',
      'resolver',
      'mutation',
      'function',
      'method',
      'class',
      'component',
      'hook',
      'middleware',
      'guard',
      'module'
    ].includes(node.type);
  }

export function isBehavioralIncrementalEdge(edge: CASEdge): boolean {
    return [
      'calls',
      'uses',
      'depends_on',
      'imports',
      'exports',
      'data_access',
      'external_call',
      'authenticates',
      'authorizes',
      'validates',
      'handles'
    ].includes(edge.type) || edge.category === 'external' || edge.category === 'data' || edge.category === 'security';
  }

export function isAnalyzerRelevantForProject(registration: AnalyzerRegistration, projectType: string): boolean {
    if (projectType === 'unknown') {
      return true;
    }

    if (registration.type === 'language') {
      if (['terraform', 'dockerfile', 'docker-compose', 'kubernetes-manifest', 'distribution-artifacts'].includes(registration.id)) {
        return true;
      }
      const languageMap: { [key: string]: string[] } = {
        'typescript-javascript': ['typescript', 'javascript'],
        'python': ['python'],
        'java': ['java', 'kotlin', 'scala'],
        'csharp': ['csharp', 'fsharp', 'vb'],
        'go': ['go'],
        'rust': ['rust'],
        'php': ['php'],
        'dart': ['dart']
      };

      return languageMap[registration.id]?.includes(projectType) || false;
    }

    return true;
  }

export function isLocalModuleSpecifier(specifier: string): boolean {
    const s = specifier.trim();
    if (!s) return false;
    if (s.startsWith('./') || s.startsWith('../') || s === '.' || s === '..') return true;
    if (s.startsWith('/')) return true;
    if (/^[a-zA-Z]:[\\/]/.test(s)) return true;
    return false;
  }

export function isInfrastructureArchitectureNode(node: CASNode): boolean {
    const type = String(node.type || '').toLowerCase();
    if (/^infrastructure_|^configuration_/.test(type)) return true;
    const metadata = (node.metadata || {}) as any;
    const attributes = metadata.attributes || {};
    if (attributes.terraform_type || attributes.terraform_address || metadata.terraform_type) return true;
    const file = (node.source?.file || '').replace(/\\/g, '/').toLowerCase();
    return /\.(tf|tfvars|hcl)$/i.test(file);
  }

export function isArchitecturalInventoryNode(node: CASNode): boolean {
    const type = String(node.type || '').toLowerCase();
    if ([
      'import',
      'use',
      'variable',
      'constant',
      'parameter',
      'property',
      'field',
      'attribute',
      'enum_member',
      'literal',
      'comment',
      'using',
    ].includes(type)) {
      return false;
    }

    if (type === 'method') {
      const name = String(node.name || '').toLowerCase();
      return /(handle|execute|process|dispatch|render|validate|authorize|route|action|command|query|event)/.test(name);
    }

    return true;
  }

export function isPrimaryProductPath(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/').toLowerCase();
    if (!normalized) return true;
    if (/^(fixtures?|__fixtures__|testdata|cas-tests|tests?|__tests__|spec|e2e|cypress|playwright)[./]/.test(normalized)) return false;
    if (/[./](fixtures?|__fixtures__|testdata|cas-tests|tests?|__tests__|spec|e2e|cypress|playwright)[./]/.test(normalized)) return false;
    if (/(^|\/)(node_modules|dist|build|coverage|vendor|vendors|generated|fixtures?|__fixtures__|__mocks__)(\/|$)/.test(normalized)) return false;
    if (/\.(min|bundle)\.(js|css)$/.test(normalized)) return false;
    if (/\/lib\/(waypoints|owlcarousel|chart|easing|tempusdominus|bootstrap|jquery)\//.test(normalized)) return false;
    if (/(^|\/)(__tests__|tests?|spec|e2e|cypress|playwright)(\/|$)/.test(normalized)) return false;
    if (/\.(test|spec|stories|story)\.[a-z0-9]+$/.test(normalized)) return false;
    if (/(^|\/)test-[^/]+\.[a-z0-9]+$/.test(normalized)) return false;
    if (/^legacy\//.test(normalized)) return false;
    if (/(^|\/)db\/migrate(\/|$)/.test(normalized)) return false;
    return true;
  }

export function isIntegrationClientFilePath(file: string): boolean {
    const normalized = file.replace(/\\/g, '/').toLowerCase();
    if (/(^|\/)[a-z0-9_-]*(client|connector|adapter|integration)\.[a-z0-9]+$/.test(normalized)) return true;
    const segments = normalized.split('/').filter(Boolean);
    return segments.some((segment, index) => {
      if (!/^(clients?|sdk|connectors?|adapters?|integrations?)$/.test(segment)) return false;
      if (segment === 'clients' && (segments[index - 1] === 'dev' || segments[index - 2] === 'dev')) return false;
      return true;
    });
  }

export function isInfrastructureMachineryName(name: string): boolean {
    const trimmed = String(name || '').trim();
    if (!trimmed) return false;
    const verb = '(?:manage|deploy|run|build|release|install|execute|configure|orchestrate|maintain|publish|package)';
    const subject = '(?:shell\\s+scripts?|batch\\s+scripts?|powershell\\s+scripts?|binari(?:es|y)|installers?|' +
      'release\\s+scripts?|deploy(?:ment)?\\s+scripts?|build\\s+scripts?|docker\\s+images?|container\\s+images?|' +
      'ci(?:\\/cd)?\\s+pipelines?|continuous\\s+integration\\s+pipelines?|build\\s+pipelines?)';
    return new RegExp(`^${verb}\\b(?:\\s+and\\s+${verb}\\b)?.{0,20}\\b${subject}\\b`, 'i').test(trimmed);
  }

export function isInfrastructureShapedEntityName(name: string): boolean {
    const INFRA_SEGMENT = /^(Sentinel|Sentinels|Runtime|Runtimes|Daemon|Daemons|Spawn|Spawns|Restart|Restarts|Heartbeat|Heartbeats|Watchdog|Supervisor|Bootstrap|Lifecycle|Presence|Invoke|Invokes|Invocation|Runner|Runners|Worker|Workers|Scheduler|Reaper|Janitor|Usage|Uptime|Liveness|Readiness|Hook|Hooks)$/;
    const segments = String(name || '').trim().replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/\s+/);
    return segments.some(segment => INFRA_SEGMENT.test(segment));
  }

export function isBareNounCapabilityLabel(name: string): boolean {
    return sharedIsBareNounCapabilityLabel(name);
  }

export function isStructuralPlaceholderCapabilityDescription(description: string): boolean {
    return sharedIsStructuralPlaceholderCapabilityDescription(description);
  }

export function isGroundedAIDomainLabel(label: string, enhancedSystemPurpose: EnhancedSystemPurpose): boolean {
    const genericTokens = new Set([
      'system', 'software', 'application', 'app', 'platform', 'service', 'services', 'tool', 'tools',
      'portal', 'web', 'site', 'management', 'operations', 'solution', 'solutions', 'product',
      'business', 'data', 'digital', 'online', 'general', 'misc', 'unknown',
    ]);
    const tokens = label.split('-');
    const meaningful = tokens.filter(token => !genericTokens.has(token));
    if (meaningful.length === 0) return false;
    const groundingText = [
      enhancedSystemPurpose.inferred_description,
      enhancedSystemPurpose.primary_domain,
      ...(enhancedSystemPurpose.core_concepts || []),
    ].join(' ').toLowerCase();
    return meaningful.every(token => groundingText.includes(token.slice(0, Math.min(6, token.length))));
  }

export function hasAIInterpretationProviderConfigured(): boolean {
    const freshConfig = getAIConfig();
    return Boolean(
      freshConfig.openai.apiKey ||
      freshConfig.anthropic.apiKey
    );
  }

export function isCodeIdentifierSubjectToken(token: string): boolean {
    if (token.length <= 3) return true;
    return new Set([
      'impl', 'impls', 'util', 'utils', 'libs', 'mods', 'crate', 'crates', 'proc', 'procs',
      'init', 'main', 'misc', 'temp', 'tmps', 'vars', 'func', 'funcs', 'iter', 'sync', 'async',
      'macro', 'macros', 'trait', 'traits', 'struct', 'structs', 'enums', 'types', 'typedefs',
      'param', 'params', 'args', 'deps', 'pkgs', 'bins', 'objs', 'ptrs', 'refs', 'vecs',
      'stdlib', 'builtin', 'builtins', 'internals', 'srcs',
    ]).has(token);
  }

export function isCodebaseTypeShapedDomainLabel(primaryDomain: string): boolean {
    const label = String(primaryDomain || '').toLowerCase().trim();
    if (!label) return false;
    return /-(platform|service|services|server|tool|tools|toolkit|sdk|library|package|framework|engine|base|suite|cli|daemon|agent|gateway|proxy|runtime|compiler|driver|plugin|extension|boilerplate|template|codebase|application|app)$/.test(label);
  }

export function isHashOrIdShapedToken(token: string): boolean {
    const normalized = (token || '').toLowerCase();
    if (normalized.length < 8) return false;
    if (/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/.test(normalized)) return true;
    if (normalized.length >= 12 && /^[0-9a-f]+$/.test(normalized)) return true;
    if (normalized.length >= 10 && /^[0-9a-z]+$/.test(normalized) && /[0-9]/.test(normalized) && !/[aeiou]/.test(normalized)) {
      return true;
    }
    return false;
  }

export function isCrossCuttingCapabilityName(name: string): boolean {
    return /\b(auth|authenticate|authentication|authorization|login|logout|session|token|jwt|oauth|permission|role|superuser|admin|user|users)\b/i.test(name);
  }

export function isPocoEntityClassNode(node: CASNode): boolean {
    if (node.type !== 'class') return false;
    if (node.subcategories?.includes('abstract')) return false;
    const attrs = (node.metadata?.attributes || {}) as Record<string, unknown>;
    const namespace = String(attrs.namespace || '');
    const file = String(node.source?.file || '').replace(/\\/g, '/');
    const entityNamespace = /(^|\.)(entities|models|domain)(\.|$)/i.test(namespace);
    const entityFolder = /(^|\/)(entities|models|domain)(\/|$)/i.test(file);
    if (!entityNamespace && !entityFolder) return false;
    const propertyCount = Number(attrs.propertyCount || 0);
    const methodCount = Number(attrs.methodCount || 0);
    return propertyCount >= 1 && propertyCount >= methodCount;
  }

export function isPlainStructEntityNode(node: CASNode): boolean {
    if (node.type !== 'struct') return false;
    if (node.subcategories?.includes('abstract')) return false;
    const file = String(node.source?.file || '').replace(/\\/g, '/');
    const entityFolder = /(^|\/)(models?|entities|domain|schema)(\/|$)/i.test(file);
    if (!entityFolder) return false;
    const attrs = (node.metadata?.attributes || {}) as Record<string, unknown>;
    const fieldCount = Number(attrs.fieldCount || 0);
    const methodCount = Number(attrs.methodCount || 0);
    return fieldCount >= 1 && fieldCount >= methodCount;
  }

export function isCodeArtifactRoleName(name: string): boolean {
    const trimmed = String(name || '').trim();
    if (/(Handler|Handlers|Adapter|Adapters|Registry|Registries|Factory|Factories|Provider|Providers|Middleware|Middlewares|Preflight|Pending|Core|Gate|Gates|Dispatcher|Dispatchers|Dispatch|Container|Containers|View|Views)$/.test(trimmed)) {
      return true;
    }
    if (/^(Send|Handle|Register)[A-Z]/.test(trimmed)) {
      return true;
    }
    // domain noun) is NOT flagged — the role token must not be the head word.
    const segments = trimmed.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/\s+/);
    return segments.some((segment, index) =>
      index >= 1 &&
      /^(Gate|Gates|Dispatch|Dispatcher|Dispatchers|Handler|Handlers|Container|Containers|Sentinel|Sentinels)$/.test(segment));
  }

export function isScopeField(name: string): boolean {
    return /^(tenant|tenantid|tenant_id|organization|organizationid|organization_id|organisation|orgid|org_id|workspace|workspaceid|workspace_id|account|accountid|account_id|company|companyid|company_id)$/i.test(name);
  }

export function isMigrationFile(file: string): boolean {
    const lower = file.toLowerCase();
    return lower.includes('/migrations/') ||
      lower.includes('/migration/') ||
      lower.includes('prisma/migrations') ||
      /(^|\/)\d{8,}.*\.(ts|js|sql|php|py)$/.test(lower);
  }

export function isIntentionallyPublicMutationEntryPoint(entryPoint: CASEntryPoint): boolean {
    const text = [
      entryPoint.name,
      entryPoint.trigger?.path,
      entryPoint.handler?.method_name,
      entryPoint.input?.type,
      (entryPoint.metadata as any)?.operationId,
      ...((entryPoint.metadata as any)?.tags || []),
    ].filter(Boolean).join(' ').toLowerCase();
    if (!text) return false;

    const publicAuth = [
      /\b(login|log-in|signin|sign-in|authenticate)\b/,
      /\b(register|signup|sign-up|create account)\b/,
      /\b(password reset|forgot password|reset-password|forgot-password)\b/,
      /\b(oauth|oidc|sso|saml)\b.*\b(discover|authorize|callback|redirect|metadata)\b/,
      /\b(discover|authorize|callback|redirect|metadata)\b.*\b(oauth|oidc|sso|saml)\b/,
      /\b(token|refresh-token)\b/,
    ];
    if (publicAuth.some(pattern => pattern.test(text))) return true;

    const publicBootstrap = [
      /\binitial[-_/ ]?setup\b/,
      /\bfirst[-_/ ]?run\b/,
      /\bbootstrap\b/,
      /\binstall\b/,
      /\bsetup[-_/ ]?wizard\b/,
    ];
    return publicBootstrap.some(pattern => pattern.test(text));
  }

export function isGenericLibraryUsageNode(node: CASNode): boolean {
    return typeof node.type === 'string' && /^library_.*_usage$/.test(node.type);
  }

export function isUserReachableTerminalCandidate(
    capability: SystemCapability,
    dataEntities: CASDataEntity[],
    hasEffectEvidence = false,
    isProximallyUserReachable = false
  ): boolean {
    const hasUserTriggeredEntry = (capability.operations || []).some(
      operation => USER_FACING_ENTRY_TYPES.has(operation.entry_point_type as any)
    ) || isProximallyUserReachable;
    if (!hasUserTriggeredEntry) return false;

    const relatedEntityIds = capability.related_entities || [];
    if (relatedEntityIds.length === 0) return true;
    const entityById = new Map(dataEntities.map(entity => [entity.id, entity]));
    const hasEntityWrite = relatedEntityIds.some(entityId => {
      const entity = entityById.get(entityId);
      if (!entity) return false;
      return (entity.lifecycle?.created_by?.length || 0) > 0
        || (entity.lifecycle?.updated_by?.length || 0) > 0
        || (entity.lifecycle?.deleted_by?.length || 0) > 0;
    });
    return hasEntityWrite || hasEffectEvidence;
  }

export function isHardLowValueCapability(capability: SystemCapability): boolean {
    const name = capability.name || '';
    if (/^(Login|Logout|Sign In|Sign Out)$/i.test(name) && capability.related_entities.length === 0) return true;
    if (/^(Synchronize|Sync|Replicate|Mirror)\s+(Synchronization|Workflow|Capability)$/i.test(name)) return true;
    if (/^(Bad|Not|Bind|Branding|Poll|Usd|Pnl|Control|Destroy|Routing|Container|Scaffold|Sized|Result|Layer|Layers|Call|Forward|Weight Norm|Jit|Nets|Gui|Prepare Scriptable|Drag|Edit|Javascript|Day|Migrate|Type|Timezone|Require Access|Duplicate Task|Printt|Hooks Hooks|Boundary|Sentry|Mutate|Settled|Capture Exception|Token|Prefetch|Fallback|Material|Gesture Detector|Len|Matmul Relative|Atom|Bulk|Busy|Duplicate|Allowed|Boolean|Code|Define|Doc|Docs|Gen|Mdx|Meta|Tabs|Tick|And|Disable And|Can|Definitions|Emoji|Field|Fields|Array|Attributes|Description|Functions?|Regular|Duration|Factory|Fixtures? Fixture|Background|Design|Loader|Mobile|Multiplayer|Socket|Category|Confirm|Hashed|Non|Upload|Synced|Static|Canvas|Klauro|Number|Avatar|Game|Lobby|Mfaenroll|Mfaverify|Rectangle|Rendered|Splash|Circle|Alert|Alerts?|Sign|Signs?)\s+(Management|Workflow|Capability|Settlement)$/i.test(name)) return true;
    if (/\b([a-z]+)s?\s+(analysis|management|workflow|reporting|generation)\s+\1\s+\2\b/i.test(name)) return true;
    return /\b(Access Token|Big Int|Screens?|Skeleton|Tab|End|Top|Exchange Code Token|Truncate Device|Running|Compose|Vpn|Binary|Uint8|Uint16|Uint32|Uint64|Int8|Int16|Int32|Int64)\s+(Management|Capability|Workflow)\b/i.test(name);
  }

export function isAnalyzerImplementationPurposeSignalNode(node: CASNode): boolean {
    const file = (node.source?.file || '').replace(/\\/g, '/').toLowerCase();
    if (/(^|\/)packages\/analyzer-core\/src\/analyzer\/(core|frameworks|languages|library|libraries)\//.test(file)) return true;
    if (/(^|\/)packages\/analyzer-core\/src\/ai\//.test(file)) return true;
    if (/(^|\/)apps\/mcp-server\/src\/agent-.*benchmark\.ts$/.test(file)) return true;
    return false;
  }

export function isStructurallyMalformedCapabilityName(capabilityName: string): boolean {
    const core = capabilityName.replace(/\s+(Management|Capability|Workflow|Service|Processing|Handling)$/i, '').trim();
    if (!core) return true;
    const tokens = core.split(/\s+/);
    if (tokens.length === 1 && tokens[0].length <= 3) return true;
    const IMPERATIVE_VERBS = new Set([
      'register', 'get', 'set', 'fetch', 'create', 'update', 'delete', 'remove', 'handle',
      'process', 'list', 'find', 'init', 'initialize', 'make', 'build', 'run', 'send', 'load',
      'parse', 'validate', 'ensure', 'compute', 'calculate', 'generate', 'resolve', 'apply',
      'check', 'emit', 'dispatch', 'refresh', 'toggle', 'enable', 'disable',
    ]);
    if (tokens.length > 1 && IMPERATIVE_VERBS.has(tokens[0].toLowerCase())) return true;
    return false;
  }

export function isEvidenceLightFallbackCapability(
    capabilityName: string,
    entities: CASDataEntity[],
    operations: SystemCapability['operations']
  ): boolean {
    if (/\b(graph|control|user control|picker|radius|rtfbox|textbox|combobox|button|label|panel|grid|window|end|skeleton|tab|screens?|big int|device arp|access token|exchange code token|truncate device|running|compose|vpn)\s+(management|workflow|capability)\b/i.test(capabilityName)) {
      return true;
    }
    if (!/\b(Capability|Management|Workflow)$/i.test(capabilityName)) return false;
    if (entities.length > 0) return false;
    const internalOperations = operations.filter(operation => operation.entry_point_type === 'internal');
    if (internalOperations.length < operations.length) return false;
    if (operations.length > 2 && !/\bCapability$/i.test(capabilityName)) return false;
    const normalizedName = capabilityName.toLowerCase();
    if (/\b(auth|tenant|payment|billing|invoice|transaction|pricing|trade|token|market|portfolio|order|patient|vehicle|driver|fuel|report|clinical|device)\b/.test(normalizedName)) {
      return false;
    }
    return true;
  }

export function hasProductEvidenceOutsideRoots(resolvedProject: string, excludedRoots: string[]): boolean {
    const MANIFESTS = [
      'package.json', 'go.mod', 'pyproject.toml', 'requirements.txt', 'setup.py',
      'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'composer.json',
      'Gemfile', 'mix.exs', 'pubspec.yaml',
    ];
    const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|c|cc|cpp|ex|exs|swift|scala)$/i;
    try {
      for (const manifest of MANIFESTS) {
        if (fs.existsSync(path.join(resolvedProject, manifest))) return true;
      }
      const excluded = new Set(excludedRoots.map(root => path.resolve(root)));
      const entries = fs.readdirSync(resolvedProject, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && SOURCE_EXT.test(entry.name)) return true;
        if (!entry.isDirectory()) continue;
        if (/^(node_modules|\.git|dist|build|coverage|docs?)$/i.test(entry.name)) continue;
        const dir = path.join(resolvedProject, entry.name);
        if (excluded.has(path.resolve(dir))) continue;
        for (const manifest of MANIFESTS) {
          if (fs.existsSync(path.join(dir, manifest))) return true;
        }
      }
    } catch {
    }
    return false;
  }

export function isFrontendUiPackageManifest(manifestPath: string, rootManifestName?: string): boolean {
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (typeof parsed?.name === 'string' && rootManifestName && parsed.name === rootManifestName) {
        return false;
      }
      const deps = {
        ...(parsed?.dependencies || {}),
        ...(parsed?.devDependencies || {}),
      };
      const depNames = Object.keys(deps);
      const hasUiFramework = depNames.some(dep =>
        /^(react|react-dom|vue|@vue\/.*|svelte|solid-js|@angular\/core)$/.test(dep)
      );
      const hasFrontendBuildTooling = depNames.some(dep =>
        /^(vite|@vitejs\/.*|webpack|parcel|react-scripts|@craco\/craco|next|nuxt|@sveltejs\/kit)$/.test(dep)
      );
      return hasUiFramework && hasFrontendBuildTooling;
    } catch {
      return false;
    }
  }

export function isInternalCapabilityHelperNode(node: CASNode): boolean {
    const name = node.name
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_\-./]/g, ' ')
      .toLowerCase()
      .trim();
    if (/^(update|append|write)\s+log$/.test(name)) return true;
    if (/^(set|toggle)\s+(visual|display|screen|menu|mode)(\s+mode)?$/.test(name)) return true;
    if (/^(extract|parse|format)\s+(text|html|json|response)$/.test(name)) return true;
    if (/^(calculate|compute|get)\s+rent\s+exemption/.test(name)) return true;
    return false;
  }

export function isBusinessOrDomainNode(node: CASNode): boolean {
    const text = `${node.type} ${node.name} ${(node.subcategories || []).join(' ')}`
      .toLowerCase()
      .replace(/[_-]/g, ' ');
    const file = (node.source?.file || '').replace(/\\/g, '/').toLowerCase();
    return /\b(entity|model|schema|service|usecase|use case|interactor|handler|processor|workflow|flow|function|method|repository|store|controller|resolver)\b/.test(text) ||
      (node.type === 'class' && /(^|\/)(entity|entities|model|models|controller|controllers|service|services|event[-_]?handler|event[-_]?handlers|handler|handlers|repository|repositories|store|stores)(\/|$)/.test(file)) ||
      (node.type === 'class' && /\b(controller|service|handler|repository|store|model|entity)\b/.test(text));
  }

export function isBusinessOwnerNode(node: CASNode): boolean {
    const text = `${node.type} ${node.name} ${(node.subcategories || []).join(' ')}`
      .toLowerCase()
      .replace(/[_-]/g, ' ');
    const file = (node.source?.file || '').replace(/\\/g, '/').toLowerCase();
    return /\b(entity|model|schema|service|usecase|use case|interactor|handler|processor|workflow|flow|repository|store|controller|resolver)\b/.test(text) ||
      (node.type === 'class' && /(^|\/)(entity|entities|model|models|controller|controllers|service|services|event[-_]?handler|event[-_]?handlers|handler|handlers|repository|repositories|store|stores)(\/|$)/.test(file)) ||
      (node.type === 'class' && /\b(controller|service|handler|repository|store|model|entity)\b/.test(text));
  }

export function hasObservabilityAnalyzerEvidence(node: CASNode): boolean {
    const meta = (node.metadata as any) || {};
    if (meta.observability_system || meta.instrumentation_kind) return true;
    const subs = [...(node.subcategories || []), ...((meta.subcategories || []) as string[])];
    return subs.includes('observability-module') || subs.includes('observability-instrumentation');
  }

export function isStructuralAreaName(area: string): boolean {
    return area.split(/\s+/).every(token => CAPABILITY_STRUCTURAL_AREA_NAMES.has(token));
  }

export function isCapabilityBearingEntryPoint(ep: CASEntryPoint): boolean {
    const type = String(ep.type || '').toLowerCase();
    if (type === 'test' || type === 'file' || type === 'lifecycle') return false;
    if ([
      'http', 'websocket', 'ws_handler', 'cli', 'event', 'message',
      'schedule', 'scheduled', 'cron', 'queue', 'grpc', 'graphql',
      'page', 'route',
      'train', 'notebook-cell',
    ].includes(type)) {
      return true;
    }
    return false;
  }

export function isBlockedSignalCompound(tokens: string[], start: number, end: number): boolean {
    if (end - start !== 1) return false;
    const blockers: Record<string, { before: string[]; after: string[] }> = {
      card: {
        before: ['credit', 'gift', 'debit', 'loyalty', 'membership', 'business', 'bank', 'id', 'sim', 'sd', 'key'],
        after: ['reader', 'holder'],
      },
      board: { before: ['dash', 'on', 'key', 'clip', 'leader', 'white'], after: [] },
      turn: { before: ['re'], after: [] },
    };
    const token = tokens[start];
    const rule = Object.prototype.hasOwnProperty.call(blockers, token) ? blockers[token] : undefined;
    if (!rule) return false;
    const before = tokens[start - 1];
    const after = tokens[end];
    return (before !== undefined && rule.before.includes(before)) ||
      (after !== undefined && rule.after.includes(after));
  }

export function isTestingFrameworkContribution(contribution: any): boolean {
    const name = String(contribution?.analyzer_name || contribution?.analyzer_id || '').toLowerCase();
    return /\b(jest|vitest|mocha|jasmine|cypress|playwright|testing-library|test)\b/.test(name);
  }

export function isGenericDuplicateConcept(concept: string): boolean {
    return new Set([
      'base',
      'common',
      'config',
      'default',
      'error',
      'handler',
      'helper',
      'index',
      'main',
      'shared',
      'test',
      'types',
      'utils'
    ]).has(concept);
  }

export function isSensitiveEnvVar(name: string): boolean {
    const sensitive = ['secret', 'password', 'key', 'token', 'credential', 'auth', 'private'];
    const lower = (name || '').toLowerCase();
    return sensitive.some(s => lower.includes(s));
  }
