import { AnalyzerOrchestrator, type AnalysisProgressEvent } from '../../../packages/analyzer-core/src/analyzer/core/orchestrator';
import type { BaseAnalyzer } from '../../../packages/analyzer-core/src/analyzer/core/base-analyzer';
import { linkStructuralOwnership } from '../../../packages/analyzer-core/src/analyzer/core/structural-ownership';
import { assignNodeRoles } from '../../../packages/analyzer-core/src/analyzer/core/node-roles';
import { partitionAnalysisDiagnostics } from '../../../packages/analyzer-core/src/analyzer/core/analysis-diagnostics';
import type { CASOutput, IncrementalState, ChangeReport, ChangeHistoryEntry } from '../../../packages/analyzer-core/src/types/cas.types';
import { aiService } from '../../../packages/analyzer-core/src/ai/ai-service';
import { buildCompletedAnalysisLayersReady } from './layered-analysis';
import { resolveLayeredEnrichmentPhase } from './layered-analysis-metadata';
import { saveAnalysisWithSourceCoverage as saveAnalysis } from './source-coverage';
import { beginForegroundAnalysis } from './foreground-analysis';
import { registerHostedBackgroundPreflight, withHostedForegroundPermit } from './hosted-background-queue';
import { architectureLibraryAnalyzerDefinitions } from '../../../packages/analyzer-core/src/analyzer/libraries/architecture';
import type { AnalyzerRegistration } from '../../../packages/analyzer-core/src/analyzer/core/orchestrator';
import * as fs from 'fs-extra';
import * as nodeFs from 'fs';
import * as path from 'path';
import { fork, type ChildProcess } from 'child_process';
import {
  getAnalysisRunLogPath,
  readRecentRunRecords,
  type AnalysisRunFinalRecord,
  type AnalysisRunRecord,
  type AnalysisRunStartRecord,
} from '../../../packages/analyzer-core/src/analyzer/core/run-log';
import { resolveAnalysisHeapMb, type AnalysisHeapResolution } from './analysis-heap';
import { AnalysisMemoryCapacityError, assertAnalysisWorkerMemoryAvailable, readContainerMemory } from './analysis-memory';
import { analysisWorkerExecArgv, resolveAnalysisWorkerEntry } from './analysis-worker-channel';
export { analysisWorkerExecArgv } from './analysis-worker-channel';
import {
  executeHostedAnalysis,
  reserveHostedAnalysisOrThrow,
  type HostedAnalysisAdmissionMetadata,
  type HostedAnalysisTicket,
} from './hosted-analysis-admission';
import {
  assertAnalysisVersionSupported,
  getAnalysisVersionInfo,
  loadAnalysis,
  loadAnalysisSections,
  loadCompleteAnalysisFromSections,
  saveIncrementalState,
  loadIncrementalState,
  saveChangeHistoryEntry,
  saveAnalysisSnapshot,
  listAnalysisSnapshots,
  saveFileCache,
  loadFileCache,
  getProjectStorageDir, getAnalysisEntry,
  withProjectAnalysisLock,
  withProjectAnalysisLockIfAvailable,
  writeJsonAtomic
} from './storage';
import { CAS_SECTION_NAMES, type CasSectionName } from './cas-sections';
import { loadKlauroConfig, validateEmbeddingConfig, validateConventions, type KlauroConventions } from './klauro-config';
import { clearFreshnessSummaryCache } from './freshness';
import { describeAnalysisVersion } from './analysis-version';
import { createEmbeddingProvider } from '../../../packages/analyzer-core/src/analyzer/embedding/embedding-provider-factory';
import { createVectorStore } from '../../../packages/analyzer-core/src/analyzer/embedding/vector-store-factory';
import type { VectorStoreSetting } from '../../../packages/analyzer-core/src/analyzer/embedding/vector-store-factory';
import type { VectorStore } from '../../../packages/analyzer-core/src/analyzer/embedding/types';
import type { EmbeddingPhaseConfig } from '../../../packages/analyzer-core/src/analyzer/embedding/embedding-phase';
import { getPgPool, resolvePgConnectionString } from './pg-pool';
import { applyStoredElementDescriptions, validateDescription } from './description-enrichment';
import { isLanguageBuiltinName } from '../../../packages/analyzer-core/src/analyzer/core/language-builtins';
import { TEST_FRAMEWORK_DETECTION_FILES } from './test-framework-detection';

let orchestrator: AnalyzerOrchestrator | null = null;

function lazyAnalyzerRegistration(load: () => BaseAnalyzer, incremental: boolean, discoversNestedRoots = false): Pick<AnalyzerRegistration, 'analyzer' | 'incremental' | 'discoversNestedRoots'> {
  let analyzer: BaseAnalyzer | undefined;
  return {
    incremental,
    discoversNestedRoots,
    analyzer: new Proxy({} as BaseAnalyzer, {
      get(_target, property) {
        analyzer ??= load();
        const value = Reflect.get(analyzer, property, analyzer);
        return typeof value === 'function' ? value.bind(analyzer) : value;
      },
      set(_target, property, value) {
        analyzer ??= load();
        return Reflect.set(analyzer, property, value, analyzer);
      },
    }),
  };
}

export function createOrchestrator(): AnalyzerOrchestrator {
  const created = new AnalyzerOrchestrator();
  created.configureAnalyzerContributionCache(process.env.KLAURO_ANALYZER_CONTRIBUTION_CACHE_PATH);

  const languageRegistrations: AnalyzerRegistration[] = [
    {
      id: 'typescript-javascript',
      name: 'TypeScript/JavaScript Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['package.json', 'tsconfig.json', 'jsconfig.json'],
        content: [/\.ts$/, /\.js$/, /\.tsx$/, /\.jsx$/],
      },
      ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/languages/typescript-javascript-analyzer').TypeScriptJavaScriptAnalyzer)(), true),
    },
    {
      id: 'python',
      name: 'Python Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['requirements.txt', 'setup.py', 'pyproject.toml', 'Pipfile'],
        content: [/\.py$/],
      },
      ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/languages/python-analyzer').PythonAnalyzer)(), true),
    },
    {
      id: 'java',
      name: 'Java Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['pom.xml', 'build.gradle', 'build.gradle.kts'],
        content: [/\.java$/],
      },
      ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/languages/java-analyzer').JavaAnalyzer)(), true),
    },
    {
      id: 'csharp',
      name: 'C# Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['*.csproj', '*.sln'],
        content: [/\.cs$/],
      },
      ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/languages/csharp-analyzer').CSharpAnalyzer)(), true),
    },
    {
      id: 'go',
      name: 'Go Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['go.mod', 'go.sum'],
        content: [/\.go$/],
      },
      ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/languages/go-analyzer').GoAnalyzer)(), true),
    },
    {
      id: 'rust',
      name: 'Rust Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['Cargo.toml', 'Cargo.lock'],
        content: [/\.rs$/],
      },
      ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/languages/rust-analyzer').RustAnalyzer)(), true),
    },
    {
      id: 'php',
      name: 'PHP Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['composer.json', 'composer.lock'],
        content: [/\.php$/],
      },
      ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/languages/php-analyzer').PHPAnalyzer)(), true),
    },
    {
      id: 'ruby',
      name: 'Ruby Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['Gemfile', 'Gemfile.lock', 'Rakefile'],
        content: [/\.rb$/],
      },
      ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/languages/ruby-analyzer').RubyAnalyzer)(), true),
    },
    {
      id: 'shell',
      name: 'Shell/Bash Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: [],
        content: [/\.(sh|bash|zsh|ksh)$/],
      },
      consumesExistingAnalysis: false, ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/languages/shell-analyzer').ShellAnalyzer)(), true),
    },
    {
      id: 'solidity',
      name: 'Solidity Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: [],
        content: [/\.sol$/],
      },
      ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/languages/solidity-analyzer').SolidityAnalyzer)(), true),
    },
    {
      id: 'c-cpp',
      name: 'C/C++ Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: [],
        content: [/\.(c|h|cpp|cc|cxx|hpp|hh|hxx)$/i],
      },
      ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/languages/c-cpp-analyzer').CCppAnalyzer)(), true),
    },
    {
      id: 'swift',
      name: 'Swift Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['Package.swift'],
        content: [/\.swift$/],
      },
      ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/languages/swift-analyzer').SwiftAnalyzer)(), true),
    },
    {
      id: 'kotlin',
      name: 'Kotlin Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: [],
        content: [/\.(kt|kts)$/],
      },
      ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/languages/kotlin-analyzer').KotlinAnalyzer)(), true),
    },
    {
      id: 'elixir',
      name: 'Elixir Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['mix.exs'],
        content: [/\.(ex|exs)$/],
      },
      ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/languages/elixir-analyzer').ElixirAnalyzer)(), true),
    },
    {
      id: 'protobuf',
      name: 'Protobuf/gRPC Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: [],
        content: [/\.proto$/],
      },
      ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/languages/protobuf-analyzer').ProtobufAnalyzer)(), true),
    },
    {
      id: 'soap-wsdl',
      name: 'SOAP/WSDL Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['**/*.wsdl', '**/*.xsd'],
        content: [/\.wsdl$/i, /\.xsd$/i, /from\s+['"](?:soap|strong-soap)['"]/, /import\s+(?:zeep|suds)\b/, /@(WebServiceClient|WebService)\b/, /System\.ServiceModel/, /Savon\.client\b/],
      },
      consumesExistingAnalysis: false, ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/languages/soap-wsdl-analyzer').SoapWsdlAnalyzer)(), true),
    },
    {
      id: 'dart',
      name: 'Dart/Flutter Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['pubspec.yaml'],
        content: [/\.dart$/],
      },
      ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/languages/dart-analyzer').DartAnalyzer)(), true),
    },
    {
      id: 'terraform',
      name: 'Terraform/HCL Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['*.tf', '*.tfvars'],
        content: [/\.tf$/, /\.tfvars$/],
      },
      ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/languages/terraform-analyzer').TerraformAnalyzer)(), true),
    },
    {
      id: 'cloudformation',
      name: 'CloudFormation Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['**/*.template', '**/*.yaml', '**/*.yml', '**/*.json'],
        content: [/AWSTemplateFormatVersion/, /Resources:\s*[\s\S]*Type:\s*AWS::/, /"Resources"\s*:\s*\{[\s\S]*"Type"\s*:\s*"AWS::/],
      },
      ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/languages/cloudformation-analyzer').CloudFormationAnalyzer)(), true),
    },
    {
      id: 'sql-schema',
      name: 'SQL Schema Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['**/*.sql', '**/*.ddl'],
        content: [/CREATE\s+(?:GLOBAL\s+|LOCAL\s+)?(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+)?TABLE/i],
      },
      ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/languages/sql-schema-analyzer').SqlSchemaAnalyzer)(), true),
    },
    {
      id: 'json-file-store',
      name: 'JSON File Store Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['**/*.js', '**/*.mjs', '**/*.cjs', '**/*.ts', '**/*.mts', '**/*.cts'],
        content: [/write(?:File|Json)(?:Sync)?\s*\(/],
      },
      ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/languages/json-file-store-analyzer').JsonFileStoreAnalyzer)(), true),
    },
    {
      id: 'dockerfile',
      name: 'Dockerfile Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['Dockerfile', 'Dockerfile.*', '*.Dockerfile'],
        content: [/^FROM\s+/m],
      },
      consumesExistingAnalysis: false, ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/languages/container-topology-analyzer').DockerfileAnalyzer)(), true),
    },
    {
      id: 'docker-compose',
      name: 'Docker Compose Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['compose.yml', 'compose.yaml', 'docker-compose.yml', 'docker-compose.yaml', 'docker-compose.*.yml', 'docker-compose.*.yaml'],
        content: [/^services:\s*$/m],
      },
      consumesExistingAnalysis: false, ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/languages/container-topology-analyzer').DockerComposeAnalyzer)(), true),
    },
    {
      id: 'kubernetes-manifest',
      name: 'Kubernetes Manifest Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['k8s/**/*.yaml', 'k8s/**/*.yml', 'kubernetes/**/*.yaml', 'kubernetes/**/*.yml', 'deploy/**/*.yaml', 'deploy/**/*.yml'],
        content: [/^apiVersion:\s+/m, /^kind:\s+(Deployment|Service|Ingress|StatefulSet|Job|CronJob|ConfigMap|Secret)/m],
      },
      consumesExistingAnalysis: false, ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/languages/container-topology-analyzer').KubernetesManifestAnalyzer)(), true),
    },
    {
      id: 'ansible',
      name: 'Ansible Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['**/playbook*.yml', '**/playbook*.yaml', '**/site.yml', '**/site.yaml', '**/roles/*/tasks/*.yml', '**/roles/*/tasks/*.yaml', '**/ansible.cfg'],
        content: [/^\s*-\s*hosts:\s*/m],
      },
      ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/languages/iac-analyzer').AnsibleAnalyzer)(), true),
    },
    {
      id: 'pulumi',
      name: 'Pulumi Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['**/Pulumi.yaml', '**/Pulumi.yml'],
        content: [/^runtime:\s*(nodejs|python|go|dotnet)/m],
      },
      ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/languages/iac-analyzer').PulumiAnalyzer)(), true),
    },
    {
      id: 'helm',
      name: 'Helm Chart Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['**/Chart.yaml', '**/Chart.yml'],
        content: [/^apiVersion:\s*v[12]\s*$/m],
      },
      ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/languages/iac-analyzer').HelmAnalyzer)(), true),
    },
    {
      id: 'caddy',
      name: 'Caddy Reverse Proxy Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['Caddyfile', '**/Caddyfile', '*.Caddyfile', '**/*.Caddyfile'],
        content: [/^\s*reverse_proxy\s+/m, /^\s*file_server\b/m, /^\s*handle(_path)?\s+/m],
      },
      ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/languages/reverse-proxy-analyzer').CaddyAnalyzer)(), true),
    },
    {
      id: 'nginx',
      name: 'Nginx Reverse Proxy Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['nginx.conf', '**/nginx.conf', '**/sites-available/*', '**/sites-enabled/*', '**/conf.d/*.conf'],
        content: [/^\s*(server|upstream|location)\b[^;]*\{/m, /\bproxy_pass\s+/m],
      },
      ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/languages/reverse-proxy-analyzer').NginxAnalyzer)(), true),
    },
    {
      id: 'apache-httpd',
      name: 'Apache HTTP Server Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['httpd.conf', 'apache2.conf', '**/httpd.conf', '**/apache2.conf', '**/sites-available/*.conf', '**/.htaccess'],
        content: [/<VirtualHost\b/i, /^\s*ProxyPass\b/im, /^\s*RewriteRule\b/im],
      },
      ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/languages/reverse-proxy-analyzer').ApacheAnalyzer)(), true),
    },
    {
      id: 'haproxy',
      name: 'HAProxy Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['haproxy.cfg', '**/haproxy.cfg', '**/haproxy/*.cfg'],
        content: [/^\s*(frontend|backend|listen)\s+/m, /^\s*(use_backend|default_backend)\s+/m],
      },
      ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/languages/reverse-proxy-analyzer').HAProxyAnalyzer)(), true),
    },
    {
      id: 'traefik',
      name: 'Traefik Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['traefik.yml', 'traefik.yaml', '**/traefik.yml', '**/traefik.yaml', '**/traefik/*.yml', '**/traefik/*.yaml', '**/dynamic/*.yml', '**/dynamic/*.yaml'],
        content: [/\brouters:\s*$/m, /\bloadBalancer:\s*$/m, /\brule:\s*.*(Host|PathPrefix)\(/m],
      },
      ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/languages/reverse-proxy-analyzer').TraefikAnalyzer)(), true),
    },
    {
      id: 'distribution-artifacts',
      name: 'Distribution Artifact Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['*.sh', '*.bash', '*.zsh', '*.ps1', '*.psm1', '*.bat', '*.cmd', '*.nsi', '*.wxs', '*.desktop', '*.service'],
        content: [/systemctl|launchctl|makensis|msiexec|pkgbuild|create-dmg|SERVICE_NAME|BINARY_NAME|DOWNLOAD_PREFIX|manifest\.json/i],
      },
      ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/languages/distribution-artifact-analyzer').DistributionArtifactAnalyzer)(), true),
    },
    {
      id: 'cli-frameworks',
      name: 'CLI/Script Entry Point Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        files: ['**/*.py', '**/*.ts', '**/*.js', '**/*.go', '**/*.rs', '**/*.rb'],
        content: [
          /@click\.(command|group)\b/, /argparse\.ArgumentParser\s*\(/, /\btyper\.Typer\s*\(/,
          /require\(\s*['"]commander['"]\s*\)|from\s+['"]commander['"]/,
          /require\(\s*['"]yargs['"]\s*\)|from\s+['"]yargs['"]/,
          /from\s+['"]@oclif\/core['"]/,
          /cobra\.Command\b/, /["']github\.com\/urfave\/cli(\/v2)?["']/,
          /\bclap::/,
          /class\s+\w+\s*<\s*Thor\b/,
        ],
      },
      consumesExistingAnalysis: false, ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/languages/cli-analyzer').CliAnalyzer)(), true),
    },
    {
      id: 'generic-tree-sitter',
      name: 'Generic Tree-sitter Analyzer',
      type: 'language',
      version: '1.0.0',
      detectPatterns: {
        content: [/\.(zig|hs|lua|ml|erl|ex|exs|clj|jl|nim|f90|ada|d|cr|nix)$/i],
      },
      consumesExistingAnalysis: false,
      ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/languages/generic-tree-sitter-language-analyzer').GenericTreeSitterLanguageAnalyzer)(), false),
    },
  ];

  const frameworkRegistrations: AnalyzerRegistration[] = [
    { id: 'nestjs', name: 'NestJS Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['@nestjs/core', '@nestjs/common'] }, requires: ['typescript-javascript'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/web/nestjs-analyzer').NestJSAnalyzer)(), false) },
    { id: 'spring-boot', name: 'Spring Boot Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['spring-boot-starter', 'org.springframework.boot'], files: ['pom.xml', 'build.gradle'] }, requires: ['java'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/web/spring-boot-analyzer').SpringBootAnalyzer)(), false) },
    { id: 'spring-cloud-gateway', name: 'Spring Cloud Gateway Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['spring-cloud-starter-gateway', 'spring-cloud-gateway', 'org.springframework.cloud.gateway'], files: ['**/src/main/resources/application*.yml', '**/src/main/resources/application*.yaml', '**/src/main/resources/bootstrap*.yml', '**/src/main/resources/bootstrap*.yaml'], content: [/spring:\s*[\s\S]*?cloud:\s*[\s\S]*?gateway:/, /\buri:\s*(?:lb:)?\/\//] }, ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/web/spring-cloud-gateway-analyzer').SpringCloudGatewayAnalyzer)(), false) },
    { id: 'django', name: 'Django Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['Django', 'django'], files: ['manage.py', 'requirements.txt'] }, requires: ['python'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/web/django-analyzer').DjangoAnalyzer)(), false, true) },
    { id: 'flask', name: 'Flask Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['Flask', 'flask'], files: ['requirements.txt'] }, requires: ['python'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/web/flask-analyzer').FlaskAnalyzer)(), true) },
    { id: 'fastapi', name: 'FastAPI Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['fastapi', 'FastAPI'], files: ['requirements.txt'] }, requires: ['python'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/web/fastapi-analyzer').FastAPIAnalyzer)(), true) },
    { id: 'aiohttp', name: 'aiohttp Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['aiohttp'], files: ['requirements.txt'], content: [/\bfrom\s+aiohttp\b/, /\bimport\s+aiohttp\b/] }, requires: ['python'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/web/aiohttp-analyzer').AiohttpAnalyzer)(), true) },
    { id: 'sanic', name: 'Sanic Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['sanic'], files: ['requirements.txt'], content: [/\bfrom\s+sanic\b/, /\bimport\s+sanic\b/, /\bSanic\s*\(/] }, requires: ['python'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/web/sanic-analyzer').SanicAnalyzer)(), true) },
    { id: 'tornado', name: 'Tornado Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['tornado'], files: ['requirements.txt'], content: [/\bfrom\s+tornado\b/, /\bimport\s+tornado\b/, /tornado\.web/] }, requires: ['python'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/web/tornado-analyzer').TornadoAnalyzer)(), true) },
    { id: 'starlette', name: 'Starlette Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['starlette'], files: ['requirements.txt'], content: [/\bfrom\s+starlette\b/, /\bimport\s+starlette\b/] }, requires: ['python'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/web/starlette-analyzer').StarletteAnalyzer)(), true) },
    { id: 'laravel', name: 'Laravel Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['artisan', 'composer.json'], dependencies: ['laravel/framework'] }, requires: ['php'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/web/laravel-analyzer').LaravelAnalyzer)(), false) },
    { id: 'symfony', name: 'Symfony Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['bin/console', 'composer.json'], dependencies: ['symfony/framework-bundle'] }, requires: ['php'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/web/symfony-analyzer').SymfonyAnalyzer)(), false) },
    { id: 'rails', name: 'Rails Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['Gemfile', 'config/routes.rb'], dependencies: ['rails'] }, requires: ['ruby'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/web/rails-analyzer').RailsAnalyzer)(), false, true) },
    { id: 'express', name: 'Express.js Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['express'], files: ['package.json'] }, requires: ['typescript-javascript'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/web/express-analyzer').ExpressAnalyzer)(), false) },
    { id: 'fastify', name: 'Fastify Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['fastify', '@fastify/cors', '@fastify/jwt', '@fastify/cookie', '@fastify/multipart', '@fastify/swagger', '@fastify/type-provider-typebox'], files: ['package.json'] }, requires: ['typescript-javascript'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/web/fastify-analyzer').FastifyAnalyzer)(), false) },
    { id: 'node-http', name: 'Node.js Raw HTTP Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['**/*.{js,ts,mjs,cjs}'], content: [/\b(?:http|https)\.createServer\s*\(/, /(?<![.\w])createServer\s*\(/] }, requires: ['typescript-javascript'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/web/node-http-analyzer').NodeHttpAnalyzer)(), false) },
    { id: 'react', name: 'React Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['react', 'react-dom'], files: ['package.json'], content: [/\.jsx$/, /\.tsx$/] }, requires: ['typescript-javascript'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/web/react-analyzer').ReactAnalyzer)(), true) },
    { id: 'angular', name: 'Angular Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['@angular/core', '@angular/common'], files: ['angular.json', 'package.json'], content: [/\.component\.ts$/] }, requires: ['typescript-javascript'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/web/angular-analyzer').AngularAnalyzer)(), false) },
    { id: 'angularjs', name: 'AngularJS Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['angular'], files: ['package.json', 'bower.json'], content: [/\bangular\.module\s*\(/] }, requires: ['typescript-javascript'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/web/angularjs-analyzer').AngularJsAnalyzer)(), false) },
    { id: 'vue', name: 'Vue.js Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['vue', 'vue@'], files: ['package.json'], content: [/\.vue$/] }, requires: ['typescript-javascript'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/web/vue-analyzer').VueAnalyzer)(), false) },
    { id: 'jest', name: 'Jest Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['jest', '@jest/core'], files: ['jest.config.js', 'jest.config.ts'], content: [/\.test\.(js|ts|jsx|tsx)$/, /\.spec\.(js|ts|jsx|tsx)$/] }, requires: ['typescript-javascript'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/testing').JestAnalyzer)(), false) },
    { id: 'cypress', name: 'Cypress Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['cypress'], files: ['cypress.json', 'cypress.config.js', 'cypress.config.ts'], content: [/\.cy\.(js|ts|jsx|tsx)$/] }, requires: ['typescript-javascript'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/testing').CypressAnalyzer)(), false) },
    { id: 'test-framework', name: 'Cross-Language Test Framework Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['vitest', 'mocha', 'jasmine', '@playwright/test', 'selenium-webdriver'], files: TEST_FRAMEWORK_DETECTION_FILES, content: [/from\s+['"`]vitest['"`]/, /from\s+['"`]@playwright\/test['"`]/, /import\s+pytest/, /testing\.T\b/, /#\[(?:tokio::)?test\]/, /@Test\b/, /RSpec\.describe/, /PHPUnit\\Framework\\TestCase/] }, ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/testing').TestFrameworkAnalyzer)(), false) },
    { id: 'ci-pipeline', name: 'CI/CD Pipeline Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['.github/workflows/*.yml', '.github/workflows/*.yaml', '.gitlab-ci.yml', '.circleci/config.yml', 'Jenkinsfile', 'azure-pipelines.yml', 'azure-pipelines.yaml', '.travis.yml', '.drone.yml', '.drone.yaml', '.buildkite/pipeline.yml', '.buildkite/pipeline.yaml', 'bitbucket-pipelines.yml', 'bitbucket-pipelines.yaml', '.teamcity/**/*.kt', '.teamcity/**/*.kts'] }, ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/ci').CiPipelineAnalyzer)(), false) },
    { id: 'airflow', name: 'Apache Airflow Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['apache-airflow'], files: ['requirements.txt', '**/dags/**/*.py'], content: [/from\s+airflow\b/, /import\s+airflow\b/, /@dag\b/, /@task\b/] }, requires: ['python'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/dataml/airflow-analyzer').AirflowAnalyzer)(), false) },
    { id: 'dagster', name: 'Dagster Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['dagster'], files: ['requirements.txt'], content: [/from\s+dagster\b/, /import\s+dagster\b/, /@asset\b/, /@op\b/] }, requires: ['python'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/dataml/dagster-analyzer').DagsterAnalyzer)(), false) },
    { id: 'prefect', name: 'Prefect Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['prefect'], files: ['requirements.txt'], content: [/from\s+prefect\b/, /import\s+prefect\b/, /@flow\b/, /@task\b/] }, requires: ['python'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/dataml/prefect-analyzer').PrefectAnalyzer)(), false) },
    { id: 'luigi', name: 'Luigi Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['luigi'], files: ['requirements.txt'], content: [/import\s+luigi\b/, /luigi\.Task\b/] }, requires: ['python'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/dataml/luigi-analyzer').LuigiAnalyzer)(), false) },
    { id: 'jupyter-notebook', name: 'Jupyter Notebook Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['**/*.ipynb'] }, ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/dataml/jupyter-notebook-analyzer').JupyterNotebookAnalyzer)(), true) },
    { id: 'ml-training', name: 'ML Training Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['torch', 'tensorflow', 'keras'], files: ['requirements.txt', 'pyproject.toml'], content: [/import\s+torch\b/, /from\s+torch\b/, /import\s+tensorflow\b/, /\.fit\s*\(/] }, requires: ['python'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/dataml/ml-training-analyzer').MLTrainingAnalyzer)(), false) },
    { id: 'wpf', name: 'WPF Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['**/*.xaml', '**/*.csproj'], content: [/PresentationFramework/, /System\.Windows/, /<UseWPF>true<\/UseWPF>/] }, requires: ['csharp'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/dotnet').WPFAnalyzer)(), false) },
    { id: 'electron', name: 'Electron Desktop Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['electron'], files: ['package.json'], content: [/\bipcMain\.(handle|on)\s*\(/, /\bipcRenderer\.(invoke|send)\s*\(/, /\bcontextBridge\.exposeInMainWorld\s*\(/, /new\s+BrowserWindow\s*\(/] }, requires: ['typescript-javascript'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/desktop').ElectronAnalyzer)(), false) },
    { id: 'tauri', name: 'Tauri Desktop Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['@tauri-apps/api', '@tauri-apps/cli'], files: ['src-tauri/Cargo.toml', 'Cargo.toml'], content: [/#\[tauri::command\]/, /tauri::generate_handler!/, /\binvoke\s*\(\s*['"`]/] }, ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/desktop').TauriAnalyzer)(), false) },
    { id: 'aspnet-core', name: 'ASP.NET Core Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['**/*.csproj'], content: [/Microsoft\.AspNetCore/, /Microsoft\.NET\.Sdk\.Web/] }, requires: ['csharp'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/dotnet').AspNetCoreAnalyzer)(), false) },
    { id: 'nextjs', name: 'Next.js Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['next'], files: ['next.config.js', 'next.config.mjs', 'next.config.ts'] }, requires: ['typescript-javascript'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/web/nextjs-analyzer').NextJSAnalyzer)(), false) },
    { id: 'actix-web', name: 'Actix-web Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['actix-web', 'actix_web'], files: ['Cargo.toml'], content: [/actix_web::/, /#\[(get|post|put|delete|patch)\("/, /HttpServer::/] }, requires: ['rust'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/rust').ActixAnalyzer)(), false) },
    { id: 'rocket', name: 'Rocket Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['rocket', 'rocket_dyn_templates', 'rocket_sync'], files: ['Cargo.toml'], content: [/rocket::/, /#\[(get|post|put|delete|patch)\("/, /rocket::build/] }, requires: ['rust'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/rust').RocketAnalyzer)(), false) },
    { id: 'axum', name: 'Axum Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['axum'], files: ['Cargo.toml'], content: [/axum::/, /Router::new\s*\(/, /\.route\s*\(\s*"/] }, requires: ['rust'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/rust').AxumAnalyzer)(), false) },
    { id: 'warp', name: 'Warp Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['warp'], files: ['Cargo.toml'], content: [/warp::path\s*[!(]/, /\.and\s*\(\s*warp::(get|post|put|patch|delete)/] }, requires: ['rust'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/rust/warp-analyzer').WarpAnalyzer)(), false) },
    { id: 'tonic', name: 'Tonic gRPC Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['tonic'], files: ['Cargo.toml'], content: [/tonic::async_trait/, /tonic::(Request|Response)/] }, requires: ['rust'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/rust/tonic-analyzer').TonicAnalyzer)(), false) },
    { id: 'drogon', name: 'Drogon Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['CMakeLists.txt', '**/*.cpp', '**/*.h'], content: [/#include\s*[<"]drogon\//, /ADD_METHOD_TO\s*\(/, /app\s*\(\s*\)\s*\.\s*registerHandler\s*\(/] }, requires: ['c-cpp'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/cpp/drogon-analyzer').DrogonAnalyzer)(), false) },
    { id: 'crow', name: 'Crow Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['CMakeLists.txt', '**/*.cpp', '**/*.h'], content: [/#include\s*[<"]crow(?:\.h|\/[^">]*)?[>"]/, /CROW_ROUTE\s*\(/] }, requires: ['c-cpp'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/cpp/crow-analyzer').CrowAnalyzer)(), false) },
    { id: 'vapor', name: 'Vapor Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['vapor'], files: ['Package.swift', '**/*.swift'], content: [/import\s+Vapor/, /\.grouped\s*\(/, /\.(get|post|put|delete|patch)\s*\(/] }, requires: ['swift'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/swift').VaporAnalyzer)(), false) },
    { id: 'swift-platform', name: 'Swift Platform Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['Package.swift', '**/*.swift'], content: [/import\s+SwiftUI/, /import\s+AppKit/, /import\s+UIKit/, /platforms\s*:\s*\[/] }, requires: ['swift'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/swift').SwiftPlatformAnalyzer)(), false) },
    { id: 'mojolicious', name: 'Mojolicious Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['Mojolicious'], files: ['cpanfile', 'Makefile.PL', '**/*.pl', '**/*.pm'], content: [/use\s+Mojolicious/, /^\s*(get|post|put|patch|del|options|any)\s+['"]/m, /->(get|post|put|patch|del|options|any|under)\s*\(/] }, requires: ['perl'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/perl').MojoliciousAnalyzer)(), false) },
    { id: 'gorouter', name: 'GoRouter Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['go_router'], files: ['pubspec.yaml', '**/*.dart'], content: [/GoRouter\s*\(/, /GoRoute\s*\(/, /package:go_router/] }, requires: ['dart'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/dart').GoRouterAnalyzer)(), false) },
    { id: 'shelf', name: 'Shelf/shelf_router Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['shelf', 'shelf_router'], files: ['pubspec.yaml', '**/*.dart'], content: [/package:shelf_router\//, /package:shelf\//, /Router\s*\(\s*\)/] }, requires: ['dart'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/dart').ShelfAnalyzer)(), false) },
    { id: 'http4s', name: 'http4s Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['http4s', 'http4s-dsl'], files: ['build.sbt', '**/*.scala'], content: [/org\.http4s/, /HttpRoutes\.of/, /AuthedRoutes\.of/] }, requires: ['scala'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/scala').Http4sAnalyzer)(), false) },
    { id: 'play', name: 'Play Framework Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['com.typesafe.play'], files: ['conf/routes', 'conf/*.routes', 'build.sbt'], content: [/^\s*(GET|POST|PUT|DELETE|PATCH)\s+\/\S*\s+[\w.]+\.\w+\(/m] }, requires: ['scala'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/scala').PlayAnalyzer)(), false) },
    { id: 'akka-http', name: 'Akka HTTP / Pekko HTTP Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['akka-http', 'pekko-http'], files: ['build.sbt', '**/*.scala'], content: [/import\s+akka\.http/, /import\s+org\.apache\.pekko\.http/, /\bpathPrefix\s*\(/] }, requires: ['scala'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/scala').AkkaHttpAnalyzer)(), true) },
    { id: 'kemal', name: 'Kemal Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['kemal'], files: ['shard.yml', '**/*.cr'], content: [/require\s+"kemal"/, /^\s*(get|post|put|patch|delete|options|head|ws)\s+"/m] }, requires: ['crystal'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/crystal').KemalAnalyzer)(), false) },
    { id: 'genie', name: 'Genie Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['Genie'], files: ['Project.toml', '**/*.jl'], content: [/Genie/, /\broute\s*\(/, /@(get|post|put|patch|delete)\s*\(/] }, requires: ['julia'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/julia').GenieAnalyzer)(), false) },
    { id: 'compojure', name: 'Compojure Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['compojure'], files: ['deps.edn', 'project.clj', '**/*.clj', '**/*.cljs', '**/*.cljc'], content: [/compojure\.core/, /\(defroutes\b/, /\(context\b/, /\((?:GET|POST|PUT|DELETE|PATCH|ANY)\s+"/] }, requires: ['clojure'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/clojure').CompojureAnalyzer)(), false) },
    { id: 'reitit', name: 'Reitit/Ring Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['reitit', 'ring/ring-core', 'ring/ring-jetty-adapter'], files: ['deps.edn', 'project.clj', '**/*.clj', '**/*.cljs', '**/*.cljc'], content: [/reitit\.(ring|core)/, /ring\.adapter/, /\(:handler\b/] }, requires: ['clojure'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/clojure').ReititAnalyzer)(), false) },
    { id: 'sinatra', name: 'Sinatra Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['sinatra'], files: ['Gemfile', '**/*.rb'], content: [/require\s+['"]sinatra['"]/, /class\s+\w+\s*<\s*Sinatra::Base/] }, requires: ['ruby'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/web/sinatra-analyzer').SinatraAnalyzer)(), false) },
    { id: 'slim', name: 'Slim/CodeIgniter Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['slim/slim', 'codeigniter4/framework', 'codeigniter/framework'], files: ['composer.json', '**/*.php'], content: [/AppFactory::create\(\)/, /new\s+\\?Slim\\App\(/, /\$routes->(get|post|put|patch|delete)\s*\(/] }, requires: ['php'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/web/slim-analyzer').SlimAnalyzer)(), false) },
    { id: 'dream', name: 'Dream Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['dream'], files: ['dune-project', 'dune', '**/*.ml'], content: [/Dream\.router/, /Dream\.(get|post|put|patch|delete|options|head)\s+"/, /Dream\.scope/] }, requires: ['ocaml'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/ocaml').DreamAnalyzer)(), false) },
    { id: 'apexrest', name: 'Apex REST Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: [], files: ['sfdx-project.json', '**/*.cls'], content: [/@RestResource\b/, /@Http(Get|Post|Put|Patch|Delete)\b/] }, requires: ['apex'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/apex').ApexRestAnalyzer)(), false) },
    { id: 'svelte', name: 'Svelte/SvelteKit Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['svelte', '@sveltejs/kit'], content: [/\.svelte$/] }, requires: ['typescript-javascript'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/web/svelte-analyzer').SvelteAnalyzer)(), false) },
    { id: 'astro', name: 'Astro Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['astro'], files: ['astro.config.mjs', 'astro.config.ts'], content: [/\.astro$/] }, requires: ['typescript-javascript'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/javascript/astro-analyzer').AstroAnalyzer)(), false) },
    { id: 'hono', name: 'Hono Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['hono'] }, requires: ['typescript-javascript'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/javascript/hono-analyzer').HonoAnalyzer)(), false) },
    { id: 'anchor', name: 'Anchor (Solana) Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['anchor-lang'], files: ['Anchor.toml'], content: [/#\[program\]/, /use anchor_lang/] }, requires: ['rust'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/rust/anchor-analyzer').AnchorAnalyzer)(), false) },
    { id: 'phoenix', name: 'Phoenix Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['phoenix'], files: ['mix.exs'], content: [/use Phoenix\.Router/, /use Phoenix\.LiveView/] }, requires: ['elixir'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/elixir/phoenix-analyzer').PhoenixAnalyzer)(), false) },
    { id: 'nuxt', name: 'Nuxt Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['nuxt'], files: ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs'] }, requires: ['typescript-javascript'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/web/nuxt-analyzer').NuxtAnalyzer)(), true) },
    { id: 'remix', name: 'Remix Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['@remix-run/react', '@remix-run/node'], files: ['remix.config.js'] }, requires: ['typescript-javascript'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/web/remix-analyzer').RemixAnalyzer)(), true) },
    { id: 'react-native', name: 'React Native / Expo Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['react-native', 'expo'], files: ['app.json', 'app.config.js', 'app.config.ts'] }, requires: ['typescript-javascript'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/web/react-native-analyzer').ReactNativeAnalyzer)(), true) },
    { id: 'ktor', name: 'Ktor Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['io.ktor', 'ktor-server-core'], files: ['build.gradle.kts', 'build.gradle'], content: [/io\.ktor/, /routing\s*\{/, /embeddedServer\(/] }, requires: ['kotlin'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/kotlin/ktor-analyzer').KtorAnalyzer)(), true) },
    { id: 'jetpack-compose', name: 'Jetpack Compose Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['androidx.compose', 'androidx.compose.runtime', 'compose.runtime'], files: ['build.gradle.kts', 'build.gradle'], content: [/@Composable/, /androidx\.compose/] }, requires: ['kotlin'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/kotlin/compose-analyzer').ComposeAnalyzer)(), false) },
    { id: 'solidity-security', name: 'Solidity Security Facts Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['@openzeppelin/contracts', 'openzeppelin-solidity'], files: ['foundry.toml', 'hardhat.config.js', 'hardhat.config.ts', 'truffle-config.js'], content: [/onlyOwner/, /nonReentrant/] }, requires: ['solidity'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/solidity/security-analyzer').SoliditySecurityAnalyzer)(), false) },
    { id: 'wordpress', name: 'WordPress Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['wp-config.php', 'style.css'], content: [/add_action\s*\(/, /add_filter\s*\(/, /register_post_type\s*\(/, /Plugin Name:/, /Theme Name:/] }, requires: ['php'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/php/wordpress-analyzer').WordPressAnalyzer)(), true) },
    { id: 'blazor', name: 'Blazor Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['**/*.razor'], content: [/Microsoft\.AspNetCore\.Components/, /@page\s/, /@code\b/] }, requires: ['csharp'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/dotnet/blazor-analyzer').BlazorAnalyzer)(), true) },
    { id: 'quarkus', name: 'Quarkus Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['io.quarkus'], files: ['pom.xml', 'build.gradle'], content: [/quarkus\./, /jakarta\.ws\.rs/, /javax\.ws\.rs/] }, requires: ['java'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/java/quarkus-analyzer').QuarkusAnalyzer)(), true) },
    { id: 'micronaut', name: 'Micronaut Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['io.micronaut'], files: ['pom.xml', 'build.gradle'], content: [/io\.micronaut/, /@Controller/] }, requires: ['java'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/java/micronaut-analyzer').MicronautAnalyzer)(), true) },
    { id: 'jaxrs', name: 'JAX-RS / Jersey Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['jersey-server', 'jersey-core', 'jakarta.ws.rs-api', 'javax.ws.rs-api', 'resteasy'], files: ['pom.xml', 'build.gradle'], content: [/import\s+(?:jakarta|javax)\.ws\.rs/, /@Path\s*\(/] }, requires: ['java'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/java/jaxrs-analyzer').JaxRsAnalyzer)(), true) },
    { id: 'vertx', name: 'Vert.x Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['io.vertx', 'vertx-web', 'vertx-core'], files: ['pom.xml', 'build.gradle', 'build.gradle.kts'], content: [/import\s+io\.vertx/, /Router\.router\s*\(/] }, requires: ['java'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/java/vertx-analyzer').VertxAnalyzer)(), true) },
    { id: 'solidstart', name: 'SolidStart Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['solid-start', '@solidjs/start'] }, requires: ['typescript-javascript'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/web/solidstart-analyzer').SolidStartAnalyzer)(), true) },
    { id: 'qwik', name: 'Qwik Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['@builder.io/qwik', '@builder.io/qwik-city'] }, requires: ['typescript-javascript'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/web/qwik-analyzer').QwikAnalyzer)(), true) },
    { id: 'gin', name: 'Gin Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['github.com/gin-gonic/gin'], files: ['go.mod'], content: [/"github\.com\/gin-gonic\/gin"/, /gin\.(Default|New)\s*\(/, /\.(GET|POST|PUT|PATCH|DELETE)\s*\(\s*"/] }, requires: ['go'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/go').GinAnalyzer)(), false) },
    { id: 'echo', name: 'Echo Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['github.com/labstack/echo'], files: ['go.mod'], content: [/"github\.com\/labstack\/echo(\/v4)?"/, /echo\.New\s*\(/] }, requires: ['go'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/go').EchoAnalyzer)(), false) },
    { id: 'fiber', name: 'Fiber Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['github.com/gofiber/fiber'], files: ['go.mod'], content: [/"github\.com\/gofiber\/fiber\/v?\d*"/, /fiber\.New\s*\(/] }, requires: ['go'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/go').FiberAnalyzer)(), false) },
    { id: 'chi', name: 'Chi Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { dependencies: ['github.com/go-chi/chi'], files: ['go.mod'], content: [/"github\.com\/go-chi\/chi(\/v\d+)?"/, /chi\.NewRouter\s*\(/] }, requires: ['go'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/go').ChiAnalyzer)(), false) },
    { id: 'unity', name: 'Unity Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['ProjectSettings/ProjectVersion.txt', '**/*.unity', '**/*.meta', '**/*.cs'], content: [/^\s*using\s+UnityEngine\s*;/m] }, requires: ['csharp'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/game').UnityAnalyzer)(), false) },
    { id: 'unreal', name: 'Unreal Engine Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['**/*.uproject', '**/*.cpp', '**/*.h'], content: [/GENERATED_BODY\s*\(\s*\)/, /#include\s*"CoreMinimal\.h"/] }, requires: ['c-cpp'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/game').UnrealAnalyzer)(), false) },
    { id: 'godot', name: 'Godot Engine Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['project.godot', '**/*.tscn', '**/*.gd'], content: [/\bfunc\s+_ready\s*\(/, /\bfunc\s+_process\s*\(/] }, ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/game').GodotAnalyzer)(), false) },
    { id: 'embedded-c', name: 'Embedded C Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['**/*.c', '**/*.h', '**/*.ld'], content: [/#include\s*[<"]avr\/(io|interrupt)\.h[>"]/, /\bISR\s*\(/, /__attribute__\s*\(\s*\(\s*interrupt/] }, requires: ['c-cpp'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/embedded').EmbeddedCAnalyzer)(), false) },
    { id: 'arduino', name: 'Arduino Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['**/*.ino', '**/*.cpp', '**/*.h'], content: [/#include\s*[<"]Arduino\.h[>"]/, /\bvoid\s+setup\s*\(/, /\bvoid\s+loop\s*\(/] }, ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/embedded').ArduinoAnalyzer)(), false) },
    { id: 'linux-kernel-module', name: 'Linux Kernel Module Analyzer', type: 'framework', version: '1.0.0', detectPatterns: { files: ['**/*.c', 'Kbuild', 'Makefile'], content: [/#include\s*[<"]linux\/module\.h[>"]/, /\bmodule_init\s*\(/, /\bmodule_exit\s*\(/] }, requires: ['c-cpp'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/frameworks/embedded').LinuxKernelModuleAnalyzer)(), false) },
  ];

  const libraryRegistrations: AnalyzerRegistration[] = [
    { id: 'prisma', name: 'Prisma ORM Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['prisma', '@prisma/client'], files: ['prisma/schema.prisma'] }, requires: ['typescript-javascript'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/libraries/orm/prisma-analyzer').PrismaAnalyzer)(), false) },
    { id: 'socketio', name: 'Socket.io Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['socket.io', 'socket.io-client'] }, requires: ['typescript-javascript'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/libraries/realtime/socketio-analyzer').SocketIOAnalyzer)(), false) },
    { id: 'react-router', name: 'React Router Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['react-router-dom', 'react-router'] }, requires: ['typescript-javascript'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/libraries/routing/react-router-analyzer').ReactRouterAnalyzer)(), true) },
    { id: 'redux', name: 'Redux/RTK Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['@reduxjs/toolkit', 'redux'] }, requires: ['typescript-javascript'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/libraries/state/redux-analyzer').ReduxAnalyzer)(), false) },
    { id: 'zustand', name: 'Zustand Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['zustand'] }, requires: ['typescript-javascript'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/libraries/state/zustand-analyzer').ZustandAnalyzer)(), false) },
    { id: 'tanstack-query', name: 'TanStack Query Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['@tanstack/react-query', 'react-query', '@tanstack/vue-query', '@tanstack/svelte-query'] }, requires: ['typescript-javascript'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/libraries/data-fetching/tanstack-query-analyzer').TanStackQueryAnalyzer)(), false) },
    { id: 'reactive-streams', name: 'Reactive Streams Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['rxjs'], content: [/import\s+reactor\.core\.publisher\.(Mono|Flux)/, /import\s+io\.reactivex[^;]*\.(Observable|Flowable|Single|Maybe|Completable)/, /import\s+Combine\b/] }, ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/libraries/state/reactive-streams-analyzer').ReactiveStreamsAnalyzer)(), true) },
    { id: 'frontend-state', name: 'Frontend State Management Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['mobx', 'mobx-react', 'mobx-react-lite', 'recoil', 'jotai', 'valtio', 'pinia', '@ngrx/store', '@ngrx/effects'] }, requires: ['typescript-javascript'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/libraries/state/frontend-state-analyzer').FrontendStateAnalyzer)(), true) },
    { id: 'reqwest', name: 'Reqwest HTTP Client Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['reqwest'], files: ['Cargo.toml'] }, requires: ['rust'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/libraries/http/reqwest-analyzer').ReqwestAnalyzer)(), false) },
    { id: 'outbound-http-client', name: 'Outbound HTTP Client Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['axios', 'got', 'ky', 'node-fetch', '@apollo/client', 'urql', 'requests', 'httpx', 'aiohttp', 'spring-web', 'spring-webflux', 'okhttp', 'feign-core', 'spring-cloud-starter-openfeign', 'github.com/go-resty/resty'], content: [/\bfetch\s*\(\s*['"`]https?:\/\//, /@FeignClient\b/, /\bhttp\.(Get|Post|NewRequest)/] }, ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/libraries/http/outbound-http-client-analyzer').OutboundHttpClientAnalyzer)(), false) },
    { id: 'validation-schema-contracts', name: 'Validation Schema Contract Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['zod', 'yup', 'class-validator', 'joi', '@hapi/joi', 'ajv', 'marshmallow', 'cerberus'], content: [/\bz\.object\s*\(/, /\byup\.object\b/, /\bJoi\.[a-z]+\s*\(/, /(?:from\s*|require\s*\(\s*)['"](?:joi|@hapi\/joi)['"]/, /\bnew\s+Ajv\b/, /@Is[A-Za-z]+\s*\(/, /\bfields\.[A-Za-z]+\s*\(/, /\bValidator\s*\(/] }, ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/libraries/architecture/validation-schema-analyzer').ValidationSchemaAnalyzer)(), true) },
    { id: 'trpc', name: 'tRPC API Contract Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['@trpc/server', '@trpc/client'] }, requires: ['typescript-javascript'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/libraries/trpc-analyzer').TRPCAnalyzer)(), true) },
    { id: 'graphql', name: 'GraphQL API Contract Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['graphql', '@apollo/server', 'type-graphql', 'graphql-yoga', 'nexus', 'strawberry-graphql', 'graphene', 'ariadne', 'gqlgen', 'spring-graphql', 'graphql-java'], files: ['**/*.graphql', '**/*.gql'] }, requires: ['typescript-javascript'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/libraries/graphql-analyzer').GraphQLAnalyzer)(), true) },
    { id: 'grpc-handler', name: 'gRPC Handler Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['@grpc/grpc-js', 'grpc', 'nice-grpc', '@nestjs/microservices', 'grpcio'], files: ['**/*_pb2_grpc.py'], content: [/\.addService\s*\(/, /@GrpcMethod\b/, /add_\w+Servicer_to_server/] }, ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/libraries/api').GrpcHandlerAnalyzer)(), true) },
    { id: 'drizzle', name: 'Drizzle ORM Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['drizzle-orm'] }, requires: ['typescript-javascript'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/libraries/orm/drizzle-analyzer').DrizzleAnalyzer)(), true) },
    { id: 'typeorm', name: 'TypeORM Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['typeorm'] }, requires: ['typescript-javascript'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/libraries/orm/typeorm-analyzer').TypeORMAnalyzer)(), true) },
    { id: 'mongoose', name: 'Mongoose Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['mongoose'] }, requires: ['typescript-javascript'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/libraries/orm/mongoose-analyzer').MongooseAnalyzer)(), true) },
    { id: 'sqlalchemy-pydantic', name: 'SQLAlchemy/Pydantic Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['sqlalchemy', 'pydantic', 'SQLAlchemy', 'sqlmodel'], files: ['requirements.txt', 'pyproject.toml', 'Pipfile'] }, requires: ['python'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/libraries/sqlalchemy-pydantic-analyzer').SQLAlchemyPydanticAnalyzer)(), true) },
    { id: 'sequelize', name: 'Sequelize Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['sequelize'] }, requires: ['typescript-javascript'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/libraries/orm/sequelize-analyzer').SequelizeAnalyzer)(), true) },
    { id: 'knex', name: 'Knex Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['knex'] }, requires: ['typescript-javascript'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/libraries/orm/knex-analyzer').KnexAnalyzer)(), true) },
    { id: 'objection', name: 'Objection.js Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['objection'] }, requires: ['typescript-javascript'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/libraries/orm/objection-analyzer').ObjectionAnalyzer)(), true) },
    { id: 'diesel', name: 'Diesel Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['diesel'], files: ['Cargo.toml'] }, requires: ['rust'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/libraries/orm/diesel-analyzer').DieselAnalyzer)(), true) },
    { id: 'sea-orm', name: 'SeaORM Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['sea-orm'], files: ['Cargo.toml'] }, requires: ['rust'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/libraries/orm/seaorm-analyzer').SeaOrmAnalyzer)(), true) },
    { id: 'gorm', name: 'GORM Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['gorm.io/gorm'], files: ['go.mod'] }, requires: ['go'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/libraries/orm/gorm-analyzer').GormAnalyzer)(), true) },
    { id: 'sqlx', name: 'sqlx Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['sqlx'], files: ['Cargo.toml'] }, requires: ['rust'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/libraries/orm/sqlx-analyzer').SqlxAnalyzer)(), true) },
    { id: 'ent', name: 'ent Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['entgo.io/ent'], files: ['go.mod'] }, requires: ['go'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/libraries/orm/ent-analyzer').EntAnalyzer)(), true) },
    { id: 'dapper', name: 'Dapper Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['Dapper'] }, requires: ['csharp'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/libraries/orm/dapper-analyzer').DapperAnalyzer)(), true) },
    { id: 'doctrine', name: 'Doctrine ORM Analyzer', type: 'library', version: '1.0.0', detectPatterns: { files: ['composer.json'], dependencies: ['doctrine/orm', 'doctrine/doctrine-bundle', 'doctrine/persistence', 'doctrine/annotations'], content: [/ORM\\Entity\b/, /@ORM\\Entity\b/] }, requires: ['php'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/libraries/orm/doctrine-analyzer').DoctrineAnalyzer)(), true) },
    { id: 'ai-stack', name: 'AI/LLM Stack Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['langchain', '@langchain/core', 'llamaindex', 'ai', '@ai-sdk/openai', 'openai', '@anthropic-ai/sdk', '@modelcontextprotocol/sdk', 'langgraph', 'crewai', '@pinecone-database/pinecone', 'weaviate-ts-client', 'chromadb', 'qdrant'] }, requires: ['typescript-javascript'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/libraries/ai-stack-analyzer').AIStackAnalyzer)(), true) },
    { id: 'workflow', name: 'Workflow/Queue Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['@temporalio/client', '@temporalio/worker', 'celery', 'sidekiq', 'bullmq', 'bull', 'kafkajs', 'amqplib', 'nats', 'kafka-python', 'confluent-kafka', 'kafka-go', 'nats.go', 'rdkafka', 'async-nats', 'spring-kafka', 'Confluent.Kafka'] }, requires: ['typescript-javascript'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/libraries/workflow-analyzer').WorkflowAnalyzer)(), true) },
    { id: 'async-messaging', name: 'Async Messaging Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['kafkajs', 'node-rdkafka', 'amqplib', 'amqp-connection-manager', '@nestjs/microservices', 'nats', 'ioredis', 'redis', 'bullmq', 'bee-queue', '@aws-sdk/client-sqs', '@aws-sdk/client-sns', 'confluent-kafka', 'kafka-python', 'pika', 'celery', 'spring-kafka', 'spring-rabbit', 'sidekiq', 'github.com/segmentio/kafka-go', 'github.com/nats-io/nats.go'], content: [/producer\.send\s*\(\s*\{[\s\S]{0,200}?topic\s*:/, /\.sendToQueue\s*\(/, /\.publish\s*\(\s*['"`][^'"`]+['"`]/, /@KafkaListener|@RabbitListener/, /@MessagePattern|@EventPattern/, /Sidekiq::Worker/] }, ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/libraries/messaging').MessagingAnalyzer)(), true) },
    { id: 'observability-instrumentation', name: 'Observability Instrumentation Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['@opentelemetry/api', '@opentelemetry/sdk-node', '@sentry/node', '@sentry/nextjs', '@sentry/browser', 'dd-trace', '@datadog/browser-logs', '@datadog/browser-rum', '@datadog/mobile-react-native', 'rollbar', '@bugsnag/js', '@bugsnag/node', 'prom-client', 'hot-shots', 'node-statsd', 'winston', 'pino', 'bunyan', 'sentry-sdk', 'structlog', 'opentelemetry-api', 'opentelemetry-sdk', 'io.opentelemetry', 'io.micrometer', 'micrometer-core', 'org.slf4j', 'log4j', 'logback-classic', 'go.uber.org/zap', 'github.com/rs/zerolog'], content: [/trace\.getTracer|startSpan\s*\(|@WithSpan/, /Sentry\.captureException|capture_exception\s*\(/, /new\s+(?:Counter|Gauge|Histogram)\s*\(/, /createLogger\s*\(|pino\s*\(|structlog\.get_logger|LoggerFactory\.getLogger/, /datadogRum\.init|datadogLogs\.init|DdSdkReactNative/] }, ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/libraries/observability').ObservabilityAnalyzer)(), true) },
    { id: 'mediator-cqrs-messaging', name: 'Mediator/CQRS Messaging Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['MediatR', 'MassTransit', 'NServiceBus', '@nestjs/cqrs', 'nestjs-cqrs', '@aws-sdk/client-sqs', 'aws-lambda', 'boto3'], content: [/IRequestHandler|INotificationHandler|IMediator/, /IConsumer<|IHandleMessages</, /@CommandHandler|@QueryHandler|@EventsHandler/, /SQSEvent|event\.Records|eventSourceARN/] }, ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/libraries/mediator-cqrs-analyzer').MediatorCqrsAnalyzer)(), true) },
    { id: 'openapi', name: 'OpenAPI/Swagger Analyzer', type: 'library', version: '1.0.0', detectPatterns: { files: ['openapi.json', 'openapi.yaml', 'openapi.yml', 'swagger.json', 'swagger.yaml'], content: [/openapi\s*:/, /"openapi"\s*:/, /swagger\s*:/] }, ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/libraries/openapi-analyzer').OpenAPIAnalyzer)(), true) },
    { id: 'efcore', name: 'EF Core Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['Microsoft.EntityFrameworkCore'], content: [/:\s*DbContext/, /DbSet</] }, requires: ['csharp'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/libraries/efcore-analyzer').EFCoreAnalyzer)(), true) },
    { id: 'cron', name: 'Scheduled Job (Cron) Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['cron', 'node-cron', '@nestjs/schedule'] }, requires: ['typescript-javascript'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/libraries/cron-analyzer').CronAnalyzer)(), false) },
    { id: 'mcp-tool-registration', name: 'MCP Tool Registration Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['@modelcontextprotocol/sdk'], content: [/\.registerTool\s*\(/, /\.setRequestHandler\s*\(/] }, requires: ['typescript-javascript'], ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/libraries/mcp-tool-registration-analyzer').McpToolRegistrationAnalyzer)(), true) },
    { id: 'di-container-bindings', name: 'DI Container Binding Graph Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['inversify', 'tsyringe', 'Ninject', 'Autofac', 'Microsoft.Extensions.DependencyInjection', 'dagger', 'com.google.dagger', 'com.google.inject', 'guice', 'io.insert-koin', 'symfony/dependency-injection', 'php-di/php-di', 'dependency_injector', 'dependency-injector'] }, ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/libraries/architecture/di-container-analyzer').DiContainerBindingAnalyzer)(), true) },






    { id: 'mocking-test-double-fixtures', name: 'Mocking, Test Double and Fixture Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['sinon', 'jest', '@jest/globals', 'vitest', 'testdouble', 'responses', 'requests-mock', 'org.mockito:mockito-core', 'mockito-core', 'org.easymock:easymock', 'github.com/golang/mock', 'go.uber.org/mock', 'github.com/stretchr/testify', 'Moq', 'NSubstitute', 'rspec-mocks', 'fishery', 'factory-boy', '@faker-js/faker', 'factory_bot', 'factory_bot_rails'], content: [/\b(?:jest|vi)\.(?:mock|fn|spyOn)\s*\(/, /\bsinon\.(?:stub|spy|mock|fake)\s*\(/, /@Mock\b/, /\bNewMock[A-Z]/, /\bSubstitute\.For</, /\bMock\.Of</, /\bpatch\s*\(\s*['"]/, /\bmonkeypatch\./, /\bFactory\.define\b/, /\binstance_double\s*\(/] }, ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/libraries/testing').MockingLibraryAnalyzer)(), true) },
    { id: 'auth', name: 'Authentication and Authorization Analyzer', type: 'library', version: '1.0.0', detectPatterns: { dependencies: ['passport', '@nestjs/passport', '@nestjs/jwt', 'passport-jwt', 'next-auth', '@auth/core', '@auth0/nextjs-auth0', '@auth0/auth0-react', 'auth0', 'express-oauth2-jwt-bearer', '@clerk/nextjs', '@clerk/clerk-react', '@clerk/clerk-sdk-node', '@clerk/express', 'firebase-admin', 'firebase', 'lucia', 'jsonwebtoken', 'express-jwt', 'spring-security', 'spring-boot-starter-security', 'Django', 'djangorestframework', 'Flask-Login', 'flask-login', 'PyJWT', 'Authlib', 'authlib', 'devise', 'pundit', 'cancancan', 'casbin', 'node-casbin', '@casl/ability', 'oso'], files: ['**/*.rego'], content: [/passport\.authenticate\s*\(/, /@(PreAuthorize|Secured|RolesAllowed)\b/, /\bpermission_classes\b/, /@login_required\b/, /\bauthorize!?\b/] }, ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/libraries/auth/auth-analyzer').AuthAnalyzer)(), true) },
    ...architectureLibraryAnalyzerDefinitions().map(definition => ({
      id: definition.id,
      name: definition.name,
      type: 'library' as const,
      version: '1.0.0',
      detectPatterns: { dependencies: definition.dependencies },
      ...lazyAnalyzerRegistration(definition.createAnalyzer, true),
    })),
  ];












  const patternRegistrations: AnalyzerRegistration[] = [
    {
      id: 'analyzer-packs',
      name: 'Declarative Analyzer-Pack Engine',
      type: 'pattern',
      version: '0.1.0',
      detectPatterns: {},
      acceptsLocalPackGlobs: true,
      ...lazyAnalyzerRegistration(() => new (require('../../../packages/analyzer-core/src/analyzer/packs').PackAnalyzer)(), false),
    },
  ];

  for (const reg of [...languageRegistrations, ...frameworkRegistrations, ...libraryRegistrations, ...patternRegistrations]) {
    created.registerAnalyzer(reg);
  }

  return created;
}









export function getOrchestrator(): AnalyzerOrchestrator {
  if (process.env.KLAURO_FRESH_ORCHESTRATOR_PER_ANALYSIS === '1') {
    return createOrchestrator();
  }

  if (orchestrator) return orchestrator;

  orchestrator = createOrchestrator();
  return orchestrator;
}

















async function loadPackGlobsForAnalysis(projectPath: string): Promise<string[]> {
  try {
    const loaded = await loadKlauroConfig(projectPath);
    const packs = loaded.config.packs;
    if (!Array.isArray(packs)) return [];
    return packs.filter((glob): glob is string => typeof glob === 'string' && glob.trim().length > 0);
  } catch (error) {
    console.warn(`[Klauro] failed to load .klaurorc packs: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

async function loadConventionsForAnalysis(projectPath: string): Promise<KlauroConventions | undefined> {
  try {
    const loaded = await loadKlauroConfig(projectPath);
    const conventions = loaded.config.conventions;
    if (!conventions || Object.keys(conventions).length === 0) return undefined;
    const validation = validateConventions(conventions);
    if (validation.errors.length > 0) {
      console.warn(`[Klauro] .klaurorc conventions invalid, skipping declared conventions for this analysis: ${validation.errors.join('; ')}`);
      return undefined;
    }
    for (const warning of validation.warnings) {
      console.warn(`[Klauro] .klaurorc conventions warning: ${warning}`);
    }
    return conventions;
  } catch (error) {
    console.warn(`[Klauro] failed to load .klaurorc conventions: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

async function buildEmbeddingPhaseConfig(projectPath: string): Promise<EmbeddingPhaseConfig | null> {
  if (process.env.KLAURO_EMBEDDING_ENABLED === 'false' || process.env.KLAURO_EMBEDDING_ENABLED === '0') {
    return null;
  }

  const loaded = await loadKlauroConfig(projectPath);
  const embedding = loaded.config.embedding;
  if (!embedding.enabled) return null;

  const validation = validateEmbeddingConfig(loaded.config);
  for (const warning of validation.warnings) {
    console.warn(`[Klauro] embedding config: ${warning}`);
  }
  if (validation.errors.length > 0) {
    console.warn(`[Klauro] embedding disabled: ${validation.errors.join('; ')}`);
    return null;
  }

  try {
    const providerOptions = {
      model: embedding.model,
      dimensions: embedding.dimensions,
      maxBatch: 64,
      maxConcurrency: embedding.maxConcurrency,
      apiKeyEnv: embedding.apiKeyEnv,
    };


    const provider = createEmbeddingProvider(embedding.provider, providerOptions);

    const store = buildVectorStore(
      projectPath,
      embedding.store,
      embedding.databaseUrlEnv,
      embedding.dimensions,
    );

    return {
      provider,
      store,
      maxDocumentChars: embedding.maxDocumentChars,
      phaseBudgetMs: embedding.phaseBudgetMs,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[Klauro] embedding disabled: ${reason}`);
    return null;
  }
}

function buildVectorStore(
  projectPath: string,
  setting: 'auto' | 'file' | 'pgvector',
  databaseUrlEnv: string,
  dimensions: number,
): VectorStore {
  const fileBaseDir = getProjectStorageDir(projectPath);
  const fileStore = (): VectorStore =>
    createVectorStore({ store: 'file', fileBaseDir, expectedDimensions: dimensions });

  let resolved: VectorStoreSetting;
  if (setting === 'auto') {


    resolved = process.env[databaseUrlEnv] ? 'pgvector' : 'file';
  } else {
    resolved = setting;
  }

  if (resolved !== 'pgvector') {
    return fileStore();
  }

  const pgPool = getPgPool(resolvePgConnectionString(databaseUrlEnv));
  if (!pgPool) {
    if (setting === 'pgvector') {
      console.warn(
        '[Klauro] embedding store "pgvector" requested but no Postgres connection is available; falling back to the file store',
      );
    }
    return fileStore();
  }

  return createVectorStore({
    store: 'pgvector',
    fileBaseDir,
    pgPool,
    expectedDimensions: dimensions,
  });
}







function aiInterpretationWasUnavailable(output: CASOutput): boolean {
  const generation = output.enhanced_system_purpose?.description_generation;
  return generation?.status === 'ai_skipped' && generation.attempted === false;
}









export function preservePreviousAIDescriptions(
  previousOutput: CASOutput | null | undefined,
  output: CASOutput
): CASOutput {
  const previousPurpose = previousOutput?.enhanced_system_purpose;
  const purpose = output.enhanced_system_purpose;
  if (!previousPurpose || !purpose) return output;
  if (!aiInterpretationWasUnavailable(output)) return output;

  const previousCapabilities = new Map(
    (previousOutput?.capabilities || []).map(capability => [capability.id, capability])
  );
  for (const capability of output.capabilities || []) {
    const previous = previousCapabilities.get(capability.id);
    if (previous?.description &&
      capabilityReuseSubjectsMatch(previous, capability) &&
      validateDescription(previous.description, { kind: 'capability', name: capability.name, target: capability }, output).ok &&
      (previous.description_source === 'ai' || previous.description_source === 'manual' || previous.description_source === 'reused')) {
      capability.description = previous.description;
      capability.description_source = 'reused';
      capability.description_generation = {
        status: 'reused_previous',
        attempted: false,
        reason: previous.description_generation?.status,
        generated_at: new Date().toISOString(),
        may_be_stale: true,
      };
    }
  }

  if (!previousPurpose.inferred_description ||
    !(previousPurpose.description_source === 'ai' || previousPurpose.description_source === 'reused')) {
    return output;
  }
  if (hasLowLevelExternalServicePollution(previousPurpose.inferred_description) ||
    hasStaleNarrativePattern(previousPurpose.inferred_description, previousPurpose, output)) {
    return output;
  }
  purpose.inferred_description = previousPurpose.inferred_description;
  purpose.description_source = 'reused';
  purpose.description_generation = {
    status: 'reused_previous',
    attempted: false,
    reason: 'ai-unavailable-on-full-rebuild',
    generated_at: new Date().toISOString(),
    may_be_stale: true,
  };
  if (previousPurpose.primary_domain &&
    (previousPurpose.domain_source === 'ai' || previousPurpose.domain_source === 'reused')) {
    purpose.primary_domain = previousPurpose.primary_domain;
    purpose.domain_source = 'reused';
  }
  return output;
}

function capabilityReuseSubjectsMatch(previous: any, current: any): boolean {
  const previousName = normalizeCapabilityReuseSubject(previous?.name);
  const currentName = normalizeCapabilityReuseSubject(current?.name);
  if (!previousName || !currentName || previousName !== currentName) return false;
  const previousDomains = new Set((previous?.related_domains || []).map((domain: unknown) => normalizeCapabilityReuseSubject(domain)).filter(Boolean));
  const currentDomains = (current?.related_domains || []).map((domain: unknown) => normalizeCapabilityReuseSubject(domain)).filter(Boolean);
  if (previousDomains.size === 0 || currentDomains.length === 0) return true;
  return currentDomains.some((domain: string) => previousDomains.has(domain));
}

function normalizeCapabilityReuseSubject(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .replace(/\b(management|capability|workflow|reporting|analysis|generation|settlement|rebalancing|authentication|commands|handlers|tasks)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function hasLowLevelExternalServicePollution(description: string): boolean {
  if (/\b(?:connects to|connected to|calls out to)\b[^.]*\b(?:Self|gtk|objc_sys|[A-Z][A-Za-z0-9]*(?:Data|Decl|Item|Pool|Size))\b/.test(description)) {
    return true;
  }
  if (/\bexternal services? like\b/i.test(description)) {
    const candidates = description
      .split(/[,\s.()]+/)
      .map(token => token.trim())
      .filter(Boolean);
    if (candidates.some(candidate => isLanguageBuiltinName(candidate))) return true;
  }
  return false;
}

const PURPOSE_EVIDENCE_STOP_WORDS = new Set([
  'application', 'applications', 'capability', 'capabilities', 'management', 'manager', 'platform',
  'service', 'services', 'software', 'system', 'systems', 'tool', 'tools', 'workflow', 'workflows',
]);

function purposeEvidenceTokens(values: unknown[]): Set<string> {
  const tokens = new Set<string>();
  for (const value of values) {
    for (const token of String(value || '').toLowerCase().split(/[^a-z0-9]+/)) {
      if (token.length > 2 && !PURPOSE_EVIDENCE_STOP_WORDS.has(token)) tokens.add(token);
    }
  }
  return tokens;
}

function hasPurposeEvidenceDrift(previousPurpose: CASOutput['enhanced_system_purpose'], output: CASOutput): boolean {
  const currentPurpose = output.enhanced_system_purpose;
  if (!previousPurpose || !currentPurpose) return false;
  const previousTokens = purposeEvidenceTokens([
    previousPurpose.primary_domain,
    ...(previousPurpose.core_concepts || []),
  ]);
  const currentTokens = purposeEvidenceTokens([
    currentPurpose.primary_domain,
    ...(currentPurpose.core_concepts || []),
    ...(output.capabilities || []).flatMap(capability => [capability.name, ...(capability.related_domains || [])]),
  ]);
  if (previousTokens.size === 0 || currentTokens.size < 2) return false;
  return ![...currentTokens].some(token => previousTokens.has(token));
}

function hasStaleNarrativePattern(
  description: string,
  previousPurpose: CASOutput['enhanced_system_purpose'],
  output: CASOutput,
): boolean {
  if (/\b(?:manages|coordinates?)\s+[^.]{3,140}\s+workflows\b/i.test(description)) return true;
  if (/\bworkflows?\s+to\s+produce\s+and\s+manage\b/i.test(description)) return true;
  if (/\bmain (?:grounded |product )?concepts are\b/i.test(description)) return true;
  if (/\bservice records?\b/i.test(description)) return true;
  return hasPurposeEvidenceDrift(previousPurpose, output);
}

export async function analyzeProject(projectPath: string, displayName?: string, options: { reuseStoredContext?: boolean; persist?: boolean } = {}): Promise<CASOutput> {
    if (!(await fs.pathExists(projectPath))) {
      throw new Error(`Project path does not exist: ${projectPath}`);
    }


  const sizeHint = await estimateProjectSizeHint(projectPath);
  return withProjectAnalysisLock(projectPath, () => withAnalysisLane(async (orch) => {
    orch.configureEmbedding(await buildEmbeddingPhaseConfig(projectPath));
    const conventions = await loadConventionsForAnalysis(projectPath);
    const packGlobs = await loadPackGlobsForAnalysis(projectPath);
    const analyzed = await orch.orchestrateAnalysis(projectPath, { displayName, conventions, packGlobs });
    const result = options.reuseStoredContext === false
      ? analyzed
      : await applyStoredElementDescriptions(projectPath, preservePreviousAIDescriptions(
        await loadAnalysis(projectPath, { preferCache: true }).catch(() => null), analyzed
      ));
    result.layers_ready = buildCompletedAnalysisLayersReady(result);
    if (options.persist !== false) {
      await saveAnalysis(projectPath, result);
      await saveIncrementalState(projectPath, orch.createIncrementalBaseline(projectPath, result));
      clearFreshnessSummaryCache();
      await saveAnalysisSnapshot(projectPath, result);
    }

    return result;
  }, sizeHint, projectPath));
}









export interface DeferredAnalysisResult {
  output: CASOutput;
  enrichment: Promise<void>;
}
export async function analyzeProjectDeferred(
  projectPath: string,
  displayName?: string,
  onProgress?: (event: AnalysisProgressEvent) => void,
  options: {
    reuseStoredContext?: boolean;
    prepareStructuralCheckpoint?: (output: CASOutput) => void;
    persistEnrichmentResult?: boolean;
    deferStructuralSegments?: boolean;
  } = {},
): Promise<DeferredAnalysisResult> {
  if (!(await fs.pathExists(projectPath))) {
    throw new Error(`Project path does not exist: ${projectPath}`);
  }
  const dedicatedOrch = createOrchestrator();

  const sizeHint = await estimateProjectSizeHint(projectPath);

  const output = await withProjectAnalysisLock(projectPath, () => withLanePermit(async () => {
    dedicatedOrch.configureEmbedding(await buildEmbeddingPhaseConfig(projectPath));
    const conventions = await loadConventionsForAnalysis(projectPath);
    const packGlobs = await loadPackGlobsForAnalysis(projectPath);
    const previousOutput = options.reuseStoredContext === false
      ? null
      : await loadAnalysis(projectPath, { preferCache: true }).catch(() => null);
    const result = await applyStoredElementDescriptions(projectPath, preservePreviousAIDescriptions(
      previousOutput,
      await dedicatedOrch.orchestrateAnalysis(projectPath, { deferAiEnrichment: true, displayName, conventions, packGlobs, onProgress })
    ));

    options.prepareStructuralCheckpoint?.(result);
    if (!result.layers_ready?.layers?.length) {
      result.layers_ready = buildCompletedAnalysisLayersReady(result);
    }
    await saveAnalysis(projectPath, result, 'main', { deferSegmentedWrite: options.deferStructuralSegments });
    await saveIncrementalState(projectPath, dedicatedOrch.createIncrementalBaseline(projectPath, result));
    clearFreshnessSummaryCache();
    await saveAnalysisSnapshot(projectPath, result);

    return result;
  }, sizeHint, projectPath));


  if (output.ai_enrichment !== 'pending') {
    return { output, enrichment: Promise.resolve() };
  }







  const enrichment = withProjectAnalysisLock(projectPath, () => withAiEnrichmentLanePermit(async () => {





    const statsBefore = aiService.getCacheStats();
    await dedicatedOrch.enrichAnalysisAI(output);
    const statsAfter = aiService.getCacheStats();
    output.ai_cache_reuse = {
      hits: Math.max(0, statsAfter.hits - statsBefore.hits),
      misses: Math.max(0, statsAfter.misses - statsBefore.misses),
      bypassed: process.env.KLAURO_FORCE_AI_REFRESH === '1',
    };
    if (options.persistEnrichmentResult !== false) {
      await saveAnalysis(projectPath, output);
      output.layers_ready = buildCompletedAnalysisLayersReady(output);
      clearFreshnessSummaryCache();
      await saveAnalysisSnapshot(projectPath, output);
    }
  }, output.nodes.length, projectPath)).catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);





    output.ai_enrichment = 'error';





    output.ai_enrichment_error = message;
    console.error(`[Klauro] deferred AI enrichment FAILED for ${projectPath} (${message}); marked ai_enrichment='error' (comprehension is AI-only, no deterministic substitute)`);
    if (options.persistEnrichmentResult === false) return;
    try {
      await withProjectAnalysisLock(projectPath, () => withAiEnrichmentLanePermit(async () => {
        await saveAnalysis(projectPath, output);
        output.layers_ready = buildCompletedAnalysisLayersReady(output);
        clearFreshnessSummaryCache();
        await saveAnalysisSnapshot(projectPath, output);
      }, undefined, projectPath));
    } catch (saveError) {
      const saveMessage = saveError instanceof Error ? saveError.message : String(saveError);
      console.error(`[Klauro] failed to persist ai_enrichment='error' for ${projectPath} (${saveMessage})`);
    }
  });

  return { output, enrichment };
}













export interface LayeredAnalysisResult {
  l0: Promise<CASOutput>;
  rest: Promise<DeferredAnalysisResult>;
}













export async function analyzeProjectLayered(
  projectPath: string,
  displayName?: string,
  onProgress?: (event: AnalysisProgressEvent) => void,



















  forceFullRebuild?: boolean,
): Promise<LayeredAnalysisResult> {
  if (!(await fs.pathExists(projectPath))) {
    throw new Error(`Project path does not exist: ${projectPath}`);
  }

  const { computeL0Index, buildL0OnlyCas } = await import('./layered-analysis.js');

  const l0Promise = (async () => {
    const l0Index = await computeL0Index(projectPath);
    const l0Cas = buildL0OnlyCas(projectPath, displayName, l0Index);
    const lockAttempt = await withProjectAnalysisLockIfAvailable(projectPath, async () => {
      const existing = forceFullRebuild
        ? null
        : await loadAnalysis(projectPath, { preferCache: true }).catch(() => null);
      if (existing && existing.layers_ready?.complete === true && (existing.nodes?.length ?? 0) > 0) {
        return;
      }
      await saveAnalysis(projectPath, l0Cas);
      clearFreshnessSummaryCache();
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Klauro] L0 index save failed for ${projectPath} (${message}); continuing to full analysis`);
      return { acquired: false as const };
    });
    if (!lockAttempt.acquired) {
      console.error(`[Klauro] L0 index save skipped for ${projectPath}: analysis.lock is already held by an in-progress analysis; the full analysis will supersede the L0 index anyway`);
    }
    return l0Cas;
  })();

  const restPromise = l0Promise.then(async () => {
    const { buildCompletedAnalysisLayersReady, buildLayersReady } = await import('./layered-analysis.js');








    const previous = forceFullRebuild
      ? null
      : await loadAnalysis(projectPath, { preferCache: true }).catch(() => null);
    const hasCompletePrevious = !forceFullRebuild && Boolean(
      previous && previous.layers_ready?.complete === true && (previous.nodes?.length ?? 0) > 0
    );
    const stampStructuralLayers = (output: CASOutput): void => {
      const contentGeneratedAt = output.analysis_timestamp || new Date().toISOString();
      const aiConfigured = output.ai_enrichment !== undefined && output.ai_enrichment !== 'disabled';
      output.layers_ready = buildLayersReady({
        L0: { status: 'ready', completedAt: contentGeneratedAt },
        L1: { status: 'ready', completedAt: contentGeneratedAt },
        L2: { status: 'ready', completedAt: contentGeneratedAt },
        L3: { status: 'ready', completedAt: contentGeneratedAt },
        L4: aiConfigured && output.ai_enrichment === 'pending'
          ? { status: 'pending' }
          : { status: 'ready', completedAt: contentGeneratedAt },
        L5: output.ai_enrichment === 'disabled'
          ? { status: 'error', error: 'AI comprehension is disabled; required product narrative and capability comprehension were not generated' }
          : { status: aiConfigured ? (output.ai_enrichment === 'ready' || output.ai_enrichment === 'synchronous' ? 'ready' : 'pending') : 'ready' },
      }, { generatedAt: contentGeneratedAt });
    };
    let structuralCheckpointPrepared = false;
    const prepareStructuralCheckpoint = (output: CASOutput): void => {
      stampStructuralLayers(output);
      structuralCheckpointPrepared = true;
    };
    let deferred: DeferredAnalysisResult;
    if (hasCompletePrevious) {
      try {
        const incremental = await analyzeProjectIncremental(projectPath, displayName, onProgress);
        deferred = { output: incremental.output, enrichment: Promise.resolve() };
      } catch (error) {






        if (error instanceof AnalysisLoopBreakerError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[Klauro] warm incremental pass failed for ${projectPath} (${message}); falling back to full deferred analysis`);
        deferred = await analyzeProjectDeferred(projectPath, displayName, onProgress, {
          prepareStructuralCheckpoint,
          persistEnrichmentResult: false,
          deferStructuralSegments: true,
        });
      }
    } else {
      deferred = await analyzeProjectDeferred(projectPath, displayName, onProgress, {
        reuseStoredContext: !forceFullRebuild,
        prepareStructuralCheckpoint,
        persistEnrichmentResult: false,
        deferStructuralSegments: true,
      });
    }
    if (!structuralCheckpointPrepared) {
      stampStructuralLayers(deferred.output);
      await saveAnalysis(projectPath, deferred.output, 'main', { deferSegmentedWrite: true });
      clearFreshnessSummaryCache();
    }








    const enrichment = deferred.enrichment.then(async () => {
      if (deferred.output.ai_enrichment !== 'ready' && deferred.output.ai_enrichment !== 'error') return;
      const nextLayers = buildCompletedAnalysisLayersReady(deferred.output);
      if (JSON.stringify(deferred.output.layers_ready) === JSON.stringify(nextLayers)) return;
      deferred.output.layers_ready = nextLayers;
      await saveAnalysis(projectPath, deferred.output, 'main', { deferSegmentedWrite: true });
      clearFreshnessSummaryCache();
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Klauro] layers_ready L5 re-stamp failed for ${projectPath} (${message})`);
    });

    return { output: deferred.output, enrichment };
  });

  return { l0: l0Promise, rest: restPromise };
}















export async function getAnalysis(
  projectPath: string,
  options?: { track?: import('./track').AnalysisTrack; sections?: readonly CasSectionName[]; cas_id?: string }
): Promise<CASOutput> {
  if (options?.cas_id && !options.sections) {
    const subtree = await loadCompleteAnalysisFromSections(projectPath, { track: options.track, cas_id: options.cas_id });
    if (!subtree) throw new Error(`No analysis found for: ${projectPath}. Run analyze_codebase first.`);
    assertAnalysisVersionSupported(subtree, projectPath);
    return applyStoredElementDescriptions(projectPath, subtree);
  }
  if (options?.cas_id || options?.sections?.length && options.sections.length < CAS_SECTION_NAMES.length) {



    const partial = await loadAnalysisSections(
      projectPath,
      options.sections || CAS_SECTION_NAMES,
      {
        ...(options.track ? { track: options.track } : {}),
        ...(options.cas_id ? { cas_id: options.cas_id } : {}),
      },
    );
    if (!partial) throw new Error(`No analysis found for: ${projectPath}. Run analyze_codebase first.`);
    assertAnalysisVersionSupported(partial as CASOutput, projectPath);
    return partial as CASOutput;
  }

  const cached = await loadAnalysis(projectPath, { preferCache: true, ...(options?.track ? { track: options.track } : {}) });
  if (cached) {
    assertAnalysisVersionSupported(cached, projectPath);
    return applyStoredElementDescriptions(projectPath, cached);
  }
  throw new Error(`No analysis found for: ${projectPath}. Run analyze_codebase first.`);
}

export interface IncrementalAnalysisResult {
  output: CASOutput;
  state: IncrementalState;
  changeReport: ChangeReport;
  wasFullRebuild: boolean;
  fullRebuildReason?: string;
  previousCasVersion?: string;
}

const DEFAULT_INCREMENTAL_SNAPSHOT_INTERVAL_MS = 10 * 60_000;

function getIncrementalSnapshotIntervalMs(): number {
  const raw = process.env.KLAURO_INCREMENTAL_SNAPSHOT_INTERVAL_MS;
  if (raw === undefined || raw === '') return DEFAULT_INCREMENTAL_SNAPSHOT_INTERVAL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_INCREMENTAL_SNAPSHOT_INTERVAL_MS;
}

async function shouldSaveIncrementalSnapshot(projectPath: string, result: IncrementalAnalysisResult): Promise<boolean> {
  if (result.wasFullRebuild) return true;
  const intervalMs = getIncrementalSnapshotIntervalMs();
  if (intervalMs === 0) return true;

  try {
    const snapshots = await listAnalysisSnapshots(projectPath);
    const latest = snapshots.reduce((maximum, snapshot) => Math.max(maximum, Date.parse(snapshot.saved_at)), 0);
    if (!latest || Number.isNaN(latest)) return true;
    return Date.now() - latest >= intervalMs;
  } catch {
    return true;
  }
}

function makeEdgeId(edge: { id?: string; source: string; target: string; type: string }): string {
  return edge.id || `edge_${edge.source}_${edge.target}_${edge.type}`;
}

function hasReportChanges(report: ChangeReport): boolean {
  const summary = report.summary;
  return summary.filesAdded > 0 ||
    summary.filesModified > 0 ||
    summary.filesDeleted > 0 ||
    summary.nodesAdded > 0 ||
    summary.nodesModified > 0 ||
    summary.nodesDeleted > 0 ||
    summary.edgesAdded > 0 ||
    summary.edgesModified > 0 ||
    summary.edgesDeleted > 0 ||
    (report.details.addedEntryPoints?.length || 0) > 0 ||
    (report.details.modifiedEntryPoints?.length || 0) > 0 ||
    (report.details.deletedEntryPoints?.length || 0) > 0 ||
    (report.details.addedExitPoints?.length || 0) > 0 ||
    (report.details.deletedExitPoints?.length || 0) > 0;
}

function hasCasReportChanges(report: ChangeReport): boolean {
  const summary = report.summary;
  return summary.nodesAdded > 0 ||
    summary.nodesModified > 0 ||
    summary.nodesDeleted > 0 ||
    summary.edgesAdded > 0 ||
    summary.edgesModified > 0 ||
    summary.edgesDeleted > 0 ||
    (report.details.addedEntryPoints?.length || 0) > 0 ||
    (report.details.modifiedEntryPoints?.length || 0) > 0 ||
    (report.details.deletedEntryPoints?.length || 0) > 0 ||
    (report.details.addedExitPoints?.length || 0) > 0 ||
    (report.details.deletedExitPoints?.length || 0) > 0;
}

function buildChangeHistoryEntry(result: IncrementalAnalysisResult): ChangeHistoryEntry {
  const report = result.changeReport;
  const details = report.details;

  return {
    id: `change_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    timestamp: report.timestamp,
    gitCommitHash: result.state.gitCommitHash,
    source: 'unknown',
    changes: {
      files: details.files || [],
      nodes: [
        ...details.addedNodes.map(node => ({
          nodeId: node.id,
          nodeName: node.name,
          nodeType: node.type,
          file: node.file,
          changeType: 'added' as const,
        })),
        ...details.modifiedNodes.map(node => ({
          nodeId: node.id,
          nodeName: node.name,
          nodeType: node.type || 'unknown',
          file: node.file || 'unknown',
          changeType: 'modified' as const,
          semanticChange: node.changes.join(', '),
        })),
        ...details.deletedNodes.map(node => ({
          nodeId: node.id,
          nodeName: node.name,
          nodeType: node.type,
          file: node.file || 'unknown',
          changeType: 'deleted' as const,
        })),
      ],
      edges: [
        ...details.addedEdges.map(edge => ({
          edgeId: makeEdgeId(edge),
          source: edge.source,
          target: edge.target,
          edgeType: edge.type,
          changeType: 'added' as const,
        })),
        ...details.deletedEdges.map(edge => ({
          edgeId: makeEdgeId(edge),
          source: edge.source,
          target: edge.target,
          edgeType: edge.type,
          changeType: 'deleted' as const,
        })),
      ],
      entryPoints: [
        ...(details.addedEntryPoints || []).map(entryPoint => ({
          entryPointId: entryPoint.id,
          name: entryPoint.name,
          changeType: 'added' as const,
        })),
        ...(details.modifiedEntryPoints || []).map(entryPoint => ({
          entryPointId: entryPoint.id,
          name: entryPoint.name,
          changeType: 'modified' as const,
          details: entryPoint.details,
        })),
        ...(details.deletedEntryPoints || []).map(entryPoint => ({
          entryPointId: entryPoint.id,
          name: entryPoint.name,
          changeType: 'deleted' as const,
        })),
      ],
      exitPoints: [
        ...(details.addedExitPoints || []).map(exitPoint => ({
          exitPointId: exitPoint.id,
          name: exitPoint.name,
          changeType: 'added' as const,
        })),
        ...(details.deletedExitPoints || []).map(exitPoint => ({
          exitPointId: exitPoint.id,
          name: exitPoint.name,
          changeType: 'deleted' as const,
        })),
      ],
    },
    semanticSummary: result.wasFullRebuild
      ? `Full rebuild triggered${result.fullRebuildReason ? `: ${result.fullRebuildReason}` : ''}`
      : `${report.summary.filesAdded + report.summary.filesModified + report.summary.filesDeleted} files changed; ${report.summary.nodesAdded} nodes added, ${report.summary.nodesModified} modified, ${report.summary.nodesDeleted} deleted`,
    intent: {
      type: 'unknown' as const,
      confidence: 0,
      evidence: [],
    },
    impact: report.impact,
    suggestedActions: [],
    breakingChanges: [],
    minimumTestSet: [],
  };
}






























const DEFAULT_ANALYSIS_LANES = 2;
const PER_LANE_RAM_FACTOR = 1.4;
const HOST_RESERVE_MB = 1536;

function deriveAnalysisLaneCountFromHost(): number {
  const heap = resolveAnalysisHeapMb();
  const perLaneMb = Math.max(1, Math.round(heap.heapMb * PER_LANE_RAM_FACTOR));
  const usableMb = heap.totalRamMb - HOST_RESERVE_MB;
  if (usableMb <= 0) return 1;
  const byRam = Math.floor(usableMb / perLaneMb);




  return Math.max(1, Math.min(DEFAULT_ANALYSIS_LANES, byRam));
}

function getAnalysisLaneCount(): number {
  const raw = process.env.KLAURO_ANALYSIS_CONCURRENCY ?? process.env.KLAURO_ANALYSIS_LANES;
  if (raw === undefined || raw === '') return deriveAnalysisLaneCountFromHost();
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : deriveAnalysisLaneCountFromHost();
}












const DEFAULT_MEMORY_RSS_LIMIT_BYTES = 5 * 1024 * 1024 * 1024;
const DEFAULT_MEMORY_CONTAINER_RATIO = 0.7;

function getMemoryRssLimitBytes(): number {
  const raw = process.env.KLAURO_ANALYSIS_MEMORY_RSS_LIMIT_BYTES;
  const parsed = raw !== undefined && raw !== '' ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MEMORY_RSS_LIMIT_BYTES;
}

function getMemoryContainerRatio(): number {
  const raw = process.env.KLAURO_ANALYSIS_MEMORY_CONTAINER_RATIO;
  const parsed = raw !== undefined && raw !== '' ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : DEFAULT_MEMORY_CONTAINER_RATIO;
}







let memoryGuardOverrideForTests: (() => boolean) | null = null;

function isMemoryTight(): boolean {
  if (memoryGuardOverrideForTests) return memoryGuardOverrideForTests();
  const container = readContainerMemory();
  if (container) return container.usage === null || container.usage / container.limit > getMemoryContainerRatio();
  return process.memoryUsage().rss > getMemoryRssLimitBytes();
}



export function __setMemoryGuardOverrideForTests(override: boolean | null): void {
  memoryGuardOverrideForTests = override === null ? null : () => override;
}












const DEFAULT_QUEUE_MAX_WAIT_MS = 15 * 60 * 1000;

function getQueueMaxWaitMs(): number {
  const raw = process.env.KLAURO_ANALYSIS_QUEUE_MAX_WAIT_MS;
  const parsed = raw !== undefined && raw !== '' ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_QUEUE_MAX_WAIT_MS;
}

interface LaneWaiter {
  resolve: () => void;



  sizeHint: number;
  enqueuedAt: number;
}







function createLanePool(getCapacity: () => number) {
  let permitsInUse = 0;
  let waiters: LaneWaiter[] = [];





  function pickNextWaiterIndex(): number {
    if (waiters.length === 0) return -1;
    const now = Date.now();
    const maxWaitMs = getQueueMaxWaitMs();

    let promotedIdx = -1;
    let promotedEnqueuedAt = Infinity;
    for (let i = 0; i < waiters.length; i++) {
      const waiter = waiters[i];
      if (now - waiter.enqueuedAt >= maxWaitMs && waiter.enqueuedAt < promotedEnqueuedAt) {
        promotedIdx = i;
        promotedEnqueuedAt = waiter.enqueuedAt;
      }
    }
    if (promotedIdx !== -1) return promotedIdx;

    let bestIdx = 0;
    for (let i = 1; i < waiters.length; i++) {
      const candidate = waiters[i];
      const best = waiters[bestIdx];
      if (
        candidate.sizeHint < best.sizeHint ||
        (candidate.sizeHint === best.sizeHint && candidate.enqueuedAt < best.enqueuedAt)
      ) {
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  function acquire(sizeHint: number): Promise<void> {
    const capacity = getCapacity();


    const effectiveCapacity = permitsInUse >= 1 && isMemoryTight() ? 1 : capacity;
    if (permitsInUse < effectiveCapacity) {
      permitsInUse += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      waiters.push({ resolve, sizeHint, enqueuedAt: Date.now() });
    });
  }

  function release(): void {
    const idx = pickNextWaiterIndex();
    if (idx !== -1) {


      const [waiter] = waiters.splice(idx, 1);
      waiter.resolve();
      return;
    }
    permitsInUse = Math.max(0, permitsInUse - 1);
  }

  function reset(): void {
    permitsInUse = 0;
    waiters = [];
  }

  function inUse(): number {
    return permitsInUse;
  }

  return { acquire, release, reset, inUse };
}


































const DEFAULT_AI_ENRICHMENT_LANES = 4;

function getAiEnrichmentLaneCount(): number {
  const raw = process.env.KLAURO_AI_ENRICHMENT_CONCURRENCY ?? process.env.KLAURO_AI_ENRICHMENT_LANES;
  if (raw === undefined || raw === '') return DEFAULT_AI_ENRICHMENT_LANES;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : DEFAULT_AI_ENRICHMENT_LANES;
}

const deterministicLanePool = createLanePool(getAnalysisLaneCount);
const aiEnrichmentLanePool = createLanePool(getAiEnrichmentLaneCount);

function acquireLanePermit(sizeHint: number): Promise<void> {
  return deterministicLanePool.acquire(sizeHint);
}

function releaseLanePermit(): void {
  deterministicLanePool.release();
}

function acquireAiEnrichmentLanePermit(sizeHint: number): Promise<void> {
  return aiEnrichmentLanePool.acquire(sizeHint);
}

function releaseAiEnrichmentLanePermit(): void {
  aiEnrichmentLanePool.release();
}






async function estimateProjectSizeHint(projectPath: string): Promise<number> {
  try {
    const nodeCount = (await getAnalysisEntry(projectPath))?.node_count;
    if (typeof nodeCount === 'number' && Number.isFinite(nodeCount)) return nodeCount;
  } catch {   }
  return Number.POSITIVE_INFINITY;
}




const DEFAULT_ANALYSIS_WATCHDOG_MS = 30 * 60_000;

function getAnalysisWatchdogMs(): number {
  const raw = process.env.KLAURO_ANALYSIS_WATCHDOG_MS;
  const parsed = raw !== undefined && raw !== '' ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ANALYSIS_WATCHDOG_MS;
}

const DEFAULT_ANALYSIS_STALL_MS = 10 * 60_000;

function getAnalysisStallMs(): number {
  const raw = process.env.KLAURO_ANALYSIS_STALL_MS;
  const parsed = raw !== undefined && raw !== '' ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ANALYSIS_STALL_MS;
}












interface InternalRebuildAttemptRecord {
  state: 'in-progress' | 'succeeded' | 'failed';
  trigger: 'version-rebuild';
  started_at: string;
  finished_at?: string;
  duration_ms?: number;
  reason?: string;






  stored_version?: string;
  current_version?: string;
}

function internalRebuildAttemptPath(projectPath: string): string {
  return path.join(projectPath, '.reanalyze-attempt.json');
}

async function writeInternalRebuildAttempt(projectPath: string, record: InternalRebuildAttemptRecord): Promise<void> {
  try {
    await writeJsonAtomic(internalRebuildAttemptPath(projectPath), record);
  } catch {

  }
}

async function readInternalRebuildAttempt(projectPath: string): Promise<InternalRebuildAttemptRecord | null> {
  try {
    if (!nodeFs.existsSync(internalRebuildAttemptPath(projectPath))) return null;
    return await fs.readJson(internalRebuildAttemptPath(projectPath));
  } catch {
    return null;
  }
}










export class AnalysisLoopBreakerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalysisLoopBreakerError';
  }
}

function isDoomedRebuildReason(reason: string | undefined): boolean {
  if (!reason) return false;
  return /worker-oom|analysis-stalled|reached heap limit|javascript heap out of memory|fatal error|killed by signal|exhausting its heap/i.test(reason);
}

async function guardAgainstDoomedVersionRebuild(
  projectPath: string,
  versionInfo: { stored_version?: string; current_version: string },
): Promise<void> {
  if (!versionInfo.stored_version || versionInfo.stored_version === versionInfo.current_version) return;
  const previousAttempt = await readInternalRebuildAttempt(projectPath);
  if (
    previousAttempt?.state === 'failed' &&
    previousAttempt.stored_version === versionInfo.stored_version &&
    previousAttempt.current_version === versionInfo.current_version &&
    isDoomedRebuildReason(previousAttempt.reason)
  ) {
    const message = [
      `loop-breaker: refusing to auto-retrigger the version-rebuild for ${projectPath}`,
      `(stored_version=${versionInfo.stored_version} -> current_version=${versionInfo.current_version}).`,
      `The previous attempt (finished ${previousAttempt.finished_at ?? previousAttempt.started_at}) already FAILED`,
      `with a worker-OOM/progress-stall reason: ${previousAttempt.reason}.`,
      `Auto-retriggering an identical rebuild would repeat the same crash indefinitely`,
      `(the 2026-07-18 infinite-crash-loop incident). Leaving the failed attempt record in place;`,
      `a human or agent must explicitly re-trigger (e.g. a force_full reanalyze) after addressing`,
      `the cause (raise KLAURO_ANALYSIS_HEAP_MB, repair the stalled phase, or fix the hang).`,
    ].join(' ');
    console.error(`[Klauro] ${message}`);
    throw new AnalysisLoopBreakerError(message);
  }
}

export async function checkDoomedVersionRebuild(projectPath: string): Promise<string | null> {
  try {
    const entry = await getAnalysisEntry(projectPath).catch(() => null);
    if (!entry) return null;
    const versionInfo = describeAnalysisVersion(entry.cas_version);
    await guardAgainstDoomedVersionRebuild(projectPath, versionInfo);
    return null;
  } catch (error) {
    if (error instanceof AnalysisLoopBreakerError) return error.message;
    return null;
  }
}







function describeLastRunLogState(projectPath: string): string {
  try {
    const records = readRecentRunRecords();
    const finishedRunIds = new Set(
      records.filter((r): r is AnalysisRunFinalRecord => r.event === 'run-complete' || r.event === 'run-failed')
        .map(r => r.run_id)
    );
    const openStarts = records
      .filter((r): r is AnalysisRunStartRecord => r.event === 'run-start' && r.project_path === projectPath && !finishedRunIds.has(r.run_id));
    const latest = openStarts[openStarts.length - 1];
    if (!latest) return 'no open run-log entry found (run log records phases only at completion, so a hung run has nothing further to show)';
    return `run ${latest.run_id} started at ${latest.started_at}, never reached run-complete/run-failed (run log has no live in-progress phase, only phases-at-completion)`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `run log unreadable (${message})`;
  }
}








async function withPoolPermit<T>(
  acquire: (sizeHint: number) => Promise<void>,
  release: () => void,
  fn: () => Promise<T>,
  sizeHint: number,
  projectPath: string,
  watchdogLabel: string
): Promise<T> {
  await acquire(sizeHint);
  const startedAtMs = Date.now();
  const watchdogMs = getAnalysisWatchdogMs();
  const timer = setTimeout(() => {
    const elapsedMinutes = Math.round((Date.now() - startedAtMs) / 60_000);
    console.error(
      `[Klauro] SLOW ${watchdogLabel}: ${projectPath} has been running ${elapsedMinutes}m, exceeding ` +
      `KLAURO_ANALYSIS_WATCHDOG_MS=${watchdogMs}ms. Last known state: ${describeLastRunLogState(projectPath)}. ` +
      `The analysis remains in progress and retains its lock and lane; elapsed time never truncates or fails CAS work.`
    );
  }, watchdogMs);
  timer.unref();
  try {
    return await fn();
  } finally {
    clearTimeout(timer);
    release();
  }
}














function withLanePermit<T>(
  fn: () => Promise<T>,
  sizeHint: number = Number.POSITIVE_INFINITY,
  projectPath: string = 'analysis'
): Promise<T> {
  return withPoolPermit(acquireLanePermit, releaseLanePermit, fn, sizeHint, projectPath, 'ANALYSIS');
}







function withAiEnrichmentLanePermit<T>(
  fn: () => Promise<T>,
  sizeHint: number = Number.POSITIVE_INFINITY,
  projectPath: string = 'analysis'
): Promise<T> {
  return withPoolPermit(acquireAiEnrichmentLanePermit, releaseAiEnrichmentLanePermit, fn, sizeHint, projectPath, 'AI ENRICHMENT');
}








function withAnalysisLane<T>(
  fn: (orch: AnalyzerOrchestrator) => Promise<T>,
  sizeHint?: number,
  describe?: string
): Promise<T> {
  return withLanePermit(() => fn(createOrchestrator()), sizeHint, describe);
}




export function __resetAnalysisLanesForTests(): void {
  deterministicLanePool.reset();
  aiEnrichmentLanePool.reset();
  memoryGuardOverrideForTests = null;
}




export function __withLanePermitForTests<T>(fn: () => Promise<T>, sizeHint?: number, describe?: string): Promise<T> {
  return withLanePermit(fn, sizeHint, describe);
}




export function __withAiEnrichmentLanePermitForTests<T>(fn: () => Promise<T>, sizeHint?: number, describe?: string): Promise<T> {
  return withAiEnrichmentLanePermit(fn, sizeHint, describe);
}





export function __withOuterWorkerWatchdogForTests(
  projectPath: string,
  run: () => Promise<AnalysisRunSummary>
): Promise<AnalysisRunSummary> {
  return withOuterWorkerWatchdog(projectPath, run);
}




export async function __readInternalRebuildAttemptForTests(projectPath: string): Promise<InternalRebuildAttemptRecord | null> {
  return readInternalRebuildAttempt(projectPath);
}



export function __getLanePermitsInUseForTests(): number {
  return deterministicLanePool.inUse();
}



export function __getAiEnrichmentLanePermitsInUseForTests(): number {
  return aiEnrichmentLanePool.inUse();
}

export async function analyzeProjectIncremental(
  projectPath: string,
  displayName?: string,
  onProgress?: (event: AnalysisProgressEvent) => void,
): Promise<IncrementalAnalysisResult> {
  if (!(await fs.pathExists(projectPath))) {
    throw new Error(`Project path does not exist: ${projectPath}`);
  }


  const sizeHint = await estimateProjectSizeHint(projectPath);
  return withProjectAnalysisLock(
    projectPath,
    () => withAnalysisLane((orch) => runIncrementalAnalysis(projectPath, orch, displayName, onProgress), sizeHint, projectPath),
  );
}

async function runIncrementalAnalysis(
  projectPath: string,
  orch: AnalyzerOrchestrator,
  displayName?: string,
  onProgress?: (event: AnalysisProgressEvent) => void,
): Promise<IncrementalAnalysisResult> {
  const debugTimings = process.env.KLAURO_DEBUG_INCREMENTAL_TIMINGS === '1';
  const debug = (label: string, startedAt: number) => {
    if (debugTimings) {
      console.error(`[Klauro] incremental timing ${label}: ${Date.now() - startedAt}ms`);
    }
  };

  orch.configureEmbedding(await buildEmbeddingPhaseConfig(projectPath));
  const conventions = await loadConventionsForAnalysis(projectPath);
  const packGlobs = await loadPackGlobsForAnalysis(projectPath);

  const previousOutput = await loadAnalysisSections(projectPath, CAS_SECTION_NAMES.filter(section => section !== 'tree')) as CASOutput | null;
  const previousState = await loadIncrementalState(projectPath);
  const previousCasVersion = previousOutput
    ? getAnalysisVersionInfo(previousOutput).stored_version
    : undefined;

  if (!previousOutput) {
    let phaseStartedAt = Date.now();
    const result = await orch.orchestrateAnalysis(projectPath, { displayName, conventions, packGlobs, onProgress });
    debug('initial-orchestrate-full', phaseStartedAt);
    phaseStartedAt = Date.now();
    result.layers_ready = buildCompletedAnalysisLayersReady(result);
    await saveAnalysis(projectPath, result);
    clearFreshnessSummaryCache();
    debug('initial-save-analysis', phaseStartedAt);

    phaseStartedAt = Date.now();
    const freshResult = await orch.orchestrateIncrementalAnalysis(
      projectPath,
      result,
      null,
      {
        loadCache: (hash) => loadFileCache(projectPath, hash),
        saveCache: (hash, fileResult) => saveFileCache(projectPath, hash, fileResult),
        displayName,
        onProgress,
      }
    );
    debug('initial-build-state', phaseStartedAt);

    phaseStartedAt = Date.now();
    freshResult.output.layers_ready = buildCompletedAnalysisLayersReady(freshResult.output);
    await saveIncrementalState(projectPath, freshResult.state);
    debug('initial-save-state', phaseStartedAt);
    phaseStartedAt = Date.now();
    await saveAnalysisSnapshot(projectPath, freshResult.output);
    debug('initial-save-snapshot', phaseStartedAt);

    return freshResult;
  }








  const versionInfo = getAnalysisVersionInfo(previousOutput);
  const likelyVersionRebuild = versionInfo.stored_version !== versionInfo.current_version;
  const attemptStartedAt = new Date();
  if (likelyVersionRebuild) {






    await guardAgainstDoomedVersionRebuild(projectPath, versionInfo);
    await writeInternalRebuildAttempt(projectPath, {
      state: 'in-progress',
      trigger: 'version-rebuild',
      started_at: attemptStartedAt.toISOString(),
      reason: `stored cas_version ${versionInfo.stored_version} differs from the running server's cas_version ${versionInfo.current_version}`,
      stored_version: versionInfo.stored_version,
      current_version: versionInfo.current_version,
    });
  }

  let phaseStartedAt = Date.now();
  let result: Awaited<ReturnType<typeof orch.orchestrateIncrementalAnalysis>>;
  try {
    result = await orch.orchestrateIncrementalAnalysis(
      projectPath,
      previousOutput,
      previousState,
      {
        loadCache: (hash) => loadFileCache(projectPath, hash),
        saveCache: (hash, fileResult) => saveFileCache(projectPath, hash, fileResult),
        displayName,
        onProgress,
      }
    );
  } catch (error) {
    if (likelyVersionRebuild) {
      await writeInternalRebuildAttempt(projectPath, {
        state: 'failed',
        trigger: 'version-rebuild',
        started_at: attemptStartedAt.toISOString(),
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - attemptStartedAt.getTime(),
        reason: error instanceof Error ? error.message : String(error),
        stored_version: versionInfo.stored_version,
        current_version: versionInfo.current_version,
      });
    }
    throw error;
  }
  debug('orchestrate-incremental', phaseStartedAt);

  if (likelyVersionRebuild) {
    await writeInternalRebuildAttempt(projectPath, {
      state: 'succeeded',
      trigger: 'version-rebuild',
      started_at: attemptStartedAt.toISOString(),
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - attemptStartedAt.getTime(),
      reason: result.fullRebuildReason,
      stored_version: versionInfo.stored_version,
      current_version: versionInfo.current_version,
    });
  }

  if (result.wasFullRebuild && result.output !== previousOutput) {



    preservePreviousAIDescriptions(previousOutput, result.output);
  }

  const previousLayersReady = JSON.stringify(result.output.layers_ready ?? null);
  result.output.layers_ready = buildCompletedAnalysisLayersReady(result.output);
  linkStructuralOwnership(result.output.nodes, result.output.edges);
  assignNodeRoles({
    nodes: result.output.nodes,
    edges: result.output.edges,
    entry_points: result.output.entry_points,
    exit_points: result.output.exit_points,
    resetDerivedRoles: true,
  });
  const layersManifestChanged = JSON.stringify(result.output.layers_ready) !== previousLayersReady;
  const casChanged = hasCasReportChanges(result.changeReport);
  const outputChanged = result.output !== previousOutput || casChanged || layersManifestChanged;
  if (outputChanged) {
    phaseStartedAt = Date.now();
    await saveAnalysis(projectPath, result.output, 'main', { deferSegmentedWrite: true });
    clearFreshnessSummaryCache();
    debug('save-analysis', phaseStartedAt);
  }
  phaseStartedAt = Date.now();
  await saveIncrementalState(projectPath, result.state);
  debug('save-state', phaseStartedAt);

  if (hasReportChanges(result.changeReport)) {
    phaseStartedAt = Date.now();
    await saveChangeHistoryEntry(projectPath, buildChangeHistoryEntry(result));
    debug('save-change-history', phaseStartedAt);
    if (outputChanged && await shouldSaveIncrementalSnapshot(projectPath, result)) {
      phaseStartedAt = Date.now();
      await saveAnalysisSnapshot(projectPath, result.output);
      debug('save-snapshot', phaseStartedAt);
    } else if (outputChanged) {
      debug('skip-snapshot-throttled', Date.now());
    }
  }

  return { ...result, previousCasVersion };
}

export async function getIncrementalState(projectPath: string): Promise<IncrementalState | null> {
  return loadIncrementalState(projectPath);
}

export interface AnalysisChangeSummary {
  files_changed: number;
  nodes_added: number;
  nodes_modified: number;
  nodes_deleted: number;
  risk_level: string;
}

export interface AnalysisRunSummary {
  analysisType: 'full' | 'incremental';
  name: string;
  nodes: number;
  edges: number;
  entryPoints: number;
  analyzersRun: number;
  errors: number;
  warnings: number;
  information: number;
  phases: unknown[];
  casVersion?: string;
  previousCasVersion?: string;
  wasFullRebuild: boolean;
  fullRebuildReason?: string;
  changeSummary?: AnalysisChangeSummary;
  changeReport?: ChangeReport;
}
function summarizeOutput(projectPath: string, output: CASOutput): Omit<AnalysisRunSummary, 'analysisType' | 'wasFullRebuild'> {
  const diagnostics = partitionAnalysisDiagnostics(output.analysis_errors);
  return {
    name: output.system?.name || projectPath.split('/').pop() || projectPath,
    nodes: output.nodes?.length || 0,
    edges: output.edges?.length || 0,
    entryPoints: output.entry_points?.length || 0,
    analyzersRun: output.analyzer_contributions?.length || 0,
    errors: diagnostics.errors.length,
    warnings: diagnostics.warnings.length,
    information: diagnostics.information.length,
    phases: output.analysis_phases || [],
    casVersion: output.cas_version,
  };
}

export function summarizeFullAnalysis(projectPath: string, output: CASOutput): AnalysisRunSummary {
  return {
    ...summarizeOutput(projectPath, output),
    analysisType: 'full',
    wasFullRebuild: true,
  };
}

function trimChangeReportForTransfer(report: ChangeReport, wasFullRebuild: boolean): ChangeReport {
  if (!wasFullRebuild) return report;
  const emptiedDetails = Object.fromEntries(
    Object.entries(report.details || {}).map(([key, value]) => [key, Array.isArray(value) ? [] : value]),
  ) as unknown as ChangeReport['details'];
  return { ...report, details: emptiedDetails };
}

export function summarizeIncrementalAnalysis(projectPath: string, result: IncrementalAnalysisResult): AnalysisRunSummary {
  return {
    ...summarizeOutput(projectPath, result.output),
    analysisType: result.wasFullRebuild ? 'full' : 'incremental',
    wasFullRebuild: result.wasFullRebuild,
    fullRebuildReason: result.fullRebuildReason,
    previousCasVersion: result.previousCasVersion,
    changeReport: trimChangeReportForTransfer(result.changeReport, result.wasFullRebuild),
    changeSummary: result.wasFullRebuild ? undefined : {
      files_changed: result.changeReport.summary.filesAdded +
        result.changeReport.summary.filesModified +
        result.changeReport.summary.filesDeleted,
      nodes_added: result.changeReport.summary.nodesAdded,
      nodes_modified: result.changeReport.summary.nodesModified,
      nodes_deleted: result.changeReport.summary.nodesDeleted,
      risk_level: result.changeReport.impact.riskLevel,
    },
  };
}









export interface LayeredJobPhaseEvent {
  phase: 'l0' | 'rest' | 'enrichment';
  status: 'succeeded' | 'failed';
  error?: string;
}

interface WorkerProgressMessage extends AnalysisProgressEvent {
  type: 'progress';
  id: number;
}



export interface LayeredRunSummary {
  name: string;
  nodes: number;
  edges: number;
  entryPoints: number;
  analyzersRun: number;
  errors: number;
  casVersion?: string;
  aiEnrichment: CASOutput['ai_enrichment'];
  aiEnrichmentError?: string;
  failedLayers: Array<{ layer: string; error?: string }>;
}

export function summarizeLayeredAnalysis(projectPath: string, output: CASOutput): LayeredRunSummary {
  const base = summarizeOutput(projectPath, output);
  return {
    name: base.name,
    nodes: base.nodes,
    edges: base.edges,
    entryPoints: base.entryPoints,
    analyzersRun: base.analyzersRun,
    errors: base.errors,
    casVersion: base.casVersion,
    aiEnrichment: output.ai_enrichment,
    aiEnrichmentError: output.ai_enrichment_error,
    failedLayers: (output.layers_ready?.layers || [])
      .filter(layer => layer.status === 'error')
      .map(layer => ({ layer: layer.layer, ...(layer.error ? { error: layer.error } : {}) })),
  };
}

export interface RunAnalysisOptions {
  forceFull?: boolean;







  displayName?: string;
}

export async function runAnalysisInProcess(projectPath: string, options: RunAnalysisOptions = {}): Promise<AnalysisRunSummary> {
  if (options.forceFull) {
    const output = await analyzeProject(projectPath, options.displayName);
    return summarizeFullAnalysis(projectPath, output);
  }
  const result = await analyzeProjectIncremental(projectPath, options.displayName);
  return summarizeIncrementalAnalysis(projectPath, result);
}

export function analysisRunsInProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.KLAURO_ANALYSIS_IN_PROCESS === '1' || env.KLAURO_ANALYSIS_IN_PROCESS === 'true';
}

interface WorkerAnalyzeRequest {
  type: 'analyze';
  id: number;
  projectPath: string;
  forceFull: boolean;
  displayName?: string;
  env: Record<string, string>;
}









interface WorkerLayeredRequest {
  type: 'layered';
  id: number;
  projectPath: string;
  displayName?: string;
  env: Record<string, string>;
  analysisFocus?: import('./analysis-focus').AnalysisFocus;
  repoFacts?: import('./remote-source').RepoFacts;
  repoFactsUnavailable?: boolean;

  forceFullRebuild?: boolean;
}

interface WorkerResultMessage<T = AnalysisRunSummary> {
  type: 'result';
  id: number;
  summary: T;
}

interface WorkerErrorMessage {
  type: 'error';
  id: number;
  message: string;
  stackTop?: string;
}






interface WorkerPhaseMessage extends LayeredJobPhaseEvent {
  type: 'phase';
  id: number;
}

type WorkerResponse = WorkerResultMessage | WorkerErrorMessage | WorkerPhaseMessage | WorkerProgressMessage;

interface PendingWorkerJob<T = AnalysisRunSummary> {
  projectPath: string;
  startedAtMs: number;
  resolve: (summary: T) => void;
  reject: (error: Error) => void;

  onPhase?: (event: LayeredJobPhaseEvent) => void;
  lastProgressAtMs?: number;
  lastProgressSequence?: number;
  lastProgressPhase?: string;
  stallTimer?: NodeJS.Timeout;
}

interface WorkerHandle {
  child: ChildProcess;
  remote: boolean;
  heap: AnalysisHeapResolution;
  stderrTail: string;
  idleTimer?: NodeJS.Timeout;




  pending: Map<number, PendingWorkerJob<any>>;
}

const WORKER_STDERR_TAIL_CHARS = 4096;

let workerHandle: WorkerHandle | null = null;
let nextWorkerJobId = 1;

const DEFAULT_ANALYSIS_WORKER_IDLE_MS = 0;

export function resolveAnalysisWorkerIdleMs(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.KLAURO_ANALYSIS_WORKER_IDLE_MS;
  const parsed = raw !== undefined && raw !== '' ? Number(raw) : NaN;
  if (parsed === -1) return null;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_ANALYSIS_WORKER_IDLE_MS;
}

function clearWorkerIdleTimer(handle: WorkerHandle): void {
  if (!handle.idleTimer) return;
  clearTimeout(handle.idleTimer);
  handle.idleTimer = undefined;
}

function scheduleWorkerIdleShutdown(handle: WorkerHandle): void {
  clearWorkerIdleTimer(handle);
  if (handle.pending.size > 0 || workerHandle !== handle) return;
  if (handle.remote) {
    workerHandle = null;
    if (handle.child.connected) handle.child.disconnect();
    return;
  }
  const idleMs = resolveAnalysisWorkerIdleMs();
  if (idleMs === null) return;
  handle.idleTimer = setTimeout(() => {
    handle.idleTimer = undefined;
    if (workerHandle !== handle || handle.pending.size > 0) return;
    workerHandle = null;
    handle.child.disconnect();
  }, idleMs);
  handle.idleTimer.unref();
}


function collectKlauroEnvSnapshot(): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('KLAURO_') && value !== undefined) snapshot[key] = value;
  }
  return snapshot;
}

function spawnAnalysisWorker(heap: AnalysisHeapResolution): WorkerHandle {
  const remote = Boolean(process.env.KLAURO_ANALYSIS_WORKER_SOCKET);
  const child = fork(resolveAnalysisWorkerEntry(remote ? 'analysis-worker-proxy' : 'analysis-worker'), [], {
    execArgv: [...analysisWorkerExecArgv(process.execArgv), `--max-old-space-size=${remote ? 64 : heap.heapMb}`],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: process.env,
  });

  const handle: WorkerHandle = { child, remote, heap, stderrTail: '', pending: new Map() };

  const captureOutput = (chunk: Buffer) => {
    process.stderr.write(chunk);
    handle.stderrTail = (handle.stderrTail + chunk.toString()).slice(-WORKER_STDERR_TAIL_CHARS);
  };
  child.stdout?.on('data', captureOutput);
  child.stderr?.on('data', captureOutput);

  child.on('message', (message: WorkerResponse) => {
    const job = handle.pending.get(message.id);
    if (!job) return;
    if (message.type === 'progress') {
      if ((message.sequence ?? 0) > (job.lastProgressSequence ?? 0)) {
        job.lastProgressSequence = message.sequence;
        job.lastProgressAtMs = Date.now();
        job.lastProgressPhase = message.phase;
      }
      return;
    }
    if (message.type === 'phase') {



      job.lastProgressAtMs = Date.now();
      job.lastProgressPhase = message.phase;
      job.onPhase?.({ phase: message.phase, status: message.status, error: message.error });
      return;
    }
    handle.pending.delete(message.id);
    if (job.stallTimer) clearInterval(job.stallTimer);
    if (message.type === 'result') {
      job.resolve(message.summary);
    } else {
      const error = new Error(message.message);
      if (message.stackTop) error.stack = `${message.message}\n${message.stackTop}`;
      job.reject(error);
    }
    scheduleWorkerIdleShutdown(handle);
  });

  child.on('error', (error) => {
    failPendingWorkerJobs(handle, null, null, `worker process error: ${error.message}`);
  });

  child.on('exit', (code, signal) => {
    if (workerHandle === handle) workerHandle = null;
    failPendingWorkerJobs(handle, code, signal);
  });

  return handle;
}


function workerLooksOutOfMemory(handle: WorkerHandle, code: number | null, signal: NodeJS.Signals | null): boolean {
  if (/Reached heap limit|JavaScript heap out of memory|FATAL ERROR/i.test(handle.stderrTail)) return true;
  return signal === 'SIGABRT' || code === 134;
}
function buildWorkerCrashMessage(
  handle: WorkerHandle,
  job: PendingWorkerJob,
  code: number | null,
  signal: NodeJS.Signals | null,
  detail?: string,
): string {
  const exitDescription = detail
    ? detail
    : signal
      ? `killed by signal ${signal}`
      : `exited with code ${code}`;
  const oom = workerLooksOutOfMemory(handle, code, signal);
  const heap = handle.heap;
  const heapSource = heap.source === 'env' ? 'from KLAURO_ANALYSIS_HEAP_MB' : 'default';
  return [
    `Analysis worker for ${job.projectPath} ${exitDescription}${oom ? ' after exhausting its heap' : ''}.`,
    handle.remote
      ? 'The isolated worker service or its IPC proxy ended; inspect both service logs and their separate memory budgets before retrying.'
      : oom
      ? `The worker heap was ${heap.heapMb} MB (${heapSource}); inspect the shared container memory budget before changing KLAURO_ANALYSIS_HEAP_MB or retrying the complete analysis.`
      : 'The process ended without heap-exhaustion evidence; inspect the worker lifecycle and service logs before retrying.',
    `A run-failed record was written to ${getAnalysisRunLogPath()}; inspect service health because the worker and API may share a container memory limit.`,
  ].join(' ');
}

function failPendingWorkerJobs(
  handle: WorkerHandle,
  code: number | null,
  signal: NodeJS.Signals | null,
  detail?: string,
): void {
  for (const [id, job] of handle.pending) {
    handle.pending.delete(id);
    if (job.stallTimer) clearInterval(job.stallTimer);
    const message = buildWorkerCrashMessage(handle, job, code, signal, detail);
    try {
      finalizeWorkerRunFailure(job.projectPath, job.startedAtMs, message);
    } catch {

    }
    job.reject(new Error(message));
  }
}

function readRunLogRecords(): AnalysisRunRecord[] {
  const logPath = getAnalysisRunLogPath();
  if (!nodeFs.existsSync(logPath)) return [];
  const records: AnalysisRunRecord[] = [];
  for (const line of nodeFs.readFileSync(logPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as AnalysisRunRecord);
    } catch {

    }
  }
  return records;
}

export function finalizeWorkerRunFailure(projectPath: string, jobStartedAtMs: number, message: string): void {
  const records = readRunLogRecords();
  const finalized = new Set(
    records
      .filter(record => record.event === 'run-complete' || record.event === 'run-failed')
      .map(record => record.run_id),
  );
  const orphans = records.filter((record): record is AnalysisRunStartRecord =>
    record.event === 'run-start' &&
    record.project_path === projectPath &&
    !finalized.has(record.run_id) &&
    Date.parse(record.started_at) >= jobStartedAtMs - 60_000,
  );

  const nowIso = new Date().toISOString();
  const failures: AnalysisRunFinalRecord[] = orphans.length > 0
    ? orphans.map(start => ({
      run_id: start.run_id,
      project_path: start.project_path,
      project_name: start.project_name,
      cas_version: start.cas_version,
      event: 'run-failed',
      started_at: start.started_at,
      ended_at: nowIso,
      duration_ms: Math.max(0, Date.now() - Date.parse(start.started_at)),
      phases: [],
      analyzers: [],
      warnings: [],
      warning_overflow: 0,
      error: { message },
    }))
    : [{
      run_id: `analysis_worker_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      project_path: projectPath,
      project_name: path.basename(projectPath),
      event: 'run-failed',
      started_at: new Date(jobStartedAtMs).toISOString(),
      ended_at: nowIso,
      duration_ms: Math.max(0, Date.now() - jobStartedAtMs),
      phases: [],
      analyzers: [],
      warnings: [],
      warning_overflow: 0,
      error: { message },
    }];

  const logPath = getAnalysisRunLogPath();
  nodeFs.mkdirSync(path.dirname(logPath), { recursive: true });
  nodeFs.appendFileSync(logPath, failures.map(record => `${JSON.stringify(record)}\n`).join(''));
}

function ensureAnalysisWorker(): WorkerHandle {
  const heap = resolveAnalysisHeapMb();
  if (workerHandle && (workerHandle.heap.heapMb !== heap.heapMb || workerHandle.remote !== Boolean(process.env.KLAURO_ANALYSIS_WORKER_SOCKET))) {
    shutdownAnalysisWorker();
  }
  assertAnalysisWorkerMemoryAvailable(process.env.KLAURO_ANALYSIS_WORKER_SOCKET ? 64 : heap.heapMb, workerHandle?.child.pid);
  if (!workerHandle) {
    workerHandle = spawnAnalysisWorker(heap);
  }
  clearWorkerIdleTimer(workerHandle);
  return workerHandle;
}

export function prewarmAnalysisWorker(): void {
  if (analysisRunsInProcess()) return;
  try {
    ensureAnalysisWorker();
  } catch (error) {
    if (!(error instanceof AnalysisMemoryCapacityError)) throw error;
    console.error(`[Klauro] Worker prewarm deferred: ${error.message}`);
  }
}

export function shutdownAnalysisWorker(): void {
  if (!workerHandle) return;
  const handle = workerHandle;
  workerHandle = null;
  clearWorkerIdleTimer(handle);
  handle.child.removeAllListeners('exit');
  handle.child.kill();
  failPendingWorkerJobs(handle, null, 'SIGTERM', 'was shut down while a job was running');
}

async function stopIdleAnalysisWorkerForBackground(): Promise<void> {
  const handle = workerHandle;
  if (!handle || handle.pending.size > 0) return;
  workerHandle = null;
  clearWorkerIdleTimer(handle);
  const exited = new Promise<void>((resolve, reject) => {
    handle.child.once('exit', () => resolve());
    handle.child.once('error', reject);
  });
  if (handle.child.connected) handle.child.disconnect();
  if (handle.child.exitCode === null && handle.child.signalCode === null) handle.child.kill('SIGTERM');
  await exited;
}

registerHostedBackgroundPreflight(stopIdleAnalysisWorkerForBackground);

export function __analysisWorkerRunningForTests(): boolean {
  return workerHandle !== null;
}

function dispatchWorkerJob(projectPath: string, options: RunAnalysisOptions): Promise<AnalysisRunSummary> {
  const handle = ensureAnalysisWorker();
  const id = nextWorkerJobId++;
  return new Promise<AnalysisRunSummary>((resolve, reject) => {
    handle.pending.set(id, { projectPath, startedAtMs: Date.now(), resolve, reject });
    const request: WorkerAnalyzeRequest = {
      type: 'analyze',
      id,
      projectPath,
      forceFull: Boolean(options.forceFull),
      displayName: options.displayName,
      env: collectKlauroEnvSnapshot(),
    };
    handle.child.send(request, (error) => {
      if (error) {
        const job = handle.pending.get(id);
        if (job) {
          handle.pending.delete(id);
          reject(new Error(`Failed to dispatch analysis to worker: ${error.message}`));
        }
      }
    });
  });
}

export interface RunLayeredAnalysisOptions {
  displayName?: string;
  analysisFocus?: import('./analysis-focus').AnalysisFocus;
  repoFacts?: import('./remote-source').RepoFacts;
  repoFactsUnavailable?: boolean;
  onPhase?: (event: LayeredJobPhaseEvent) => void;
  forceAiRefresh?: boolean;
  forceFullRebuild?: boolean;
  admission?: HostedAnalysisTicket;
  onAdmissionUpdate?: (metadata: HostedAnalysisAdmissionMetadata) => void;
}

function dispatchLayeredWorkerJob(projectPath: string, options: RunLayeredAnalysisOptions): Promise<LayeredRunSummary> {
  const handle = ensureAnalysisWorker();
  const id = nextWorkerJobId++;
  return new Promise<LayeredRunSummary>((resolve, reject) => {
    const startedAtMs = Date.now();
    const job: PendingWorkerJob<LayeredRunSummary> = {
      projectPath,
      startedAtMs,
      resolve,
      reject,
      onPhase: options.onPhase,
      lastProgressAtMs: startedAtMs,
      lastProgressSequence: 0,
      lastProgressPhase: 'dispatched',
    };
    const stallMs = getAnalysisStallMs();
    job.stallTimer = setInterval(() => {
      const active = handle.pending.get(id);
      if (!active) return;
      const idleMs = Date.now() - (active.lastProgressAtMs ?? active.startedAtMs);
      if (idleMs < stallMs) return;

      handle.pending.delete(id);
      if (active.stallTimer) clearInterval(active.stallTimer);
      const message =
        `analysis-stalled: worker for ${projectPath} made no monotonic progress for ${idleMs}ms ` +
        `(last phase: ${active.lastProgressPhase ?? 'unknown'}, sequence: ${active.lastProgressSequence ?? 0}). ` +
        `Elapsed time alone is not failure; this retryable failure is based on a stopped progress counter. ` +
        `The last durable analysis checkpoint remains authoritative.`;
      try {
        finalizeWorkerRunFailure(projectPath, active.startedAtMs, message);
      } catch {

      }
      active.reject(new Error(message));
      if (workerHandle === handle) workerHandle = null;
      handle.child.kill('SIGKILL');
    }, Math.max(100, Math.min(30_000, Math.floor(stallMs / 4))));
    job.stallTimer.unref();
    handle.pending.set(id, job);
    const envSnapshot = collectKlauroEnvSnapshot();
    if (options.forceAiRefresh) envSnapshot.KLAURO_FORCE_AI_REFRESH = '1';
    const request: WorkerLayeredRequest = {
      type: 'layered',
      id,
      projectPath,
      displayName: options.displayName,
      env: envSnapshot,
      analysisFocus: options.analysisFocus,
      repoFacts: options.repoFacts,
      repoFactsUnavailable: options.repoFactsUnavailable,
      forceFullRebuild: options.forceFullRebuild,
    };
    handle.child.send(request, (error) => {
      if (error) {
        const job = handle.pending.get(id);
        if (job) {
          handle.pending.delete(id);
          reject(new Error(`Failed to dispatch layered analysis to worker: ${error.message}`));
        }
      }
    });
  });
}





async function withOuterWorkerWatchdog<T>(
  projectPath: string,
  run: () => Promise<T>
): Promise<T> {
  const startedAtMs = Date.now();
  const watchdogMs = getAnalysisWatchdogMs();
  const timer = setTimeout(() => {
    const elapsedMinutes = Math.round((Date.now() - startedAtMs) / 60_000);
    console.error(
      `[Klauro] SLOW ANALYSIS: ${projectPath} (worker-dispatched) has been running ${elapsedMinutes}m, ` +
      `exceeding KLAURO_ANALYSIS_WATCHDOG_MS=${watchdogMs}ms. The worker remains authoritative and in progress.`
    );
  }, watchdogMs);
  timer.unref();
  try {
    return await run();
  } finally {
    clearTimeout(timer);
  }
}

















function queueWorkerJob<T>(
  projectPath: string,
  label: string,
  dispatch: () => Promise<T>,
  admission?: HostedAnalysisTicket,
  onAdmissionUpdate?: (metadata: HostedAnalysisAdmissionMetadata) => void,
): Promise<T> {
  const queuedAt = Date.now();
  const ticket = admission ?? reserveHostedAnalysisOrThrow();
  return executeHostedAnalysis(ticket, () => withHostedForegroundPermit(async () => {
    const queueWaitMs = Date.now() - queuedAt;
    const dispatchedAt = Date.now();
    const endForegroundAnalysis = beginForegroundAnalysis();
    const report = (outcome: string): void => {
      console.error(
        `[Klauro] analysis pipeline (${label}, ${outcome}): queue_wait=${queueWaitMs}ms ` +
        `worker=${Date.now() - dispatchedAt}ms total=${Date.now() - queuedAt}ms`,
      );
    };
    return withOuterWorkerWatchdog(projectPath, dispatch).then(
      result => { report('ok'); return result; },


      error => { report('FAILED'); throw error; },
    ).finally(endForegroundAnalysis);
  }), onAdmissionUpdate);
}

export async function runAnalysis(projectPath: string, options: RunAnalysisOptions = {}): Promise<AnalysisRunSummary> {
  if (analysisRunsInProcess()) {
    return runAnalysisInProcess(projectPath, options);
  }
  return queueWorkerJob(projectPath, 'analyze', () => dispatchWorkerJob(projectPath, options));
}












export async function runLayeredAnalysis(
  projectPath: string,
  options: RunLayeredAnalysisOptions = {},
): Promise<LayeredRunSummary> {
  if (analysisRunsInProcess()) {
    const previousForceAiRefresh = process.env.KLAURO_FORCE_AI_REFRESH;
    if (options.forceAiRefresh) process.env.KLAURO_FORCE_AI_REFRESH = '1';
    else delete process.env.KLAURO_FORCE_AI_REFRESH;
    try {
      const { withAnalysisFocus } = await import('./analysis-focus.js');
      return await withAnalysisFocus(options.analysisFocus, async () => {
      const layered = await analyzeProjectLayered(projectPath, options.displayName, undefined, options.forceFullRebuild);
      try {
        await layered.l0;
        options.onPhase?.({ phase: 'l0', status: 'succeeded' });
      } catch (error) {
        options.onPhase?.({ phase: 'l0', status: 'failed', error: error instanceof Error ? error.message : String(error) });
      }
      let deferred: DeferredAnalysisResult;
      try {
        deferred = await layered.rest;
        const { applyLayeredAnalysisMetadata } = await import('./layered-analysis-metadata.js');
        applyLayeredAnalysisMetadata(deferred.output, options);
        options.onPhase?.({ phase: 'rest', status: 'succeeded' });
      } catch (error) {
        options.onPhase?.({ phase: 'rest', status: 'failed', error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
      const enrichmentPersistsOutput = deferred.output.ai_enrichment === 'pending';
      await deferred.enrichment.catch(() => undefined);
      if ((options.repoFacts || options.repoFactsUnavailable) && !enrichmentPersistsOutput) await saveAnalysis(projectPath, deferred.output, 'main', { deferSegmentedWrite: true });
      options.onPhase?.({
        phase: 'enrichment',
        ...resolveLayeredEnrichmentPhase(deferred.output),
      });
      return summarizeLayeredAnalysis(projectPath, deferred.output);
      });
    } finally {
      if (previousForceAiRefresh === undefined) delete process.env.KLAURO_FORCE_AI_REFRESH;
      else process.env.KLAURO_FORCE_AI_REFRESH = previousForceAiRefresh;
    }
  }
  const run = queueWorkerJob(
    projectPath,
    'layered',
    () => dispatchLayeredWorkerJob(projectPath, options),
    options.admission,
    options.onAdmissionUpdate,
  );
  return run;
}
