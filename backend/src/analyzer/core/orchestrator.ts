import { BaseAnalyzer, CASAnalysisResult, CASNode, CASEdge, AnalysisContext, FileAnalysisContext } from './base-analyzer';
import {
  CASOutput,
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
  CASExternalService,
  CASEntryPoint,
  CASExitPoint,
  CASIntent,
  CASFlowSummary,
  CASChangeRisk,
  CASChangeRiskSummary,
  CASDataEntity,
  CASDataSummary,
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
  CASWorkflow,
  CASWorkflowGraph,
  CASDomainConcept,
  EnhancedSystemPurpose,
  CASFlowGraph,
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
  CASCrossRepositoryLink,
  CASMethodCall,
  CASDecorator,
  CASDocumentationSummary,
  CASTodoSummary,
  CASImplementationHealth,
  CASSecurityContext,
  CASCallGraph,
  CASNodePerspective,
  CASLibrary,
  IncrementalState,
  ChangeSet,
  FileAnalysisRecord,
  ChangeReport,
  FileAnalysisResult,
  INCREMENTAL_STATE_VERSION
} from '../../types/cas.types';
import { ChangeDetector } from './change-detector';
import { CallGraphBuilder } from './call-graph-builder';
import { DomainExtractor } from './domain-extractor';
import { WorkflowDetector } from './workflow-detector';
import { CapabilityDetector } from './capability-detector';
import { CallChainAnalyzer } from './call-chain-analyzer';
import { CapabilityDependencyBuilder } from './capability-dependency-builder';
import { FlowScorer } from './flow-scorer';
import { FlowGraphBuilder } from './flow-graph-builder';
import { GitAnalyzer } from './git-analyzer';

export type { CASOutput } from '../../types/cas.types';
import * as fs from 'fs-extra';
import { glob } from 'glob';
import * as path from 'path';

export interface AnalyzerRegistration {
  id: string;
  name: string;
  type: 'language' | 'framework' | 'library' | 'pattern';
  version: string;
  detectPatterns: {
    files?: string[];
    dependencies?: string[];
    imports?: string[];
    content?: RegExp[];
  };
  requires?: string[];
  enhances?: string[];
  analyzer: BaseAnalyzer;
}

export interface IncrementalAnalysisOptions {
  loadCache?: (contentHash: string) => Promise<FileAnalysisResult | null>;
  saveCache?: (contentHash: string, result: FileAnalysisResult) => Promise<void>;
}

export class AnalyzerOrchestrator {
  private analyzers: Map<string, AnalyzerRegistration> = new Map();
  private projectRoots: string[] = [];
  private analyzerRootMap: Map<string, string> = new Map();

  registerAnalyzer(registration: AnalyzerRegistration): void {
    this.analyzers.set(registration.id, registration);
  }

  private async discoverProjectRoots(projectPath: string): Promise<string[]> {
    const manifestPatterns = [
      '**/package.json',
      '**/requirements.txt',
      '**/pom.xml',
      '**/Cargo.toml',
      '**/composer.json',
      '**/*.csproj',
      '**/*.sln',
      '**/go.mod'
    ];

    const ignorePatterns = [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.git/**',
      '**/target/**',
      '**/vendor/**',
      '**/__pycache__/**',
      '**/.venv/**',
      '**/venv/**'
    ];

    const rootSet = new Set<string>();

    for (const pattern of manifestPatterns) {
      try {
        const matches = await glob(pattern, {
          cwd: projectPath,
          ignore: ignorePatterns
        });
        for (const match of matches) {
          const absolutePath = path.join(projectPath, path.dirname(match));
          rootSet.add(absolutePath);
        }
      } catch {
      }
    }

    return Array.from(rootSet);
  }

  async detectAnalyzers(projectPath: string): Promise<AnalyzerRegistration[]> {
    this.projectRoots = await this.discoverProjectRoots(projectPath);
    this.analyzerRootMap.clear();

    const detected: AnalyzerRegistration[] = [];

    for (const registration of this.analyzers.values()) {
      if (await this.shouldUseAnalyzer(projectPath, registration)) {
        detected.push(registration);
      }
    }

    return this.orderAnalyzers(detected);
  }

  async orchestrateAnalysis(projectPath: string): Promise<CASOutput> {
    const startTime = Date.now();
    const analysisId = `analysis_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const timings: Record<string, number> = {};
    const logTiming = (phase: string, start: number) => {
      timings[phase] = Date.now() - start;
    };

    let phaseStart = Date.now();
    const detectedAnalyzers = await this.detectAnalyzers(projectPath);
    logTiming('detectAnalyzers', phaseStart);
    const context: AnalysisContext = {
      projectPath
    };

    const allNodes: CASNode[] = [];
    const allEdges: CASEdge[] = [];
    const allEntryPoints: any[] = [];
    const allExitPoints: any[] = [];
    const allLibraries: any[] = [];
    const allBehaviors: CASBehavior[] = [];
    const allPatterns: CASPattern[] = [];
    const allTags: CASTag[] = [];
    const allPerspectives: CASPerspective[] = [];
    const categories: CASCategories = {};
    const contributions: any[] = [];
    const analysisErrors: CASAnalysisError[] = [];

    const accumulators = {
      allNodes, allEdges, allEntryPoints, allExitPoints,
      allBehaviors, allPatterns, allTags, allPerspectives,
      allLibraries, categories, contributions, analysisErrors
    };

    const languageAnalyzers = detectedAnalyzers.filter(r => r.type === 'language');
    const parallelAnalyzers = detectedAnalyzers.filter(r => r.type === 'framework' || r.type === 'library');
    const patternAnalyzers = detectedAnalyzers.filter(r => r.type === 'pattern');

    phaseStart = Date.now();
    for (const registration of languageAnalyzers) {
      try {
        const langStart = Date.now();
        await this.runAnalyzer(registration, context, projectPath, accumulators);
        logTiming(`language_${registration.id}`, langStart);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error running analyzer ${registration.id}:`, error);
        analysisErrors.push({
          severity: 'error',
          code: 'ANALYZER_FAILURE',
          message: `${registration.name} failed: ${message}`,
          analyzer: registration.id,
          recoverable: true
        });
      }
    }
    logTiming('languageAnalyzers', phaseStart);

    phaseStart = Date.now();
    if (parallelAnalyzers.length > 0) {
      const languageSnapshot: CASContribution = {
        nodes: [...allNodes],
        edges: [...allEdges],
        entry_points: [...allEntryPoints],
        exit_points: [...allExitPoints],
        analyzer_metadata: {
          analyzer_id: 'merged',
          analyzer_name: 'Merged Analysis',
          version: '1.0.0',
          contribution_type: 'pattern' as const,
          nodes_contributed: allNodes.length,
          edges_contributed: allEdges.length,
          contributed_entry_points: allEntryPoints.length,
          contributed_exit_points: allExitPoints.length
        }
      };

      const parallelResults = await Promise.allSettled(
        parallelAnalyzers.map(async (registration) => {
          const analyzerStartTime = Date.now();
          const matchedRoot = this.analyzerRootMap.get(registration.id) || projectPath;

          const analyzerContext: AnalysisContext = {
            ...context,
            projectPath: matchedRoot,
            existingAnalysis: [languageSnapshot]
          };

          const result = await registration.analyzer.analyze(analyzerContext);
          const executionTime = Date.now() - analyzerStartTime;

          if (matchedRoot !== projectPath) {
            const relPrefix = path.relative(projectPath, matchedRoot);
            this.normalizeFilePaths(result, relPrefix);
          }

          return { registration, result, executionTime };
        })
      );

      const successfulResults = parallelResults
        .filter((r): r is PromiseFulfilledResult<{ registration: AnalyzerRegistration; result: CASContribution; executionTime: number }> =>
          r.status === 'fulfilled'
        )
        .map(r => r.value);

      successfulResults.sort((a, b) => a.registration.id.localeCompare(b.registration.id));

      parallelResults.forEach((r, i) => {
        if (r.status === 'rejected') {
          const message = r.reason instanceof Error ? r.reason.message : String(r.reason);
          console.error(`Error running analyzer ${parallelAnalyzers[i].id}:`, r.reason);
          analysisErrors.push({
            severity: 'error',
            code: 'ANALYZER_FAILURE',
            message: `${parallelAnalyzers[i].name} failed: ${message}`,
            analyzer: parallelAnalyzers[i].id,
            recoverable: true
          });
        }
      });

      for (const { registration, result, executionTime } of successfulResults) {
        this.mergeAnalysisResult(
          { allNodes, allEdges, allEntryPoints, allExitPoints },
          result
        );

        if (result.behaviors) allBehaviors.push(...result.behaviors);
        if (result.patterns) allPatterns.push(...result.patterns);
        if (result.categories) this.mergeCategories(categories, result.categories);
        if (result.tags) allTags.push(...result.tags);
        if (result.perspectives) allPerspectives.push(...result.perspectives);

        const analyzerMeta = result.analyzer_metadata || {};
        contributions.push({
          analyzer_id: registration.id,
          analyzer_name: registration.name,
          analyzer_version: registration.version,
          analyzer_type: registration.type,
          contribution_type: registration.type,
          execution_time_ms: executionTime,
          nodes_created: result.nodes?.length || 0,
          edges_created: result.edges?.length || 0,
          confidence: 1.0,
          contributed_categories: result.categories ? Object.keys(result.categories).length : 0,
          provided_perspectives: result.provided_perspectives || [],
          framework_specific: analyzerMeta.frameworks_detected || analyzerMeta.crates || undefined,
          application_type: analyzerMeta.application_type,
          project_name: analyzerMeta.project_name,
          project_version: analyzerMeta.project_version
        });

        if (result.libraries) {
          allLibraries.push(...result.libraries);
        }
      }
    }

    for (const registration of patternAnalyzers) {
      try {
        await this.runAnalyzer(registration, context, projectPath, accumulators);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error running analyzer ${registration.id}:`, error);
        analysisErrors.push({
          severity: 'error',
          code: 'ANALYZER_FAILURE',
          message: `${registration.name} failed: ${message}`,
          analyzer: registration.id,
          recoverable: true
        });
      }
    }
    logTiming('frameworkAnalyzers', phaseStart);

    phaseStart = Date.now();
    this.linkRouteHandlers(allNodes, allEdges, allEntryPoints);
    logTiming('pp_linkRouteHandlers', phaseStart);

    phaseStart = Date.now();
    const systemName = path.basename(projectPath);
    const progressiveLevels = this.buildProgressiveLevels(allNodes, categories);
    logTiming('pp_progressiveLevels', phaseStart);

    phaseStart = Date.now();
    const index = this.buildIndex(allNodes, allEntryPoints, allExitPoints, allPerspectives);
    logTiming('pp_buildIndex', phaseStart);

    if (allLibraries.length === 0) {
      const detectedLibraries = this.detectLibrariesFromManifests(projectPath);
      allLibraries.push(...detectedLibraries);
    }

    phaseStart = Date.now();
    const architectureSummary = this.buildArchitectureSummary(allNodes, allEntryPoints, allExitPoints, contributions);
    const routeTable = this.buildRouteTable(allEntryPoints);
    const databaseSchema = this.buildDatabaseSchema(allNodes, allLibraries, projectPath);
    const externalServices = this.buildExternalServices(allNodes, allExitPoints, allLibraries);
    logTiming('pp_architecture', phaseStart);

    logTiming('pp_detectPatterns', Date.now());

    phaseStart = Date.now();
    const intents = this.buildIntents(allNodes);
    logTiming('pp_buildIntents', phaseStart);

    phaseStart = Date.now();
    const flowSummary = this.buildFlowSummary(allNodes, allEntryPoints);
    const dataEntities = this.buildDataEntities(allNodes, allEdges);
    const dataSummary = this.buildDataSummary(dataEntities, allNodes);
    const securityBoundaries = this.buildSecurityBoundaries(allNodes, allEntryPoints);
    const securitySummary = this.buildSecuritySummary(securityBoundaries, allNodes);
    logTiming('pp_dataAndSecurity', phaseStart);

    phaseStart = Date.now();
    const gitAnalyzer = new GitAnalyzer(projectPath);
    let changeRisks: CASChangeRisk[] = [];
    let temporalStability: CASTemporalStability[] = [];

    if (gitAnalyzer.isAvailable()) {
      const filePathsForGit = allNodes
        .filter((n): n is CASNode & { source: { file: string } } => !!n.source?.file)
        .map(n => n.source.file);

      if (filePathsForGit.length <= 500) {
        gitAnalyzer.preloadAllFileMetrics(filePathsForGit);
        changeRisks = this.buildChangeRisks(allNodes, allEdges, allEntryPoints, gitAnalyzer);
        temporalStability = this.buildTemporalStability(allNodes, gitAnalyzer);
      }
    }
    logTiming('pp_gitAnalysis', phaseStart);

    phaseStart = Date.now();
    const changeRiskSummary = this.buildChangeRiskSummary(changeRisks);
    const stabilitySummary = this.buildStabilitySummary(temporalStability);
    const systemCapabilities = this.buildSystemCapabilities(allEntryPoints, dataEntities, allNodes, allEdges);
    const systemPurpose = this.inferSystemPurpose(allEntryPoints, dataEntities, systemCapabilities, allNodes);
    logTiming('pp_capabilities', phaseStart);

    phaseStart = Date.now();
    const callGraphBuilder = new CallGraphBuilder(allNodes, allEdges, allExitPoints);
    const callChains = this.buildCallChains(allNodes, allEdges, allEntryPoints, allExitPoints, callGraphBuilder);
    logTiming('pp_callGraph', phaseStart);

    phaseStart = Date.now();
    this.enrichNodeCallGraphs(allNodes, callGraphBuilder, allEntryPoints, allExitPoints);
    this.deriveParentFromContainsEdges(allNodes, allEdges);
    this.enrichNodePerspectives(allNodes, allPerspectives);
    logTiming('pp_enrichNodes', phaseStart);

    phaseStart = Date.now();
    const flowCoverage = this.buildFlowCoverage(allNodes, allEntryPoints, callChains);
    const testGaps = this.buildTestGaps(flowCoverage, allNodes);
    logTiming('pp_flowCoverage', phaseStart);

    phaseStart = Date.now();
    const domainExtractor = new DomainExtractor();
    const domainConcepts = domainExtractor.extract(allNodes, allEntryPoints, dataEntities);
    logTiming('pp_domainConcepts', phaseStart);

    phaseStart = Date.now();
    const workflowDetector = new WorkflowDetector();
    const workflows = workflowDetector.detectWorkflows(allEntryPoints, callChains, allNodes, allEdges, allExitPoints);
    workflowDetector.classifyWorkflows(workflows, domainConcepts);
    const workflowGraph = workflowDetector.buildDependencyGraph(workflows, callChains, allNodes);
    logTiming('pp_workflows', phaseStart);

    phaseStart = Date.now();
    const flowGraph = this.buildFlowGraph(
      allEntryPoints,
      callChains,
      allNodes,
      allEdges,
      domainConcepts,
      dataEntities,
      databaseSchema,
      systemPurpose
    );
    logTiming('pp_flowGraph', phaseStart);

    phaseStart = Date.now();
    const enhancedChangeRisks = this.enhanceChangeRisks(changeRisks, callGraphBuilder, callChains, allEntryPoints);
    const enhancedFlowSummary = this.buildEnhancedFlowSummary(callChains, allEntryPoints);
    logTiming('pp_enhanceRisks', phaseStart);

    phaseStart = Date.now();
    const entryPointSummary = this.summarizeEntryPoints(allEntryPoints);
    const frameworkNames = contributions
      .filter(c => c.analyzer_type === 'framework')
      .map(c => c.analyzer_name.replace(' Analyzer', ''));
    const dbEntityNames = databaseSchema.entities.map(e => e.name);
    const externalServiceNames = externalServices.map(svc => svc.name);

    const enhancedSystemPurpose = this.buildEnhancedSystemPurpose(
      systemPurpose,
      domainConcepts,
      workflows,
      workflowGraph,
      domainExtractor,
      dbEntityNames,
      entryPointSummary,
      frameworkNames,
      externalServiceNames,
      flowGraph
    );
    logTiming('pp_enhancedPurpose', phaseStart);

    phaseStart = Date.now();
    const methodCalls = this.buildMethodCalls(allNodes, allEdges);
    logTiming('pp_methodCalls', phaseStart);

    phaseStart = Date.now();
    const allDecorators = this.buildAllDecorators(allNodes);
    const documentationSummary = this.buildDocumentationSummary(allNodes);
    const todosSummary = this.buildTodosSummary(allNodes);
    const implementationHealth = this.buildImplementationHealth(allNodes);
    const securityContexts = this.buildSecurityContexts(allNodes, allEntryPoints, allEdges);
    const configuration = this.buildAllConfiguration(allNodes, allExitPoints, externalServices, projectPath);
    logTiming('pp_finalMetadata', phaseStart);

    phaseStart = Date.now();
    const testSuites = this.buildTestSuites(allNodes, allEntryPoints, projectPath);
    const mocks = this.buildMocks(allNodes);
    const fixtures = this.buildFixtures(allNodes);
    const testSummary = this.buildTestSummary(allNodes, allEntryPoints);
    const behavioralInvariants = this.buildBehavioralInvariants(allNodes, allEdges, allEntryPoints, databaseSchema, dataEntities, securityBoundaries, testSuites, projectPath);
    const behavioralInvariantSummary = this.buildBehavioralInvariantSummary(behavioralInvariants);
    logTiming('pp_testData', phaseStart);

    phaseStart = Date.now();
    const runtime = this.buildRuntime(projectPath, allEntryPoints, allExitPoints, externalServices, configuration, callChains);
    const repositoryLinks = this.buildRepositoryLinks(projectPath, allNodes, allEntryPoints, allExitPoints, externalServices, allLibraries, databaseSchema, configuration);
    const runtimeStaticLinks = this.buildRuntimeStaticLinks(allNodes, allEntryPoints, allExitPoints, callChains, externalServices);
    const analysisFacts = this.buildAnalysisFacts(
      allNodes,
      allEdges,
      allEntryPoints,
      allExitPoints,
      externalServices,
      workflows,
      systemCapabilities,
      runtimeStaticLinks,
      repositoryLinks,
      contributions
    );
    const validation = this.buildValidation(allNodes, allEdges, allEntryPoints, allExitPoints, runtimeStaticLinks, analysisFacts);
    logTiming('pp_traceability', phaseStart);

    const totalTime = Date.now() - startTime;
    console.log(`[Unravl] Analysis completed in ${totalTime}ms. Breakdown:`, JSON.stringify(timings, null, 2));

    return {
      cas_version: '1.8.0',
      analysis_timestamp: new Date().toISOString(),
      analysis_id: analysisId,
      system: {
        id: `system_${systemName}`,
        name: systemName,
        type: this.determineSystemType(allNodes) as 'monorepo' | 'application' | 'library' | 'service' | 'package',
        root_path: projectPath,
        technologies: this.extractTechnologies(contributions, allLibraries),
        quality: this.calculateQualityMetrics(allNodes)
      },
      architecture_summary: architectureSummary,
      route_table: routeTable.length > 0 ? routeTable : undefined,
      database_schema: databaseSchema.entities.length > 0 ? databaseSchema : undefined,
      nodes: allNodes,
      edges: allEdges,
      entry_points: allEntryPoints,
      exit_points: allExitPoints,
      behaviors: allBehaviors.length > 0 ? allBehaviors : undefined,
      patterns: allPatterns.length > 0 ? allPatterns : undefined,
      categories: Object.keys(categories).length > 0 ? categories : undefined,
      tags: allTags.length > 0 ? allTags : undefined,
      perspectives: allPerspectives.length > 0 ? allPerspectives : undefined,
      index,
      external_services: externalServices.length > 0 ? externalServices : undefined,
      repository_links: repositoryLinks.length > 0 ? repositoryLinks : undefined,
      cross_repository_links: repositoryLinks.length > 0 ? repositoryLinks : undefined,
      libraries: allLibraries.length > 0 ? allLibraries : undefined,
      analyzer_contributions: contributions,
      progressive_levels: progressiveLevels,
      intents: intents.length > 0 ? intents : undefined,
      change_risk_summary: changeRiskSummary,
      data_entities: dataEntities.length > 0 ? dataEntities : undefined,
      data_summary: dataSummary,
      behavioral_invariants: behavioralInvariants.length > 0 ? behavioralInvariants : undefined,
      behavioral_invariant_summary: behavioralInvariants.length > 0 ? behavioralInvariantSummary : undefined,
      security_boundaries: securityBoundaries.length > 0 ? securityBoundaries : undefined,
      security_summary: securitySummary,
      flow_coverage: flowCoverage.length > 0 ? flowCoverage : undefined,
      test_gaps: testGaps.length > 0 ? testGaps : undefined,
      temporal_stability: temporalStability.length > 0 ? temporalStability : undefined,
      stability_summary: stabilitySummary,
      system_capabilities: systemCapabilities.length > 0 ? systemCapabilities : undefined,
      system_purpose: systemPurpose,
      call_chains: callChains.length > 0 ? callChains : undefined,
      workflows: workflows.length > 0 ? workflows : undefined,
      workflow_graph: workflowGraph,
      domain_concepts: domainConcepts.length > 0 ? domainConcepts : undefined,
      enhanced_system_purpose: enhancedSystemPurpose,
      flow_graph: flowGraph,
      flow_summary: enhancedFlowSummary,
      change_risks: enhancedChangeRisks.length > 0 ? enhancedChangeRisks : undefined,
      method_calls: methodCalls.length > 0 ? methodCalls : undefined,
      decorators: allDecorators.length > 0 ? allDecorators : undefined,
      documentation_summary: documentationSummary,
      todos_summary: todosSummary,
      implementation_health: implementationHealth,
      security_contexts: securityContexts.length > 0 ? securityContexts : undefined,
      configuration,
      runtime,
      runtime_static_links: runtimeStaticLinks.length > 0 ? runtimeStaticLinks : undefined,
      analysis_facts: analysisFacts.length > 0 ? analysisFacts : undefined,
      analysis_errors: analysisErrors,
      validation,
      test_suites: testSuites,
      mocks: mocks,
      fixtures: fixtures,
      test_summary: testSummary
    } as CASOutput;
  }

  async orchestrateIncrementalAnalysis(
    projectPath: string,
    previousOutput: CASOutput,
    previousState: IncrementalState | null,
    options?: IncrementalAnalysisOptions
  ): Promise<{
    output: CASOutput;
    state: IncrementalState;
    changeReport: ChangeReport;
    wasFullRebuild: boolean;
  }> {
    const changeDetector = new ChangeDetector(projectPath);
    const changeSet = await changeDetector.detectChanges(previousState);

    if (changeSet.requiresFullRebuild || !previousState) {
      const output = await this.orchestrateAnalysis(projectPath);
      const state = this.buildIncrementalState(projectPath, output, changeDetector);
      const changeReport = this.buildChangeReport(previousOutput, output, changeSet);
      return { output, state, changeReport, wasFullRebuild: true };
    }

    const totalChanges = changeSet.added.length + changeSet.modified.length + changeSet.deleted.length;
    if (totalChanges === 0) {
      const state: IncrementalState = {
        ...previousState,
        lastAnalysisTimestamp: Date.now(),
        gitCommitHash: changeDetector.getCurrentGitCommit()
      };
      const changeReport = this.buildChangeReport(previousOutput, previousOutput, changeSet);
      return { output: previousOutput, state, changeReport, wasFullRebuild: false };
    }

    const incrementalResult = await this.runIncrementalAnalysis(
      projectPath,
      previousOutput,
      previousState,
      changeSet,
      options
    );

    const updatedState = this.updateIncrementalState(
      previousState,
      incrementalResult,
      changeSet,
      changeDetector
    );

    const changeReport = this.buildChangeReport(
      previousOutput,
      incrementalResult.output,
      changeSet
    );

    return {
      output: incrementalResult.output,
      state: updatedState,
      changeReport,
      wasFullRebuild: false
    };
  }

  private async runIncrementalAnalysis(
    projectPath: string,
    previousOutput: CASOutput,
    previousState: IncrementalState,
    changeSet: ChangeSet,
    options?: IncrementalAnalysisOptions
  ): Promise<{ output: CASOutput; fileResults: Map<string, FileAnalysisResult> }> {
    const detectedAnalyzers = await this.detectAnalyzers(projectPath);
    const incrementalAnalyzers = detectedAnalyzers.filter(
      r => r.analyzer.supportsIncrementalAnalysis?.() && r.analyzer.analyzeFileSingle
    );

    if (incrementalAnalyzers.length === 0) {
      const output = await this.orchestrateAnalysis(projectPath);
      return { output, fileResults: new Map() };
    }

    const allNodes = [...previousOutput.nodes];
    const allEdges = [...previousOutput.edges];
    const allEntryPoints = [...(previousOutput.entry_points || [])];
    const allExitPoints = [...(previousOutput.exit_points || [])];

    const deletedNodeIds = new Set<string>();
    const deletedEdgeIds = new Set<string>();
    const deletedEntryPointIds = new Set<string>();
    const deletedExitPointIds = new Set<string>();

    for (const deletedFile of changeSet.deleted) {
      const record = previousState.files[deletedFile];
      if (record) {
        record.nodeIds.forEach(id => deletedNodeIds.add(id));
        record.edgeIds.forEach(id => deletedEdgeIds.add(id));
        record.entryPointIds.forEach(id => deletedEntryPointIds.add(id));
        record.exitPointIds.forEach(id => deletedExitPointIds.add(id));
      }
    }

    for (const modifiedFile of changeSet.modified) {
      const record = previousState.files[modifiedFile];
      if (record) {
        record.nodeIds.forEach(id => deletedNodeIds.add(id));
        record.edgeIds.forEach(id => deletedEdgeIds.add(id));
        record.entryPointIds.forEach(id => deletedEntryPointIds.add(id));
        record.exitPointIds.forEach(id => deletedExitPointIds.add(id));
      }
    }

    const filteredNodes = allNodes.filter(n => !deletedNodeIds.has(n.id));
    const filteredEdges = allEdges.filter(e => !deletedEdgeIds.has(e.id));
    const filteredEntryPoints = allEntryPoints.filter(ep => !deletedEntryPointIds.has(ep.id));
    const filteredExitPoints = allExitPoints.filter(ex => !deletedExitPointIds.has(ex.id));

    const filesToAnalyze = [...changeSet.added, ...changeSet.modified];
    const fileResults = new Map<string, FileAnalysisResult>();
    const BATCH_SIZE = 8;

    for (let i = 0; i < filesToAnalyze.length; i += BATCH_SIZE) {
      const batch = filesToAnalyze.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (relativePath) => {
          const fullPath = path.join(projectPath, relativePath);
          try {
            const stat = await fs.stat(fullPath);
            const content = await fs.readFile(fullPath, 'utf-8');
            const contentHash = this.computeContentHash(content);

            if (options?.loadCache) {
              const cached = await options.loadCache(contentHash);
              if (cached) {
                return { relativePath, result: cached, success: true };
              }
            }

            for (const registration of incrementalAnalyzers) {
              if (registration.analyzer.analyzeFileSingle) {
                const relevantFiles = await registration.analyzer.getRelevantFiles?.(projectPath) || [];
                if (relevantFiles.includes(relativePath)) {
                  const context: FileAnalysisContext = {
                    filePath: fullPath,
                    relativePath,
                    projectPath,
                    contentHash
                  };
                  const result = await registration.analyzer.analyzeFileSingle(context);

                  if (options?.saveCache && result) {
                    await options.saveCache(contentHash, result);
                  }

                  return { relativePath, result, success: true };
                }
              }
            }
            return { relativePath, result: null, success: false };
          } catch (error) {
            console.warn(`Failed to analyze file ${relativePath}:`, error);
            return { relativePath, result: null, success: false };
          }
        })
      );

      for (const { relativePath, result, success } of batchResults) {
        if (success && result) {
          fileResults.set(relativePath, result);
          filteredNodes.push(...result.nodes);
          filteredEdges.push(...result.edges);
          filteredEntryPoints.push(...result.entryPoints);
          filteredExitPoints.push(...result.exitPoints);
        }
      }
    }

    const rebuiltOutput = this.rebuildDerivedData(
      projectPath,
      filteredNodes,
      filteredEdges,
      filteredEntryPoints,
      filteredExitPoints,
      previousOutput
    );

    return { output: rebuiltOutput, fileResults };
  }

  private rebuildDerivedData(
    projectPath: string,
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[],
    previousOutput: CASOutput
  ): CASOutput {
    const gitAnalyzer = new GitAnalyzer(projectPath);
    const filePathsForGit = nodes
      .filter((n): n is CASNode & { source: { file: string } } => !!n.source?.file)
      .map(n => n.source.file);
    gitAnalyzer.preloadAllFileMetrics(filePathsForGit);

    const categories = previousOutput.categories || {};
    const progressiveLevels = this.buildProgressiveLevels(nodes, categories);
    const index = this.buildIndex(nodes, entryPoints, exitPoints, previousOutput.perspectives || []);

    const libraries = previousOutput.libraries || [];
    const architectureSummary = this.buildArchitectureSummary(
      nodes, entryPoints, exitPoints, previousOutput.analyzer_contributions
    );
    const routeTable = this.buildRouteTable(entryPoints);
    const databaseSchema = this.buildDatabaseSchema(nodes, libraries, projectPath);
    const externalServices = this.buildExternalServices(nodes, exitPoints, libraries);

    const detectedPatterns = this.detectPatterns(nodes, edges);
    const intents = this.buildIntents(nodes);
    const flowSummary = this.buildFlowSummary(nodes, entryPoints);
    const changeRisks = this.buildChangeRisks(nodes, edges, entryPoints, gitAnalyzer);
    const changeRiskSummary = this.buildChangeRiskSummary(changeRisks);
    const dataEntities = this.buildDataEntities(nodes, edges);
    const dataSummary = this.buildDataSummary(dataEntities, nodes);
    const securityBoundaries = this.buildSecurityBoundaries(nodes, entryPoints);
    const securitySummary = this.buildSecuritySummary(securityBoundaries, nodes);
    const temporalStability = this.buildTemporalStability(nodes, gitAnalyzer);
    const stabilitySummary = this.buildStabilitySummary(temporalStability);
    const testSuites = this.buildTestSuites(nodes, entryPoints, projectPath);
    const behavioralInvariants = this.buildBehavioralInvariants(nodes, edges, entryPoints, databaseSchema, dataEntities, securityBoundaries, testSuites, projectPath);
    const behavioralInvariantSummary = this.buildBehavioralInvariantSummary(behavioralInvariants);

    const systemCapabilities = this.buildSystemCapabilities(entryPoints, dataEntities, nodes, edges);
    const systemPurpose = this.inferSystemPurpose(entryPoints, dataEntities, systemCapabilities, nodes);

    const callGraphBuilder = new CallGraphBuilder(nodes, edges, exitPoints);
    const callChains = this.buildCallChains(nodes, edges, entryPoints, exitPoints, callGraphBuilder);

    this.enrichNodeCallGraphs(nodes, callGraphBuilder, entryPoints, exitPoints);
    this.deriveParentFromContainsEdges(nodes, edges);
    this.enrichNodePerspectives(nodes, previousOutput.perspectives || []);

    const flowCoverage = this.buildFlowCoverage(nodes, entryPoints, callChains);
    const testGaps = this.buildTestGaps(flowCoverage, nodes);

    const domainExtractor = new DomainExtractor();
    const domainConcepts = domainExtractor.extract(nodes, entryPoints, dataEntities);

    const workflowDetector = new WorkflowDetector();
    const workflows = workflowDetector.detectWorkflows(entryPoints, callChains, nodes, edges, exitPoints);
    workflowDetector.classifyWorkflows(workflows, domainConcepts);
    const workflowGraph = workflowDetector.buildDependencyGraph(workflows, callChains, nodes);

    const flowGraph = this.buildFlowGraph(
      entryPoints,
      callChains,
      nodes,
      edges,
      domainConcepts,
      dataEntities,
      databaseSchema,
      systemPurpose
    );

    const enhancedChangeRisks = this.enhanceChangeRisks(changeRisks, callGraphBuilder, callChains, entryPoints);
    const enhancedFlowSummary = this.buildEnhancedFlowSummary(callChains, entryPoints);
    const configuration = this.buildAllConfiguration(nodes, exitPoints, externalServices, projectPath);
    const runtime = this.buildRuntime(projectPath, entryPoints, exitPoints, externalServices, configuration, callChains);
    const repositoryLinks = this.buildRepositoryLinks(projectPath, nodes, entryPoints, exitPoints, externalServices, libraries, databaseSchema, configuration);
    const runtimeStaticLinks = this.buildRuntimeStaticLinks(nodes, entryPoints, exitPoints, callChains, externalServices);
    const analysisFacts = this.buildAnalysisFacts(
      nodes,
      edges,
      entryPoints,
      exitPoints,
      externalServices,
      workflows,
      systemCapabilities,
      runtimeStaticLinks,
      repositoryLinks,
      previousOutput.analyzer_contributions
    );
    const validation = this.buildValidation(nodes, edges, entryPoints, exitPoints, runtimeStaticLinks, analysisFacts);

    const systemName = path.basename(projectPath);
    const analysisId = `analysis_incr_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    return {
      ...previousOutput,
      analysis_timestamp: new Date().toISOString(),
      analysis_id: analysisId,
      nodes,
      edges,
      entry_points: entryPoints,
      exit_points: exitPoints,
      progressive_levels: progressiveLevels,
      index,
      architecture_summary: architectureSummary,
      route_table: routeTable.length > 0 ? routeTable : undefined,
      database_schema: databaseSchema.entities.length > 0 ? databaseSchema : undefined,
      external_services: externalServices.length > 0 ? externalServices : undefined,
      repository_links: repositoryLinks.length > 0 ? repositoryLinks : undefined,
      cross_repository_links: repositoryLinks.length > 0 ? repositoryLinks : undefined,
      patterns: detectedPatterns.length > 0 ? detectedPatterns : undefined,
      intents: intents.length > 0 ? intents : undefined,
      flow_summary: enhancedFlowSummary,
      change_risks: enhancedChangeRisks.length > 0 ? enhancedChangeRisks : undefined,
      change_risk_summary: changeRiskSummary,
      data_entities: dataEntities.length > 0 ? dataEntities : undefined,
      data_summary: dataSummary,
      behavioral_invariants: behavioralInvariants.length > 0 ? behavioralInvariants : undefined,
      behavioral_invariant_summary: behavioralInvariants.length > 0 ? behavioralInvariantSummary : undefined,
      security_boundaries: securityBoundaries.length > 0 ? securityBoundaries : undefined,
      security_summary: securitySummary,
      temporal_stability: temporalStability.length > 0 ? temporalStability : undefined,
      stability_summary: stabilitySummary,
      system_capabilities: systemCapabilities.length > 0 ? systemCapabilities : undefined,
      system_purpose: systemPurpose,
      call_chains: callChains.length > 0 ? callChains : undefined,
      flow_coverage: flowCoverage.length > 0 ? flowCoverage : undefined,
      test_gaps: testGaps.length > 0 ? testGaps : undefined,
      workflows: workflows.length > 0 ? workflows : undefined,
      workflow_graph: workflowGraph,
      domain_concepts: domainConcepts.length > 0 ? domainConcepts : undefined,
      flow_graph: flowGraph,
      configuration,
      runtime,
      runtime_static_links: runtimeStaticLinks.length > 0 ? runtimeStaticLinks : undefined,
      analysis_facts: analysisFacts.length > 0 ? analysisFacts : undefined,
      validation,
      test_suites: testSuites
    };
  }

  private buildIncrementalState(
    projectPath: string,
    output: CASOutput,
    changeDetector: ChangeDetector
  ): IncrementalState {
    const files: Record<string, FileAnalysisRecord> = {};

    const nodesByFile = new Map<string, CASNode[]>();
    const edgesByFile = new Map<string, CASEdge[]>();
    const entryPointsByFile = new Map<string, CASEntryPoint[]>();
    const exitPointsByFile = new Map<string, CASExitPoint[]>();

    for (const node of output.nodes) {
      if (node.source?.file) {
        const relativePath = path.isAbsolute(node.source.file)
          ? path.relative(projectPath, node.source.file)
          : node.source.file;
        if (!nodesByFile.has(relativePath)) {
          nodesByFile.set(relativePath, []);
        }
        nodesByFile.get(relativePath)!.push(node);
      }
    }

    for (const edge of output.edges) {
      const sourceNode = output.nodes.find(n => n.id === edge.source);
      if (sourceNode?.source?.file) {
        const relativePath = path.isAbsolute(sourceNode.source.file)
          ? path.relative(projectPath, sourceNode.source.file)
          : sourceNode.source.file;
        if (!edgesByFile.has(relativePath)) {
          edgesByFile.set(relativePath, []);
        }
        edgesByFile.get(relativePath)!.push(edge);
      }
    }

    for (const ep of output.entry_points || []) {
      const sourceNode = output.nodes.find(n => n.id === ep.source_node);
      if (sourceNode?.source?.file) {
        const relativePath = path.isAbsolute(sourceNode.source.file)
          ? path.relative(projectPath, sourceNode.source.file)
          : sourceNode.source.file;
        if (!entryPointsByFile.has(relativePath)) {
          entryPointsByFile.set(relativePath, []);
        }
        entryPointsByFile.get(relativePath)!.push(ep);
      }
    }

    for (const ex of output.exit_points || []) {
      const sourceNode = output.nodes.find(n => n.id === ex.source_node);
      if (sourceNode?.source?.file) {
        const relativePath = path.isAbsolute(sourceNode.source.file)
          ? path.relative(projectPath, sourceNode.source.file)
          : sourceNode.source.file;
        if (!exitPointsByFile.has(relativePath)) {
          exitPointsByFile.set(relativePath, []);
        }
        exitPointsByFile.get(relativePath)!.push(ex);
      }
    }

    for (const [filePath, fileNodes] of nodesByFile) {
      const fullPath = path.join(projectPath, filePath);
      try {
        const stat = fs.statSync(fullPath);
        const content = fs.readFileSync(fullPath, 'utf-8');
        const contentHash = this.computeContentHash(content);

        files[filePath] = {
          filePath,
          contentHash,
          mtimeMs: stat.mtimeMs,
          lastAnalyzed: new Date().toISOString(),
          analyzerId: 'typescript-javascript',
          nodeIds: fileNodes.map(n => n.id),
          edgeIds: (edgesByFile.get(filePath) || []).map(e => e.id),
          entryPointIds: (entryPointsByFile.get(filePath) || []).map(ep => ep.id),
          exitPointIds: (exitPointsByFile.get(filePath) || []).map(ex => ex.id),
          importedFiles: this.extractImportedFiles(fileNodes),
          exportedSymbols: this.extractExportedSymbols(fileNodes)
        };
      } catch {
      }
    }

    const analyzerVersions: Record<string, string> = {};
    for (const contribution of output.analyzer_contributions || []) {
      analyzerVersions[contribution.analyzer_id] = contribution.analyzer_version || '1.0.0';
    }

    return {
      version: INCREMENTAL_STATE_VERSION,
      projectPath,
      lastFullAnalysis: output.analysis_timestamp,
      lastAnalysisTimestamp: Date.now(),
      gitCommitHash: changeDetector.getCurrentGitCommit(),
      files,
      analyzerVersions
    };
  }

  private updateIncrementalState(
    previousState: IncrementalState,
    result: { output: CASOutput; fileResults: Map<string, FileAnalysisResult> },
    changeSet: ChangeSet,
    changeDetector: ChangeDetector
  ): IncrementalState {
    const files = { ...previousState.files };

    for (const deletedFile of changeSet.deleted) {
      delete files[deletedFile];
    }

    for (const [filePath, fileResult] of result.fileResults) {
      files[filePath] = {
        filePath: fileResult.filePath,
        contentHash: fileResult.contentHash,
        mtimeMs: fileResult.mtimeMs,
        lastAnalyzed: new Date().toISOString(),
        analyzerId: 'typescript-javascript',
        nodeIds: fileResult.nodes.map(n => n.id),
        edgeIds: fileResult.edges.map(e => e.id),
        entryPointIds: fileResult.entryPoints.map(ep => ep.id),
        exitPointIds: fileResult.exitPoints.map(ex => ex.id),
        importedFiles: fileResult.imports,
        exportedSymbols: fileResult.exports
      };
    }

    return {
      ...previousState,
      lastAnalysisTimestamp: Date.now(),
      gitCommitHash: changeDetector.getCurrentGitCommit(),
      files
    };
  }

  private buildSemanticChangeImpact(
    output: CASOutput,
    changedNodeIds: Set<string>,
    affectedEntryPointIds: Set<string>,
    affectedCallChainIds: Set<string>,
    changedEntryPoints: CASEntryPoint[],
    changedExitPoints: CASExitPoint[]
  ) {
    const affected_workflows = (output.workflows || [])
      .filter(workflow =>
        workflow.entry_points.some(id => affectedEntryPointIds.has(id)) ||
        workflow.call_chains.some(id => affectedCallChainIds.has(id)) ||
        workflow.services_used.some(id => changedNodeIds.has(id)) ||
        workflow.entities_touched.some(id => changedNodeIds.has(id))
      )
      .map(workflow => ({
        id: workflow.id,
        name: workflow.name,
        reason: 'Changed nodes or entry points participate in this workflow'
      }));

    const affected_capabilities = (output.system_capabilities || [])
      .filter(capability =>
        capability.operations.some(operation => affectedEntryPointIds.has(operation.entry_point_id)) ||
        capability.related_entities.some(entity => changedNodeIds.has(entity))
      )
      .map(capability => ({
        id: capability.id,
        name: capability.name,
        reason: 'Changed entry points or related entities participate in this capability'
      }));

    const affected_data_entities = (output.data_entities || [])
      .filter(entity => {
        const lifecycleNodes = [
          ...entity.lifecycle.created_by,
          ...entity.lifecycle.read_by,
          ...entity.lifecycle.updated_by,
          ...entity.lifecycle.deleted_by
        ];
        const transformationNodes = (entity.transformations || [])
          .flatMap(transformation => [transformation.from_node, transformation.to_node]);
        return [...lifecycleNodes, ...transformationNodes].some(nodeId => changedNodeIds.has(nodeId));
      })
      .map(entity => ({
        id: entity.id,
        name: entity.name,
        reason: 'Changed nodes participate in this entity lifecycle'
      }));

    const affected_runtime_links = (output.runtime_static_links || [])
      .filter(link =>
        link.instrumentation_points.some(nodeId => changedNodeIds.has(nodeId)) ||
        affectedEntryPointIds.has(link.static_id) ||
        affectedCallChainIds.has(link.static_id)
      )
      .map(link => ({
        id: link.id,
        runtime_signal: link.runtime_signal,
        reason: 'Changed nodes are runtime instrumentation points'
      }));

    const changed_contracts = [
      ...changedEntryPoints.map(entryPoint => ({
        id: entryPoint.id,
        type: 'entry-point' as const,
        name: entryPoint.name
      })),
      ...changedExitPoints.map(exitPoint => ({
        id: exitPoint.id,
        type: 'exit-point' as const,
        name: exitPoint.name
      }))
    ];

    const risk_reasons: string[] = [];
    if (affected_workflows.length > 0) risk_reasons.push(`${affected_workflows.length} workflow(s) affected`);
    if (affected_capabilities.length > 0) risk_reasons.push(`${affected_capabilities.length} capability/capabilities affected`);
    if (affected_data_entities.length > 0) risk_reasons.push(`${affected_data_entities.length} data entity/entities affected`);
    if (affected_runtime_links.length > 0) risk_reasons.push(`${affected_runtime_links.length} runtime signal(s) affected`);
    if (changed_contracts.length > 0) risk_reasons.push(`${changed_contracts.length} externally visible contract(s) changed`);

    return {
      affected_workflows,
      affected_capabilities,
      affected_data_entities,
      affected_runtime_links,
      changed_contracts,
      risk_reasons
    };
  }

  private buildChangeReport(
    previousOutput: CASOutput,
    currentOutput: CASOutput,
    changeSet: ChangeSet
  ): ChangeReport {
    const previousNodeIds = new Set(previousOutput.nodes.map(n => n.id));
    const currentNodeIds = new Set(currentOutput.nodes.map(n => n.id));

    const addedNodes = currentOutput.nodes.filter(n => !previousNodeIds.has(n.id));
    const deletedNodes = previousOutput.nodes.filter(n => !currentNodeIds.has(n.id));

    const modifiedNodes: Array<{ id: string; name: string; type?: string; file?: string; changes: string[] }> = [];
    for (const currentNode of currentOutput.nodes) {
      if (previousNodeIds.has(currentNode.id)) {
        const previousNode = previousOutput.nodes.find(n => n.id === currentNode.id);
        if (previousNode) {
          const changes: string[] = [];
          if (JSON.stringify(previousNode.metadata) !== JSON.stringify(currentNode.metadata)) {
            changes.push('metadata');
          }
          if (JSON.stringify(previousNode.signature) !== JSON.stringify(currentNode.signature)) {
            changes.push('signature');
          }
          if (previousNode.source?.line !== currentNode.source?.line) {
            changes.push('location');
          }
          if (changes.length > 0) {
              modifiedNodes.push({
                id: currentNode.id,
                name: currentNode.name,
                type: currentNode.type,
                file: currentNode.source?.file,
                changes
              });
          }
        }
      }
    }

    const previousEdgeIds = new Set(previousOutput.edges.map(e => e.id));
    const currentEdgeIds = new Set(currentOutput.edges.map(e => e.id));

    const addedEdges = currentOutput.edges.filter(e => !previousEdgeIds.has(e.id));
    const deletedEdges = previousOutput.edges.filter(e => !currentEdgeIds.has(e.id));

    const previousEntryPointIds = new Set((previousOutput.entry_points || []).map(ep => ep.id));
    const currentEntryPointIds = new Set((currentOutput.entry_points || []).map(ep => ep.id));
    const addedEntryPoints = (currentOutput.entry_points || []).filter(ep => !previousEntryPointIds.has(ep.id));
    const deletedEntryPoints = (previousOutput.entry_points || []).filter(ep => !currentEntryPointIds.has(ep.id));

    const previousExitPointIds = new Set((previousOutput.exit_points || []).map(ep => ep.id));
    const currentExitPointIds = new Set((currentOutput.exit_points || []).map(ep => ep.id));
    const addedExitPoints = (currentOutput.exit_points || []).filter(ep => !previousExitPointIds.has(ep.id));
    const deletedExitPoints = (previousOutput.exit_points || []).filter(ep => !currentExitPointIds.has(ep.id));

    const files = [
      ...changeSet.added.map(filePath => ({
        path: filePath,
        type: 'added' as const,
        linesAdded: 0,
        linesRemoved: 0
      })),
      ...changeSet.modified.map(filePath => ({
        path: filePath,
        type: 'modified' as const,
        linesAdded: 0,
        linesRemoved: 0
      })),
      ...changeSet.deleted.map(filePath => ({
        path: filePath,
        type: 'deleted' as const,
        linesAdded: 0,
        linesRemoved: 0
      }))
    ];

    const changedFiles = new Set([...changeSet.added, ...changeSet.modified]);
    const changedNodeIds = new Set([
      ...addedNodes.map(n => n.id),
      ...modifiedNodes.map(n => n.id),
      ...deletedNodes.map(n => n.id)
    ]);
    const affectedEntryPoints = (currentOutput.entry_points || [])
      .filter(ep => {
        const sourceNode = currentOutput.nodes.find(n => n.id === ep.source_node);
        if (sourceNode?.source?.file) {
          const relativePath = path.isAbsolute(sourceNode.source.file)
            ? path.relative(currentOutput.system.root_path, sourceNode.source.file)
            : sourceNode.source.file;
          return changedFiles.has(relativePath);
        }
        return false;
      })
      .map(ep => {
        const sourceNode = currentOutput.nodes.find(n => n.id === ep.source_node);
        return {
          id: ep.id,
          name: ep.name,
          path: (ep.trigger as any)?.path,
          impactType: 'direct' as const,
          distance: 0
        };
      });
    const affectedEntryPointIds = new Set(affectedEntryPoints.map(ep => ep.id));
    const affectedCallChains = (currentOutput.call_chains || [])
      .filter(chain =>
        affectedEntryPointIds.has(chain.entry_point?.entry_point_id || '') ||
        chain.call_path.some(step => changedNodeIds.has(step.node_id))
      )
      .map(chain => ({
        id: chain.id,
        name: chain.business_context?.business_process || chain.business_context?.feature_area || chain.entry_point?.method_name,
        criticality: chain.criticality,
        affectedNodes: chain.call_path
          .map(step => step.node_id)
          .filter(nodeId => changedNodeIds.has(nodeId))
      }));
    const semanticImpact = this.buildSemanticChangeImpact(
      currentOutput,
      changedNodeIds,
      affectedEntryPointIds,
      new Set(affectedCallChains.map(chain => chain.id)),
      [...addedEntryPoints, ...deletedEntryPoints],
      [...addedExitPoints, ...deletedExitPoints]
    );

    const riskLevel = this.calculateChangeRiskLevel(
      addedNodes.length,
      modifiedNodes.length,
      deletedNodes.length,
      affectedEntryPoints.length + semanticImpact.affected_workflows.length
    );

    return {
      timestamp: new Date().toISOString(),
      previousAnalysis: previousOutput.analysis_timestamp,
      currentAnalysis: currentOutput.analysis_timestamp,
      summary: {
        filesAdded: changeSet.added.length,
        filesModified: changeSet.modified.length,
        filesDeleted: changeSet.deleted.length,
        nodesAdded: addedNodes.length,
        nodesModified: modifiedNodes.length,
        nodesDeleted: deletedNodes.length,
        edgesAdded: addedEdges.length,
        edgesModified: 0,
        edgesDeleted: deletedEdges.length
      },
      impact: {
        riskLevel,
        confidence: 0.8,
        affectedEntryPoints,
        affectedCallChains,
        affectedConsumers: [],
        criticalPathsAffected: affectedEntryPoints.length > 0 || affectedCallChains.some(chain => chain.criticality === 'critical' || chain.criticality === 'high'),
        securitySensitive: currentOutput.security_boundaries?.some(boundary =>
          boundary.enforcement_points.some(point => changedNodeIds.has(point.node_id))
        ) || false,
        dataFlowAffected: semanticImpact.affected_data_entities.length > 0,
        testCoverage: {
          directTests: [],
          integrationTests: [],
          uncoveredChanges: [],
          suggestedTests: []
        },
        documentation: {
          affectedDocs: [],
          outdatedComments: []
        }
      },
      semantic_impact: semanticImpact,
      details: {
        files,
        addedNodes: addedNodes.map(n => ({
          id: n.id,
          name: n.name,
          type: n.type,
          file: n.source?.file || ''
        })),
        modifiedNodes,
        deletedNodes: deletedNodes.map(n => ({
          id: n.id,
          name: n.name,
          type: n.type,
          file: n.source?.file
        })),
        addedEdges: addedEdges.map(e => ({
          id: e.id,
          source: e.source,
          target: e.target,
          type: e.type
        })),
        deletedEdges: deletedEdges.map(e => ({
          id: e.id,
          source: e.source,
          target: e.target,
          type: e.type
        })),
        addedEntryPoints: addedEntryPoints.map(ep => ({
          id: ep.id,
          name: ep.name
        })),
        modifiedEntryPoints: affectedEntryPoints.map(ep => ({
          id: ep.id,
          name: ep.name,
          details: ep.path
        })),
        deletedEntryPoints: deletedEntryPoints.map(ep => ({
          id: ep.id,
          name: ep.name
        })),
        addedExitPoints: addedExitPoints.map(ep => ({
          id: ep.id,
          name: ep.name
        })),
        deletedExitPoints: deletedExitPoints.map(ep => ({
          id: ep.id,
          name: ep.name
        }))
      }
    };
  }

  private calculateChangeRiskLevel(
    nodesAdded: number,
    nodesModified: number,
    nodesDeleted: number,
    affectedEntryPoints: number
  ): 'low' | 'medium' | 'high' | 'critical' {
    const totalNodeChanges = nodesAdded + nodesModified + nodesDeleted;

    if (affectedEntryPoints > 5 || totalNodeChanges > 50) {
      return 'critical';
    }
    if (affectedEntryPoints > 2 || totalNodeChanges > 20) {
      return 'high';
    }
    if (affectedEntryPoints > 0 || totalNodeChanges > 5) {
      return 'medium';
    }
    return 'low';
  }

  private extractImportedFiles(nodes: CASNode[]): string[] {
    const imports: string[] = [];
    for (const node of nodes) {
      if (node.type === 'import' && node.metadata) {
        const metadata = node.metadata as Record<string, any>;
        const source = metadata.source;
        if (typeof source === 'string' && (source.startsWith('.') || source.startsWith('/'))) {
          imports.push(source);
        }
      }
    }
    return imports;
  }

  private extractExportedSymbols(nodes: CASNode[]): string[] {
    const exports: string[] = [];
    for (const node of nodes) {
      if (node.metadata?.is_exported) {
        exports.push(node.name);
      }
    }
    return exports;
  }

  private computeContentHash(content: string): string {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
  }

  queryAnalysis(casOutput: CASOutput, options: {
    level?: number;
    type?: string;
    nameFilter?: string;
    includeEdges?: boolean;
  } = {}): { nodes: CASNode[]; edges?: CASEdge[] } {
    let filteredNodes = casOutput.nodes;

    if (options.level !== undefined) {
      filteredNodes = filteredNodes.filter(node =>
        node.level === undefined || node.level <= options.level!
      );
    }

    if (options.type) {
      filteredNodes = filteredNodes.filter(node => node.type === options.type);
    }

    if (options.nameFilter) {
      const regex = new RegExp(options.nameFilter, 'i');
      filteredNodes = filteredNodes.filter(node => regex.test(node.name));
    }

    const result: { nodes: CASNode[]; edges?: CASEdge[] } = { nodes: filteredNodes };

    if (options.includeEdges !== false) {
      const nodeIds = new Set(filteredNodes.map(node => node.id));
      result.edges = casOutput.edges.filter(edge =>
        nodeIds.has(edge.source) && nodeIds.has(edge.target)
      );
    }

    return result;
  }

  private async shouldUseAnalyzer(
    projectPath: string,
    registration: AnalyzerRegistration
  ): Promise<boolean> {
    try {
      if (await registration.analyzer.canAnalyze(projectPath)) {
        this.analyzerRootMap.set(registration.id, projectPath);
        return true;
      }

      for (const root of this.projectRoots) {
        if (root === projectPath) continue;
        try {
          if (await registration.analyzer.canAnalyze(root)) {
            this.analyzerRootMap.set(registration.id, root);
            return true;
          }
        } catch {
        }
      }

      return false;
    } catch (error) {
      return false;
    }
  }

  private async detectPrimaryProjectType(projectPath: string): Promise<string> {
    try {
      const indicators = [
        { type: 'typescript', files: ['**/package.json'], content: ['"typescript"', '"@types/', '"next"', '"ts-node"'] },
        { type: 'javascript', files: ['**/package.json'], content: ['"react"', '"express"', '"vue"', '"next"', '"socket.io"'] },
        { type: 'python', files: ['**/requirements.txt', '**/setup.py', '**/pyproject.toml', '**/Pipfile'] },
        { type: 'java', files: ['**/pom.xml', '**/build.gradle', '**/build.gradle.kts'] },
        { type: 'csharp', files: ['**/*.csproj', '**/*.sln'] },
        { type: 'go', files: ['**/go.mod'] },
        { type: 'rust', files: ['**/Cargo.toml'] },
        { type: 'php', files: ['**/composer.json'] }
      ];

      const ignorePatterns = ['**/node_modules/**', '**/vendor/**', '**/.git/**', '**/dist/**', '**/build/**', '**/target/**', '**/__pycache__/**', '**/.venv/**', '**/venv/**'];

      for (const indicator of indicators) {
        for (const filePattern of indicator.files) {
          try {
            const files = await glob(filePattern, { cwd: projectPath, ignore: ignorePatterns });
            if (files.length > 0) {
              if (indicator.content && indicator.content.length > 0) {
                for (const f of files) {
                  try {
                    const content = await fs.readFile(path.join(projectPath, f), 'utf-8');
                    if (indicator.content.some(c => content.includes(c))) {
                      return indicator.type;
                    }
                  } catch {
                  }
                }
              } else {
                return indicator.type;
              }
            }
          } catch {
          }
        }
      }

      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private isAnalyzerRelevantForProject(registration: AnalyzerRegistration, projectType: string): boolean {
    if (projectType === 'unknown') {
      return true;
    }

    if (registration.type === 'language') {
      const languageMap: { [key: string]: string[] } = {
        'typescript-javascript': ['typescript', 'javascript'],
        'python': ['python'],
        'java': ['java', 'kotlin', 'scala'],
        'csharp': ['csharp', 'fsharp', 'vb'],
        'go': ['go'],
        'rust': ['rust'],
        'php': ['php']
      };

      return languageMap[registration.id]?.includes(projectType) || false;
    }

    return true;
  }

  private orderAnalyzers(analyzers: AnalyzerRegistration[]): AnalyzerRegistration[] {
    const typeOrder = { language: 0, framework: 1, library: 2, pattern: 3 };

    return analyzers.sort((a, b) => {
      const aOrder = typeOrder[a.type] ?? 999;
      const bOrder = typeOrder[b.type] ?? 999;
      return aOrder - bOrder;
    });
  }

  private async runAnalyzer(
    registration: AnalyzerRegistration,
    context: AnalysisContext,
    projectPath: string,
    accumulators: {
      allNodes: CASNode[];
      allEdges: CASEdge[];
      allEntryPoints: any[];
      allExitPoints: any[];
      allBehaviors: CASBehavior[];
      allPatterns: CASPattern[];
      allTags: CASTag[];
      allPerspectives: CASPerspective[];
      allLibraries: any[];
      categories: CASCategories;
      contributions: any[];
    }
  ): Promise<void> {
    const analyzerStartTime = Date.now();

    const matchedRoot = this.analyzerRootMap.get(registration.id) || projectPath;
    context.projectPath = matchedRoot;

    context.existingAnalysis = [{
      nodes: accumulators.allNodes,
      edges: accumulators.allEdges,
      entry_points: accumulators.allEntryPoints,
      exit_points: accumulators.allExitPoints,
      analyzer_metadata: {
        analyzer_id: 'merged',
        analyzer_name: 'Merged Analysis',
        version: '1.0.0',
        contribution_type: 'pattern' as const,
        nodes_contributed: accumulators.allNodes.length,
        edges_contributed: accumulators.allEdges.length,
        contributed_entry_points: accumulators.allEntryPoints.length,
        contributed_exit_points: accumulators.allExitPoints.length
      }
    }];

    const result = await registration.analyzer.analyze(context);
    const executionTime = Date.now() - analyzerStartTime;

    if (matchedRoot !== projectPath) {
      const relPrefix = path.relative(projectPath, matchedRoot);
      this.normalizeFilePaths(result, relPrefix);
    }

    this.mergeAnalysisResult(
      { allNodes: accumulators.allNodes, allEdges: accumulators.allEdges, allEntryPoints: accumulators.allEntryPoints, allExitPoints: accumulators.allExitPoints },
      result
    );

    if (result.behaviors) accumulators.allBehaviors.push(...result.behaviors);
    if (result.patterns) accumulators.allPatterns.push(...result.patterns);
    if (result.categories) this.mergeCategories(accumulators.categories, result.categories);
    if (result.tags) accumulators.allTags.push(...result.tags);
    if (result.perspectives) accumulators.allPerspectives.push(...result.perspectives);

    const analyzerMeta = result.analyzer_metadata || {};
    accumulators.contributions.push({
      analyzer_id: registration.id,
      analyzer_name: registration.name,
      analyzer_version: registration.version,
      analyzer_type: registration.type,
      contribution_type: registration.type,
      execution_time_ms: executionTime,
      nodes_created: result.nodes?.length || 0,
      edges_created: result.edges?.length || 0,
      confidence: 1.0,
      contributed_categories: result.categories ? Object.keys(result.categories).length : 0,
      provided_perspectives: result.provided_perspectives || [],
      framework_specific: analyzerMeta.frameworks_detected || analyzerMeta.crates || undefined,
      application_type: analyzerMeta.application_type,
      project_name: analyzerMeta.project_name,
      project_version: analyzerMeta.project_version
    });

    if (result.libraries) {
      accumulators.allLibraries.push(...result.libraries);
    }
  }

  private normalizeFilePaths(result: any, relPrefix: string): void {
    const normalizePath = (filePath: string): string => {
      if (path.isAbsolute(filePath)) return filePath;
      if (filePath === relPrefix || filePath.startsWith(`${relPrefix}${path.sep}`)) return filePath;
      return path.join(relPrefix, filePath);
    };

    for (const node of result.nodes || []) {
      if (node.source?.file && !path.isAbsolute(node.source.file)) {
        node.source.file = normalizePath(node.source.file);
      }
    }
    for (const edge of result.edges || []) {
      if (edge.source_location?.file && !path.isAbsolute(edge.source_location.file)) {
        edge.source_location.file = normalizePath(edge.source_location.file);
      }
    }
    for (const ep of result.entry_points || []) {
      if (ep.source?.file && !path.isAbsolute(ep.source.file)) {
        ep.source.file = normalizePath(ep.source.file);
      }
    }
    for (const ep of result.exit_points || []) {
      if (ep.source?.file && !path.isAbsolute(ep.source.file)) {
        ep.source.file = normalizePath(ep.source.file);
      }
    }
  }

  private mergeAnalysisResult(
    target: {
      allNodes: CASNode[];
      allEdges: CASEdge[];
      allEntryPoints: any[];
      allExitPoints: any[];
    },
    source: CASContribution
  ): void {
    const existingNodeIds = new Set(target.allNodes.map(n => n.id));
    const existingEdgeIds = new Set(target.allEdges.map(e => e.id));

    for (const node of source.nodes || []) {
      if (existingNodeIds.has(node.id)) {
        const existingNode = target.allNodes.find(n => n.id === node.id);
        if (existingNode) {
          // Enhanced merge logic for node collaboration
          if (node.metadata) {
            existingNode.metadata = { ...existingNode.metadata, ...node.metadata };
          }
          if (node.subcategories && node.subcategories.length > 0) {
            // Use the enhanced subcategories from the framework analyzer
            existingNode.subcategories = [...new Set([...(existingNode.subcategories || []), ...node.subcategories])];
          }
          if (node.level !== undefined && node.level !== existingNode.level) {
            existingNode.level = node.level; // Framework analyzers can promote level
          }
          if (node.level_name && node.level_name !== existingNode.level_name) {
            existingNode.level_name = node.level_name;
          }
          if (node.description && node.description !== existingNode.description) {
            existingNode.description = node.description; // Framework-specific descriptions take precedence
          }
          if (node.tags && node.tags.length > 0) {
            existingNode.tags = [...new Set([...(existingNode.tags || []), ...node.tags])];
          }
          if (node.type && node.type !== existingNode.type) {
            existingNode.type = node.type;
          }
          if (node.analyzers && node.analyzers.length > 0) {
            existingNode.analyzers = [...new Set([...(existingNode.analyzers || []), ...node.analyzers])];
          }
        }
      } else {
        target.allNodes.push(node);
        existingNodeIds.add(node.id);
      }
    }

    for (const edge of source.edges || []) {
      if (!existingEdgeIds.has(edge.id)) {
        target.allEdges.push(edge);
        existingEdgeIds.add(edge.id);
      }
    }

    if (source.entry_points) {
      const validEntryPoints = source.entry_points.filter(ep => this.isValidEntryPoint(ep));
      target.allEntryPoints.push(...validEntryPoints);
    }
    if (source.exit_points) {
      const validExitPoints = source.exit_points.filter(ep => this.isValidExitPoint(ep));
      target.allExitPoints.push(...validExitPoints);
    }
  }

  private isValidEntryPoint(ep: CASEntryPoint): boolean {
    const validTypes = new Set([
      'http', 'cli', 'websocket', 'ws_handler', 'message',
      'event', 'scheduled', 'schedule', 'cron', 'queue', 'grpc', 'graphql',
      'page', 'route', 'lifecycle', 'test'
    ]);
    return validTypes.has(ep.type);
  }

  private isValidExitPoint(ep: CASExitPoint): boolean {
    const validTypes = new Set([
      'database', 'http', 'grpc', 'graphql', 'queue', 'cache',
      'file', 'email', 'sms', 'external_api', 'sdk',
      'api', 'navigation', 'client_storage', 'analytics', 'message', 'webhook'
    ]);
    return validTypes.has(ep.type);
  }

  private determineSystemType(nodes: CASNode[]): string {
    const types = nodes.map(n => n.type);

    if (types.includes('controller')) return 'service';
    if (types.includes('component')) return 'application';
    if (types.includes('package')) return 'library';
    if (types.includes('module') && types.includes('controller')) return 'monorepo';

    return 'application';
  }

  private buildProgressiveLevels(nodes: CASNode[], categories: CASCategories): CASProgressiveLevels {
    const levelCounts = new Map<number, number>();
    const levelExamples = new Map<number, string[]>();
    const levelCategories = new Map<number, Set<string>>();

    nodes.forEach(node => {
      const level = node.level || 0;
      levelCounts.set(level, (levelCounts.get(level) || 0) + 1);

      const examples = levelExamples.get(level) || [];
      if (examples.length < 3) {
        examples.push(node.id);
        levelExamples.set(level, examples);
      }

      if (node.category) {
        const cats = levelCategories.get(level) || new Set();
        cats.add(node.category);
        levelCategories.set(level, cats);
      }
    });

    const sortedLevels = Array.from(levelCounts.keys()).sort((a, b) => a - b);
    const maxLevel = sortedLevels[sortedLevels.length - 1] || 3;

    const levelDefinitions = sortedLevels.map(level => ({
      level,
      name: this.getLevelName(level),
      description: this.getLevelDescription(level),
      node_count: levelCounts.get(level) || 0,
      recommended_for: this.getRecommendedFor(level),
      example_nodes: levelExamples.get(level) || [],
      time_to_understand: this.getTimeToUnderstand(level),
      contains: {
        categories: Array.from(levelCategories.get(level) || []),
        entry_points: level <= 1 ? 'included' : 'referenced',
        exit_points: level <= 2 ? 'included' : 'referenced',
        key_connections: level <= 2 ? 'all' : 'primary'
      }
    }));

    return {
      total_levels: maxLevel + 1,
      level_definitions: levelDefinitions,
      query_patterns: {
        level_specific: {
          description: 'Get nodes at a specific level',
          example: 'level=1',
          use_case: 'View high-level architecture'
        },
        level_range: {
          description: 'Get nodes up to a certain level',
          example: 'maxLevel=2',
          use_case: 'Progressive exploration'
        },
        discover_levels: {
          description: 'Discover what levels are available',
          example: 'query=levels',
          response: 'List of level definitions'
        },
        category_with_level: {
          description: 'Get specific category at level',
          example: 'category=controllers&level=1',
          use_case: 'Focused exploration'
        },
        children_progressive: {
          description: 'Get children of node progressively',
          example: 'nodeId=xxx&depth=1',
          use_case: 'Drill-down navigation'
        }
      },
      consumer_recommendations: {
        mcp_servers: {
          initial_load: 'Start with levels 0-1 for context',
          on_demand: 'Request deeper levels as needed',
          benefit: 'Reduces token usage by 10-20x',
          adaptive: 'Adjust based on query complexity'
        },
        ui_visualization: {
          overview_mode: 'Show levels 0-1 initially',
          detail_mode: 'Expand to level 2-3 on interaction',
          debug_mode: 'Show all levels with filtering',
          benefit: 'Progressive disclosure improves UX'
        },
        documentation_tools: {
          architecture_docs: 'Use levels 0-1',
          api_docs: 'Use levels 1-2 for endpoints',
          implementation_docs: 'Use levels 2-4',
          benefit: 'Right detail for right audience'
        }
      },
      level_strategy: {
        flexible_depth: 'Analyzers can define custom levels',
        minimum_levels: 2,
        maximum_levels: 'Unlimited, typically 4-6',
        common_range: '3-5 levels',
        examples: {
          'simple_script': '2 levels',
          'web_application': '4 levels',
          'enterprise_system': '5+ levels'
        }
      }
    };
  }

  private getLevelName(level: number): string {
    const names = [
      'System Overview',
      'Major Components',
      'Implementation Details',
      'Function Level',
      'Code Details',
      'Deep Implementation'
    ];
    return names[level] || `Level ${level}`;
  }

  private getLevelDescription(level: number): string {
    const descriptions = [
      'Top-level system architecture and entry points',
      'Major components, services, and their relationships',
      'Classes, modules, and detailed structure',
      'Functions, methods, and their interactions',
      'Variables, parameters, and low-level details',
      'AST nodes and implementation specifics'
    ];
    return descriptions[level] || `Details at level ${level}`;
  }

  private getRecommendedFor(level: number): string[] {
    const recommendations: Record<number, string[]> = {
      0: ['System overview', 'Architecture review', 'Initial exploration'],
      1: ['Component understanding', 'API discovery', 'Service mapping'],
      2: ['Implementation review', 'Code navigation', 'Refactoring planning'],
      3: ['Debugging', 'Detailed analysis', 'Performance optimization'],
      4: ['Deep debugging', 'Security audit', 'Complete understanding']
    };
    return recommendations[level] || ['Detailed analysis'];
  }

  private getTimeToUnderstand(level: number): string {
    const times = ['30 seconds', '2 minutes', '5 minutes', '10 minutes', '20 minutes', '30+ minutes'];
    return times[level] || '30+ minutes';
  }

  private buildIndex(nodes: CASNode[], entryPoints: any[], exitPoints: any[], perspectives: CASPerspective[]): CASIndex {
    const index: CASIndex = {
      by_type: {},
      by_name: {},
      by_perspective: {},
      entry_points: entryPoints.map(ep => ep.id),
      exit_points: exitPoints.map(ep => ep.id)
    };

    nodes.forEach(node => {
      if (!index.by_type![node.type]) {
        index.by_type![node.type] = [];
      }
      index.by_type![node.type].push(node.id);

      const nameKey = node.name.toLowerCase();
      if (!index.by_name![nameKey]) {
        index.by_name![nameKey] = [];
      }
      if (!Array.isArray(index.by_name![nameKey])) {
        index.by_name![nameKey] = [];
      }
      index.by_name![nameKey].push(node.id);

      if (node.perspectives) {
        Object.keys(node.perspectives).forEach(perspectiveId => {
          if (!index.by_perspective![perspectiveId]) {
            index.by_perspective![perspectiveId] = [];
          }
          index.by_perspective![perspectiveId].push(node.id);
        });
      }
    });

    perspectives.forEach(perspective => {
      if (!index.by_perspective![perspective.id]) {
        index.by_perspective![perspective.id] = [];
      }
    });

    return index;
  }

  private mergeCategories(target: CASCategories, source: Partial<CASCategories>): void {
    for (const [level, levelCategories] of Object.entries(source)) {
      if (!target[level]) {
        target[level] = {};
      }
      for (const [category, categoryData] of Object.entries(levelCategories || {})) {
        if (!target[level][category]) {
          target[level][category] = categoryData;
        } else {
          target[level][category] = {
            ...target[level][category],
            ...categoryData,
            types: [...new Set([...(target[level][category].types || []), ...(categoryData.types || [])])],
            frameworks: [...new Set([...(target[level][category].frameworks || []), ...(categoryData.frameworks || [])])],
            languages: [...new Set([...(target[level][category].languages || []), ...(categoryData.languages || [])])]
          };
        }
      }
    }
  }

  private extractTechnologies(contributions: any[], libraries: any[]): any {
    const languages = new Map<string, { count: number; percentage?: number }>();
    const frameworks = new Map<string, { version?: string; confidence: number }>();

    contributions.forEach(contrib => {
      if (contrib.analyzer_type === 'language') {
        const langName = contrib.analyzer_name.replace(' Analyzer', '');
        languages.set(langName, {
          count: contrib.nodes_created,
          percentage: 0
        });

        if (contrib.framework_specific) {
          this.extractFrameworksFromSpec(contrib.framework_specific, frameworks);
        }
      } else if (contrib.analyzer_type === 'framework') {
        const frameworkName = contrib.analyzer_name.replace(' Analyzer', '');
        frameworks.set(frameworkName, {
          confidence: contrib.confidence || 1.0
        });
      }
    });

    const totalNodes = Array.from(languages.values()).reduce((sum, l) => sum + l.count, 0);
    languages.forEach((value, key) => {
      value.percentage = totalNodes > 0 ? (value.count / totalNodes) * 100 : 0;
    });

    return {
      languages: Array.from(languages.entries()).map(([name, data]) => ({
        name,
        percentage: data.percentage,
        files: data.count
      })),
      frameworks: Array.from(frameworks.entries()).map(([name, data]) => ({
        name,
        confidence: data.confidence
      }))
    };
  }

  private extractFrameworksFromSpec(
    spec: Record<string, any>,
    frameworks: Map<string, { version?: string; confidence: number }>
  ): void {
    const processObject = (obj: Record<string, any>, prefix = ''): void => {
      for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'boolean' && value === true) {
          const frameworkName = prefix ? `${prefix}/${key}` : key;
          frameworks.set(frameworkName, { confidence: 1.0 });
        } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          processObject(value, key);
        }
      }
    };
    processObject(spec);
  }

  private calculateQualityMetrics(nodes: CASNode[]): any {
    const totalNodes = nodes.length;
    const documentedNodes = nodes.filter(n => n.description || n.metadata?.documentation).length;
    const testedNodes = nodes.filter(n => n.metadata?.is_test || n.testing?.tested_by).length;

    const complexitySum = nodes.reduce((sum, node) => {
      return sum + (node.metadata?.complexity?.cyclomatic || 0);
    }, 0);

    return {
      documentation_coverage: totalNodes > 0 ? (documentedNodes / totalNodes) * 100 : 0,
      test_coverage: totalNodes > 0 ? (testedNodes / totalNodes) * 100 : 0,
      complexity_score: totalNodes > 0 ? complexitySum / totalNodes : 0,
      maintainability_index: 100
    };
  }

  private buildArchitectureSummary(
    nodes: CASNode[],
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[],
    contributions: any[]
  ): CASArchitectureSummary {
    const fileNodes = nodes.filter(n => n.type === 'file');
    const httpEntryPoints = entryPoints.filter(ep => ep.type === 'http');

    const frameworkContribution = contributions.find(c => c.analyzer_type === 'framework');
    const languageContribution = contributions.find(c => c.analyzer_type === 'language' && c.application_type);
    const systemType = frameworkContribution?.analyzer_name?.replace(' Analyzer', '') ||
      languageContribution?.application_type ||
      'Application';

    const controllers = nodes.filter(n => n.type === 'controller' || n.subcategories?.includes('controller'));
    const services = nodes.filter(n => n.type === 'service' || n.subcategories?.includes('service'));
    const entities = nodes.filter(n => n.type === 'entity' || n.subcategories?.includes('entity'));
    const repositories = nodes.filter(n => n.type === 'repository' || n.subcategories?.includes('repository'));
    const guards = nodes.filter(n => n.type === 'guard' || n.subcategories?.includes('guard'));
    const middleware = nodes.filter(n => n.type === 'middleware' || n.subcategories?.includes('middleware'));
    const modules = nodes.filter(n => n.type === 'module');
    const components = nodes.filter(n => n.type === 'component');
    const pages = nodes.filter(n => n.type === 'page' || n.subcategories?.includes('page'));
    const migrations = nodes.filter(n => n.type === 'migration' || n.source?.file?.includes('migration'));

    const authenticatedEndpoints = httpEntryPoints.filter(ep => ep.security?.authenticated);
    const publicEndpoints = httpEntryPoints.filter(ep => !ep.security?.authenticated);

    const methodCounts: Record<string, number> = {};
    httpEntryPoints.forEach(ep => {
      const method = ep.trigger?.method?.toUpperCase() || 'UNKNOWN';
      methodCounts[method] = (methodCounts[method] || 0) + 1;
    });

    const uniqueGuards = new Set<string>();
    httpEntryPoints.forEach(ep => {
      const epGuards = ep.metadata?.guards as string[] | undefined;
      if (epGuards) {
        epGuards.forEach(g => uniqueGuards.add(g));
      }
    });

    let authStrategy: string | undefined;
    if (uniqueGuards.has('JwtAuthGuard') || uniqueGuards.has('JwtGuard')) {
      authStrategy = 'JWT';
    } else if (uniqueGuards.has('SessionGuard')) {
      authStrategy = 'Session';
    } else if (uniqueGuards.has('AuthGuard')) {
      authStrategy = 'Custom';
    }

    return {
      system_type: systemType,
      total_files: fileNodes.length,
      layers: {
        presentation: {
          controllers: controllers.length > 0 ? controllers.length : undefined,
          guards: guards.length > 0 ? guards.length : undefined,
          middleware: middleware.length > 0 ? middleware.length : undefined,
          endpoints: httpEntryPoints.length > 0 ? httpEntryPoints.length : undefined,
          components: components.length > 0 ? components.length : undefined,
          pages: pages.length > 0 ? pages.length : undefined
        },
        business: {
          services: services.length > 0 ? services.length : undefined
        },
        data: {
          repositories: repositories.length > 0 ? repositories.length : undefined,
          entities: entities.length > 0 ? entities.length : undefined,
          migrations: migrations.length > 0 ? migrations.length : undefined
        },
        infrastructure: {
          modules: modules.length > 0 ? modules.length : undefined
        }
      },
      api_surface: httpEntryPoints.length > 0 ? {
        total_endpoints: httpEntryPoints.length,
        by_auth: {
          authenticated: authenticatedEndpoints.length,
          public: publicEndpoints.length
        },
        by_method: methodCounts
      } : undefined,
      security: authenticatedEndpoints.length > 0 ? {
        auth_strategy: authStrategy,
        protected_endpoints: authenticatedEndpoints.length,
        guards: Array.from(uniqueGuards)
      } : undefined
    };
  }

  private buildRouteTable(entryPoints: CASEntryPoint[]): CASRouteTableEntry[] {
    const httpEntryPoints = entryPoints.filter(ep => ep.type === 'http');

    return httpEntryPoints.map(ep => {
      const metadata = ep.metadata || {};
      const controllerName = metadata.controller as string || 'Unknown';
      const handlerName = metadata.handler as string || metadata.method_name as string || ep.name;

      return {
        method: ep.trigger?.method?.toUpperCase() || 'GET',
        path: ep.trigger?.path || '/',
        controller: controllerName,
        handler: handlerName,
        auth: ep.security?.authenticated || false,
        guards: metadata.guards as string[] | undefined,
        source_node: ep.source_node,
        description: ep.description
      };
    }).sort((a, b) => {
      if (a.path !== b.path) return a.path.localeCompare(b.path);
      return a.method.localeCompare(b.method);
    });
  }

  private buildDatabaseSchema(nodes: CASNode[], libraries: any[], projectPath?: string): CASDatabaseSchema {
    const entities: CASDatabaseEntity[] = [];
    const relationships: string[] = [];

    let orm: string | undefined;
    const mikroormLib = libraries.find(l => l.name?.includes('mikro-orm') || l.name?.includes('@mikro-orm'));
    const typeormLib = libraries.find(l => l.name?.includes('typeorm'));
    const prismaLib = libraries.find(l => l.name?.includes('prisma'));

    if (mikroormLib) orm = 'MikroORM';
    else if (typeormLib) orm = 'TypeORM';
    else if (prismaLib) orm = 'Prisma';

    if (!orm) {
      const importNodes = nodes.filter(n => n.type === 'import');
      if (importNodes.some(n => n.name?.includes('@mikro-orm') || n.metadata?.attributes?.source?.includes('@mikro-orm'))) {
        orm = 'MikroORM';
      } else if (importNodes.some(n => n.name?.includes('typeorm') || n.metadata?.attributes?.source?.includes('typeorm'))) {
        orm = 'TypeORM';
      } else if (importNodes.some(n => n.name?.includes('prisma') || n.metadata?.attributes?.source?.includes('prisma'))) {
        orm = 'Prisma';
      }
    }

    const entityNodes = nodes.filter(n =>
      n.type === 'entity' ||
      n.type === 'model' ||
      n.subcategories?.includes('entity') ||
      n.metadata?.annotations?.some(a => a.includes('Entity')) ||
      (n.type === 'class' && n.source?.file?.includes('/entities/'))
    );

    entityNodes.forEach(entityNode => {
      const fields: CASDatabaseEntity['fields'] = [];
      const entityRelationships: CASDatabaseEntity['relationships'] = [];

      const propertyNodes = this.entityPropertyNodes(nodes, entityNode);

      propertyNodes.forEach(prop => {
        const annotations = [
          ...(prop.metadata?.annotations || []),
          ...this.sourceDecoratorsForNode(projectPath, prop),
        ];
        const isPrimary = annotations.some(a => a.includes('PrimaryKey') || a.includes('PrimaryGeneratedColumn'));
        const isUnique = annotations.some(a => a.includes('Unique'));
        const nullable = this.decoratorOptionBoolean(annotations, 'nullable');
        const defaultValue = this.decoratorOptionValue(annotations, 'default');

        let relationType: string | undefined;
        let relTarget: string | undefined;

        for (const ann of annotations) {
          if (ann.includes('OneToMany')) relationType = 'OneToMany';
          else if (ann.includes('ManyToOne')) relationType = 'ManyToOne';
          else if (ann.includes('OneToOne')) relationType = 'OneToOne';
          else if (ann.includes('ManyToMany')) relationType = 'ManyToMany';

          const targetMatch = ann.match(/\(\)\s*=>\s*(\w+)/);
          if (targetMatch) relTarget = targetMatch[1];
        }

        if (relationType && relTarget) {
          entityRelationships.push({
            type: relationType as any,
            target: relTarget,
            field: prop.name
          });

          const cardinality = relationType === 'OneToMany' ? '1:N' :
            relationType === 'ManyToOne' ? 'N:1' :
            relationType === 'ManyToMany' ? 'N:M' : '1:1';
          relationships.push(`${entityNode.name} ${cardinality} ${relTarget} (via ${prop.name})`);
        } else {
          fields.push({
            name: prop.name,
            type: prop.signature?.return_type || 'unknown',
            primary: isPrimary,
            unique: isUnique,
            nullable,
            default: defaultValue
          });
        }
      });

      entities.push({
        name: entityNode.name,
        table: entityNode.metadata?.attributes?.tableName as string,
        source_file: entityNode.source?.file,
        fields,
        relationships: entityRelationships
      });
    });

    return {
      orm,
      entities,
      relationships_summary: [...new Set(relationships)]
    };
  }

  private entityPropertyNodes(nodes: CASNode[], entityNode: CASNode): CASNode[] {
    return nodes.filter(n =>
      (n.type === 'property' || n.type === 'field' || n.type === 'attribute' || n.type === 'variable') &&
      (
        n.parent === entityNode.id ||
        (n.source?.file && entityNode.source?.file && this.sourceFilesCompatible(n.source.file, entityNode.source.file) && n.id.includes(entityNode.id))
      )
    );
  }

  private sourceFilesCompatible(left: string, right: string): boolean {
    const normalizedLeft = left.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
    const normalizedRight = right.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
    return normalizedLeft === normalizedRight || normalizedLeft.endsWith(`/${normalizedRight}`) || normalizedRight.endsWith(`/${normalizedLeft}`);
  }

  private sourceDecoratorsForNode(projectPath: string | undefined, node: CASNode): string[] {
    if (!projectPath || !node.source?.file || !node.source.line) return [];
    const filePath = path.isAbsolute(node.source.file)
      ? node.source.file
      : path.join(projectPath, node.source.file);
    if (!fs.existsSync(filePath)) return [];
    try {
      const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
      const decorators: string[] = [];
      const propertyIndex = this.sourceDeclarationLine(lines, node);
      for (let index = Math.max(0, propertyIndex - 1); index >= 0; index--) {
        const line = lines[index]?.trim() || '';
        if (!line) {
          if (decorators.length > 0) break;
          continue;
        }
        if (line.startsWith('@')) {
          decorators.unshift(line);
          continue;
        }
        if (line.startsWith('})') || line.startsWith(')')) {
          decorators.unshift(line);
          continue;
        }
        if (/^[A-Za-z0-9_]+:/.test(line) || line === '{' || line === '})' || line.endsWith(',')) {
          decorators.unshift(line);
          continue;
        }
        break;
      }
      return decorators;
    } catch {
      return [];
    }
  }

  private sourceDeclarationLine(lines: string[], node: CASNode): number {
    const start = Math.max(0, (node.source?.line || 1) - 1);
    const pattern = new RegExp(`\\b${node.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    for (let index = start; index < Math.min(lines.length, start + 12); index++) {
      const line = lines[index] || '';
      if (!line.trim().startsWith('@') && pattern.test(line)) return index;
    }
    return start;
  }

  private decoratorOptionBoolean(annotations: string[], option: string): boolean | undefined {
    const text = annotations.join(' ');
    const match = text.match(new RegExp(`${option}\\s*:\\s*(true|false)`));
    return match ? match[1] === 'true' : undefined;
  }

  private decoratorOptionValue(annotations: string[], option: string): string | undefined {
    const text = annotations.join(' ');
    const match = text.match(new RegExp(`${option}\\s*:\\s*([^,})]+)`));
    return match?.[1]?.trim();
  }

  private buildExternalServices(
    nodes: CASNode[],
    exitPoints: CASExitPoint[],
    libraries: any[]
  ): CASExternalService[] {
    const services: CASExternalService[] = [];
    const serviceMap = new Map<string, CASExternalService>();

    const stdBuiltins = new Set([
      // JavaScript/Node built-ins
      'console', 'path', 'fs', 'os', 'crypto', 'http', 'https', 'url', 'util',
      'stream', 'buffer', 'events', 'child_process', 'cluster', 'dgram', 'dns',
      'net', 'readline', 'repl', 'tls', 'tty', 'v8', 'vm', 'zlib', 'assert',
      'Object', 'Array', 'String', 'Number', 'Boolean', 'Date', 'Math', 'JSON',
      'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol', 'Proxy', 'Reflect',
      'Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError',
      'RegExp', 'Function', 'Buffer', 'process', 'global', 'setTimeout',
      'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate',
      'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURI', 'decodeURI',
      'encodeURIComponent', 'decodeURIComponent', 'escape', 'unescape', 'eval',
      'Intl', 'Atomics', 'SharedArrayBuffer', 'ArrayBuffer', 'DataView',
      'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
      'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array',
      'BigUint64Array', 'BigInt', 'Infinity', 'NaN', 'undefined', 'null',
      // Rust standard library
      'std', 'core', 'alloc', 'Vec', 'HashMap', 'HashSet', 'BTreeMap', 'BTreeSet',
      'Option', 'Result', 'Box', 'Rc', 'Arc', 'Cell', 'RefCell', 'Mutex', 'RwLock',
      'Duration', 'Instant', 'SystemTime', 'Path', 'PathBuf', 'OsStr', 'OsString',
      'File', 'Read', 'Write', 'BufRead', 'BufReader', 'BufWriter',
      'TcpStream', 'TcpListener', 'UdpSocket', 'Command', 'Child', 'Stdio',
      'thread', 'sync', 'collections', 'io', 'env', 'fmt', 'str', 'slice', 'iter',
      'ops', 'cmp', 'convert', 'default', 'mem', 'ptr', 'num', 'time', 'ffi',
      'Cow', 'Deref', 'DerefMut', 'Drop', 'Clone', 'Copy', 'Debug', 'Display',
      'Default', 'PartialEq', 'Eq', 'PartialOrd', 'Ord', 'Hash', 'Iterator',
      'IntoIterator', 'FromIterator', 'Extend', 'From', 'Into', 'TryFrom', 'TryInto',
      'AsRef', 'AsMut', 'Send', 'Sync', 'Sized', 'Unpin', 'VecDeque', 'LinkedList',
      'BinaryHeap', 'Range', 'PhantomData', 'ManuallyDrop', 'MaybeUninit', 'NonNull',
      'Ordering', 'Reverse', 'format', 'println', 'print', 'eprintln', 'eprint',
      'dbg', 'todo', 'unimplemented', 'unreachable', 'assert', 'assert_eq', 'assert_ne',
      'vec', 'format_args', 'write', 'writeln', 'DefaultHasher', 'RandomState',
      'ErrorKind', 'Formatter', 'Arguments', 'Pin', 'Waker', 'Context', 'Poll',
      'Future', 'CStr', 'CString', 'ipaddr', 'RateLimiter'
    ]);

    exitPoints.forEach(ep => {
      if (ep.type === 'database') {
        const dbKey = ep.target?.service_id || 'primary_database';
        if (!serviceMap.has(dbKey)) {
          serviceMap.set(dbKey, {
            id: `ext_${dbKey}`,
            name: ep.name || 'Database',
            type: 'database',
            purpose: 'bidirectional',
            connected_nodes: [],
            exit_points: []
          });
        }
        const svc = serviceMap.get(dbKey)!;
        if (ep.source_node && !svc.connected_nodes?.includes(ep.source_node)) {
          svc.connected_nodes?.push(ep.source_node);
        }
        svc.exit_points?.push(ep.id);
      } else if (ep.type === 'cache') {
        const cacheKey = 'redis_cache';
        if (!serviceMap.has(cacheKey)) {
          serviceMap.set(cacheKey, {
            id: `ext_${cacheKey}`,
            name: 'Redis',
            type: 'cache',
            purpose: 'bidirectional',
            usage_pattern: {
              operations: []
            },
            connected_nodes: [],
            exit_points: []
          });
        }
        const svc = serviceMap.get(cacheKey)!;
        if (ep.source_node && !svc.connected_nodes?.includes(ep.source_node)) {
          svc.connected_nodes?.push(ep.source_node);
        }
        svc.exit_points?.push(ep.id);
      } else if (ep.type === 'api' || ep.type === 'sdk') {
        const sdkName = ep.target?.sdk || ep.name || 'External API';

        if (stdBuiltins.has(sdkName)) {
          return;
        }

        const key = sdkName.toLowerCase().replace(/\s+/g, '_');

        if (!serviceMap.has(key)) {
          serviceMap.set(key, {
            id: `ext_${key}`,
            name: sdkName,
            type: ep.type === 'sdk' ? 'sdk' : 'api',
            purpose: 'consumption',
            connected_nodes: [],
            exit_points: []
          });
        }
        const svc = serviceMap.get(key)!;
        if (ep.source_node && !svc.connected_nodes?.includes(ep.source_node)) {
          svc.connected_nodes?.push(ep.source_node);
        }
        svc.exit_points?.push(ep.id);
      }
    });

    const aiLibraries = libraries.filter(l =>
      l.name?.includes('openai') ||
      l.name?.includes('anthropic') ||
      l.name?.includes('@anthropic-ai')
    );

    aiLibraries.forEach(lib => {
      const key = lib.name?.includes('openai') ? 'openai' : 'anthropic';
      if (!serviceMap.has(key)) {
        serviceMap.set(key, {
          id: `ext_${key}`,
          name: key === 'openai' ? 'OpenAI' : 'Anthropic',
          type: 'ai_provider',
          purpose: 'consumption',
          configuration: {
            library: lib.name,
            version: lib.version
          }
        });
      }
    });

    serviceMap.forEach(svc => services.push(svc));

    return services;
  }

  private detectPatterns(nodes: CASNode[], edges: CASEdge[]): CASPattern[] {
    const patterns: CASPattern[] = [];

    this.detectRepositoryPattern(nodes, edges, patterns);
    this.detectServiceLayerPattern(nodes, edges, patterns);
    this.detectControllerPattern(nodes, edges, patterns);
    this.detectDependencyInjectionPattern(nodes, edges, patterns);
    this.detectModulePattern(nodes, edges, patterns);
    this.detectGuardPattern(nodes, edges, patterns);
    this.detectGodObjectAntiPattern(nodes, patterns);
    this.detectCircularDependencyAntiPattern(nodes, edges, patterns);

    return patterns;
  }

  private detectRepositoryPattern(nodes: CASNode[], edges: CASEdge[], patterns: CASPattern[]): void {
    const repositories = nodes.filter(n =>
      n.type === 'repository' ||
      n.subcategories?.includes('repository') ||
      n.name.toLowerCase().endsWith('repository') ||
      n.name.toLowerCase().endsWith('repo')
    );

    if (repositories.length === 0) return;

    const diRepositories = repositories.filter(n =>
      n.metadata?.annotations?.some(a => a.includes('Injectable')) ||
      n.subcategories?.includes('injectable')
    );

    const manualRepositories = repositories.filter(n =>
      !n.metadata?.annotations?.some(a => a.includes('Injectable')) &&
      !n.subcategories?.includes('injectable')
    );

    const variations: CASPattern['variations'] = [];
    const deviations: CASPattern['deviations'] = [];

    if (diRepositories.length > 0) {
      variations.push({
        id: 'var-repository-di',
        implementation: 'dependency-injection',
        description: 'Repository managed by DI container with @Injectable decorator',
        instances: diRepositories.map(n => n.id),
        percentage: Math.round((diRepositories.length / repositories.length) * 100)
      });
    }

    if (manualRepositories.length > 0) {
      variations.push({
        id: 'var-repository-manual',
        implementation: 'manual-instantiation',
        description: 'Repository instantiated manually without DI',
        instances: manualRepositories.map(n => n.id),
        percentage: Math.round((manualRepositories.length / repositories.length) * 100)
      });
    }

    if (variations.length > 1) {
      const dominant = variations.reduce((a, b) => a.percentage > b.percentage ? a : b);
      const minority = variations.filter(v => v.id !== dominant.id);

      if (dominant.percentage < 90) {
        deviations.push({
          type: 'mixed-styles',
          severity: 'warning',
          description: `Mixed repository implementation styles: ${variations.map(v => `${v.percentage}% ${v.implementation}`).join(', ')}`,
          affected_instances: minority.flatMap(v => v.instances),
          recommendation: `Consider standardizing on ${dominant.implementation} for consistency`
        });
      }
    }

    patterns.push({
      id: 'repository-pattern',
      name: 'Repository Pattern',
      description: 'Data access abstraction through repository pattern',
      confidence: 0.9,
      instances: repositories.map(n => n.id),
      variations: variations.length > 0 ? variations : undefined,
      deviations: deviations.length > 0 ? deviations : undefined
    });
  }

  private detectServiceLayerPattern(nodes: CASNode[], edges: CASEdge[], patterns: CASPattern[]): void {
    const services = nodes.filter(n =>
      n.type === 'service' ||
      n.subcategories?.includes('service') ||
      (n.name.toLowerCase().endsWith('service') && n.type === 'class')
    );

    if (services.length === 0) return;

    const diServices = services.filter(n =>
      n.metadata?.annotations?.some(a => a.includes('Injectable'))
    );

    const nonDiServices = services.filter(n =>
      !n.metadata?.annotations?.some(a => a.includes('Injectable'))
    );

    const variations: CASPattern['variations'] = [];
    const deviations: CASPattern['deviations'] = [];

    if (diServices.length > 0) {
      variations.push({
        id: 'var-service-di',
        implementation: 'dependency-injection',
        description: 'Service managed by DI container',
        instances: diServices.map(n => n.id),
        percentage: Math.round((diServices.length / services.length) * 100)
      });
    }

    if (nonDiServices.length > 0) {
      variations.push({
        id: 'var-service-standalone',
        implementation: 'standalone',
        description: 'Service without DI management',
        instances: nonDiServices.map(n => n.id),
        percentage: Math.round((nonDiServices.length / services.length) * 100)
      });
    }

    if (nonDiServices.length > 0 && diServices.length > 0) {
      deviations.push({
        type: 'inconsistent-adoption',
        severity: 'info',
        description: `${nonDiServices.length} services are not using dependency injection`,
        affected_instances: nonDiServices.map(n => n.id),
        recommendation: 'Consider using @Injectable for all services for consistent dependency management'
      });
    }

    patterns.push({
      id: 'service-layer-pattern',
      name: 'Service Layer Pattern',
      description: 'Business logic encapsulated in service layer',
      confidence: 0.85,
      instances: services.map(n => n.id),
      variations: variations.length > 0 ? variations : undefined,
      deviations: deviations.length > 0 ? deviations : undefined
    });
  }

  private detectControllerPattern(nodes: CASNode[], edges: CASEdge[], patterns: CASPattern[]): void {
    const controllers = nodes.filter(n =>
      n.type === 'controller' ||
      n.subcategories?.includes('controller') ||
      n.metadata?.annotations?.some(a => a.includes('Controller'))
    );

    if (controllers.length === 0) return;

    const restControllers = controllers.filter(n =>
      n.metadata?.annotations?.some(a =>
        a.includes('Get') || a.includes('Post') || a.includes('Put') ||
        a.includes('Delete') || a.includes('Patch')
      )
    );

    const graphqlResolvers = controllers.filter(n =>
      n.metadata?.annotations?.some(a =>
        a.includes('Resolver') || a.includes('Query') || a.includes('Mutation')
      )
    );

    const variations: CASPattern['variations'] = [];

    if (restControllers.length > 0) {
      variations.push({
        id: 'var-controller-rest',
        implementation: 'rest-api',
        description: 'REST API controllers with HTTP method decorators',
        instances: restControllers.map(n => n.id),
        percentage: Math.round((restControllers.length / controllers.length) * 100)
      });
    }

    if (graphqlResolvers.length > 0) {
      variations.push({
        id: 'var-controller-graphql',
        implementation: 'graphql-resolver',
        description: 'GraphQL resolvers',
        instances: graphqlResolvers.map(n => n.id),
        percentage: Math.round((graphqlResolvers.length / controllers.length) * 100)
      });
    }

    patterns.push({
      id: 'controller-pattern',
      name: 'Controller Pattern',
      description: 'Request handling through controller pattern',
      confidence: 0.9,
      instances: controllers.map(n => n.id),
      variations: variations.length > 0 ? variations : undefined
    });
  }

  private detectDependencyInjectionPattern(nodes: CASNode[], edges: CASEdge[], patterns: CASPattern[]): void {
    const dependsOnEdges = edges.filter(e => e.type === 'depends_on');
    const injectableNodes = nodes.filter(n =>
      n.metadata?.annotations?.some(a => a.includes('Injectable')) ||
      n.subcategories?.includes('injectable')
    );

    if (dependsOnEdges.length === 0 && injectableNodes.length === 0) return;

    const constructorInjected = nodes.filter(n => {
      const incomingDeps = dependsOnEdges.filter(e => e.target === n.id);
      return incomingDeps.length > 0;
    });

    const providedByModules = nodes.filter(n =>
      edges.some(e => e.type === 'provides' && e.target === n.id)
    );

    const variations: CASPattern['variations'] = [];

    if (constructorInjected.length > 0) {
      variations.push({
        id: 'var-di-constructor',
        implementation: 'constructor-injection',
        description: 'Dependencies injected via constructor',
        instances: constructorInjected.map(n => n.id),
        percentage: injectableNodes.length > 0
          ? Math.round((constructorInjected.length / injectableNodes.length) * 100)
          : 100
      });
    }

    patterns.push({
      id: 'dependency-injection-pattern',
      name: 'Dependency Injection Pattern',
      description: 'Dependencies managed through injection container',
      confidence: 0.9,
      instances: injectableNodes.map(n => n.id),
      variations: variations.length > 0 ? variations : undefined
    });
  }

  private detectModulePattern(nodes: CASNode[], edges: CASEdge[], patterns: CASPattern[]): void {
    const modules = nodes.filter(n =>
      n.type === 'module' ||
      n.metadata?.annotations?.some(a => a.includes('Module'))
    );

    if (modules.length === 0) return;

    const featureModules = modules.filter(n =>
      !n.name.toLowerCase().includes('app') &&
      !n.name.toLowerCase().includes('root') &&
      !n.name.toLowerCase().includes('core')
    );

    const coreModules = modules.filter(n =>
      n.name.toLowerCase().includes('app') ||
      n.name.toLowerCase().includes('root') ||
      n.name.toLowerCase().includes('core')
    );

    const variations: CASPattern['variations'] = [];

    if (featureModules.length > 0) {
      variations.push({
        id: 'var-module-feature',
        implementation: 'feature-module',
        description: 'Feature-specific modules for domain separation',
        instances: featureModules.map(n => n.id),
        percentage: Math.round((featureModules.length / modules.length) * 100)
      });
    }

    if (coreModules.length > 0) {
      variations.push({
        id: 'var-module-core',
        implementation: 'core-module',
        description: 'Core/root application modules',
        instances: coreModules.map(n => n.id),
        percentage: Math.round((coreModules.length / modules.length) * 100)
      });
    }

    patterns.push({
      id: 'module-pattern',
      name: 'Module Pattern',
      description: 'Application organized into modules for encapsulation',
      confidence: 0.85,
      instances: modules.map(n => n.id),
      variations: variations.length > 0 ? variations : undefined
    });
  }

  private detectGuardPattern(nodes: CASNode[], edges: CASEdge[], patterns: CASPattern[]): void {
    const guards = nodes.filter(n =>
      n.type === 'guard' ||
      n.subcategories?.includes('guard') ||
      n.name.toLowerCase().includes('guard')
    );

    if (guards.length === 0) return;

    const authGuards = guards.filter(n =>
      n.name.toLowerCase().includes('auth') ||
      n.name.toLowerCase().includes('jwt')
    );

    const roleGuards = guards.filter(n =>
      n.name.toLowerCase().includes('role') ||
      n.name.toLowerCase().includes('permission')
    );

    const otherGuards = guards.filter(n =>
      !authGuards.includes(n) && !roleGuards.includes(n)
    );

    const variations: CASPattern['variations'] = [];

    if (authGuards.length > 0) {
      variations.push({
        id: 'var-guard-auth',
        implementation: 'authentication-guard',
        description: 'Guards for authentication verification',
        instances: authGuards.map(n => n.id),
        percentage: Math.round((authGuards.length / guards.length) * 100)
      });
    }

    if (roleGuards.length > 0) {
      variations.push({
        id: 'var-guard-role',
        implementation: 'role-based-guard',
        description: 'Guards for role/permission verification',
        instances: roleGuards.map(n => n.id),
        percentage: Math.round((roleGuards.length / guards.length) * 100)
      });
    }

    if (otherGuards.length > 0) {
      variations.push({
        id: 'var-guard-custom',
        implementation: 'custom-guard',
        description: 'Custom guards for specific validation',
        instances: otherGuards.map(n => n.id),
        percentage: Math.round((otherGuards.length / guards.length) * 100)
      });
    }

    patterns.push({
      id: 'guard-pattern',
      name: 'Guard Pattern',
      description: 'Authorization and validation through guards',
      confidence: 0.85,
      instances: guards.map(n => n.id),
      variations: variations.length > 0 ? variations : undefined
    });
  }

  private detectGodObjectAntiPattern(nodes: CASNode[], patterns: CASPattern[]): void {
    const godObjects = nodes.filter(n => {
      const lineCount = n.metadata?.metrics?.lines_of_code || 0;
      const complexity = n.metadata?.complexity?.cyclomatic || 0;
      const methodCount = nodes.filter(m => m.parent === n.id && m.type === 'method').length;

      return lineCount > 1000 || complexity > 50 || methodCount > 30;
    });

    if (godObjects.length === 0) return;

    patterns.push({
      id: 'god-object-anti-pattern',
      name: 'God Object Anti-Pattern',
      description: 'Components with excessive complexity or size',
      confidence: 0.7,
      instances: godObjects.map(n => n.id),
      deviations: [{
        type: 'anti-pattern',
        severity: 'warning',
        description: `${godObjects.length} component(s) have excessive complexity or size`,
        affected_instances: godObjects.map(n => n.id),
        recommendation: 'Consider breaking down large components into smaller, focused units'
      }]
    });
  }

  private detectCircularDependencyAntiPattern(nodes: CASNode[], edges: CASEdge[], patterns: CASPattern[]): void {
    const dependencyEdges = edges.filter(e =>
      e.type === 'depends_on' || e.type === 'imports' || e.type === 'uses'
    );

    const adjacency = new Map<string, string[]>();
    dependencyEdges.forEach(edge => {
      if (!adjacency.has(edge.source)) {
        adjacency.set(edge.source, []);
      }
      adjacency.get(edge.source)!.push(edge.target);
    });

    const visited = new Set<string>();
    const visiting = new Set<string>();
    const cycles: string[][] = [];

    const detectCycle = (nodeId: string, path: string[]): boolean => {
      if (visiting.has(nodeId)) {
        const cycleStart = path.indexOf(nodeId);
        if (cycleStart !== -1) {
          cycles.push(path.slice(cycleStart));
        }
        return true;
      }

      if (visited.has(nodeId)) return false;

      visiting.add(nodeId);
      path.push(nodeId);

      const deps = adjacency.get(nodeId) || [];
      for (const dep of deps) {
        detectCycle(dep, [...path]);
      }

      visiting.delete(nodeId);
      visited.add(nodeId);
      return false;
    };

    adjacency.forEach((_, nodeId) => {
      if (!visited.has(nodeId)) {
        detectCycle(nodeId, []);
      }
    });

    if (cycles.length === 0) return;

    const uniqueCycles = cycles.filter((cycle, i) =>
      cycles.findIndex(c => c.join('->') === cycle.join('->')) === i
    );

    patterns.push({
      id: 'circular-dependency-anti-pattern',
      name: 'Circular Dependency Anti-Pattern',
      description: 'Circular dependencies detected in component graph',
      confidence: 0.9,
      instances: [...new Set(uniqueCycles.flat())],
      deviations: uniqueCycles.map((cycle, i) => ({
        type: 'anti-pattern' as const,
        severity: 'error' as const,
        description: `Circular dependency: ${cycle.join(' -> ')} -> ${cycle[0]}`,
        affected_instances: cycle,
        recommendation: 'Break the cycle by introducing an interface or restructuring dependencies'
      }))
    });
  }

  private buildIntents(nodes: CASNode[]): CASIntent[] {
    const intents: CASIntent[] = [];

    for (const node of nodes) {
      const evidence: Array<{
        type: 'commit_message' | 'pr_description' | 'code_comment' | 'pattern_deviation' | 'naming_convention';
        source: string;
        excerpt: string;
        confidence_contribution: number;
      }> = [];

      if (node.comments && node.comments.length > 0) {
        for (const comment of node.comments) {
          if (comment.purpose === 'explanation' || comment.markers?.is_hack || comment.markers?.is_warning) {
            evidence.push({
              type: 'code_comment',
              source: comment.location?.file || node.source?.file || 'unknown',
              excerpt: comment.text.substring(0, 200),
              confidence_contribution: 0.4
            });
          }
        }
      }

      if (node.todos && node.todos.length > 0) {
        for (const todo of node.todos) {
          evidence.push({
            type: 'code_comment',
            source: todo.location?.file || node.source?.file || 'unknown',
            excerpt: `${todo.type}: ${todo.text.substring(0, 150)}`,
            confidence_contribution: 0.3
          });
        }
      }

      const workaroundPatterns = ['hack', 'workaround', 'temporary', 'legacy', 'deprecated', 'temp', 'fixme'];
      const nameLower = node.name.toLowerCase();
      const isWorkaround = workaroundPatterns.some(p => nameLower.includes(p));

      if (isWorkaround) {
        evidence.push({
          type: 'naming_convention',
          source: node.source?.file || 'unknown',
          excerpt: `Name contains workaround indicator: ${node.name}`,
          confidence_contribution: 0.2
        });
      }

      if (evidence.length > 0) {
        const totalConfidence = evidence.reduce((sum, e) => sum + e.confidence_contribution, 0);
        const confidence: 'high' | 'medium' | 'low' =
          totalConfidence >= 0.7 ? 'high' :
          totalConfidence >= 0.4 ? 'medium' : 'low';

        const intent: CASIntent = {
          node_id: node.id,
          inferred_purpose: node.description || node.documentation?.summary,
          confidence,
          workaround_indicator: isWorkaround ? {
            is_workaround: true,
            workaround_for: 'Detected from naming pattern'
          } : undefined
        };

        if (evidence.length > 0) {
          intent.architectural_decision = {
            decision: 'Implementation approach',
            evidence: evidence as any
          };
        }

        intents.push(intent);
      }
    }

    return intents;
  }

  private buildFlowSummary(nodes: CASNode[], entryPoints: CASEntryPoint[]): CASFlowSummary {
    const criticalPatterns = ['auth', 'login', 'password', 'payment', 'checkout', 'billing', 'charge', 'refund', 'token', 'session', 'oauth', 'credential'];
    const highPatterns = ['user', 'account', 'order', 'profile', 'subscription', 'permission', 'role', 'admin', 'delete', 'remove'];
    const mediumPatterns = ['create', 'update', 'modify', 'change', 'setting', 'preference'];

    const classified = {
      critical: [] as string[],
      high: [] as string[],
      medium: [] as string[],
      low: [] as string[]
    };

    for (const ep of entryPoints) {
      if (ep.type === 'test') continue;

      const path = (ep.trigger?.path || ep.name || '').toLowerCase();
      const method = ep.trigger?.method?.toUpperCase() || '';
      const hasAuth = ep.security?.authenticated || (ep as any).security?.authenticated;

      let score = 0;

      if (criticalPatterns.some(p => path.includes(p))) {
        score += 40;
      }
      if (highPatterns.some(p => path.includes(p))) {
        score += 20;
      }
      if (mediumPatterns.some(p => path.includes(p))) {
        score += 10;
      }

      if (method === 'POST' || method === 'PUT' || method === 'DELETE' || method === 'PATCH') {
        score += 15;
      }

      if (hasAuth) {
        score += 10;
      }

      if (ep.type === 'cli') {
        score += 5;
      }

      let criticality: 'critical' | 'high' | 'medium' | 'low';
      if (score >= 50) {
        criticality = 'critical';
      } else if (score >= 30) {
        criticality = 'high';
      } else if (score >= 15) {
        criticality = 'medium';
      } else {
        criticality = 'low';
      }

      classified[criticality].push(ep.id);
    }

    const totalCritical = classified.critical.length + classified.high.length;

    return {
      total_critical_flows: totalCritical,
      by_criticality: {
        critical: classified.critical.length,
        high: classified.high.length,
        medium: classified.medium.length,
        low: classified.low.length
      },
      untested_critical_flows: [],
      high_error_rate_flows: []
    };
  }

  private buildCallChains(
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[],
    _callGraph: CallGraphBuilder
  ): CASCallChain[] {
    const nodeById = new Map(nodes.map(node => [node.id, node]));
    const exitBySource = new Map<string, CASExitPoint[]>();
    for (const exitPoint of exitPoints) {
      if (!exitBySource.has(exitPoint.source_node)) {
        exitBySource.set(exitPoint.source_node, []);
      }
      exitBySource.get(exitPoint.source_node)!.push(exitPoint);
    }

    const relationshipTypes = new Set([
      'calls',
      'uses',
      'depends_on',
      'queries',
      'reads',
      'writes',
      'publishes',
      'subscribes',
      'emits',
      'handles',
      'routes_to',
      'implements',
      'implemented_by'
    ]);
    const adjacency = new Map<string, CASEdge[]>();
    for (const edge of edges) {
      if (!relationshipTypes.has(edge.type)) continue;
      if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) continue;
      if (!adjacency.has(edge.source)) adjacency.set(edge.source, []);
      adjacency.get(edge.source)!.push(edge);
    }

    const chains: CASCallChain[] = [];
    const maxDepth = 8;

    for (const entryPoint of entryPoints) {
      const startNodeId = entryPoint.handler?.node_id || entryPoint.source_node;
      const startNode = nodeById.get(startNodeId);
      if (!startNode) continue;

      const selectedPath: Array<{ nodeId: string; edge?: CASEdge }> = [{ nodeId: startNode.id }];
      const visited = new Set<string>([startNode.id]);
      let currentNodeId = startNode.id;
      let matchedExitPoint: CASExitPoint | undefined;

      for (let depth = 0; depth < maxDepth; depth++) {
        const exits = exitBySource.get(currentNodeId);
        if (exits?.length) {
          matchedExitPoint = exits[0];
          break;
        }

        const nextEdge = (adjacency.get(currentNodeId) || [])
          .filter(edge => !visited.has(edge.target))
          .sort((a, b) => this.rankChainEdge(a) - this.rankChainEdge(b))[0];

        if (!nextEdge) break;

        selectedPath.push({ nodeId: nextEdge.target, edge: nextEdge });
        visited.add(nextEdge.target);
        currentNodeId = nextEdge.target;
      }

      matchedExitPoint = matchedExitPoint || exitBySource.get(currentNodeId)?.[0];

      const pathNodes = selectedPath
        .map(step => nodeById.get(step.nodeId))
        .filter((node): node is CASNode => Boolean(node));
      const hasDatabaseCalls = Boolean(matchedExitPoint && matchedExitPoint.type === 'database') ||
        pathNodes.some(node => ['repository', 'entity', 'database', 'model'].includes(node.type));
      const hasExternalCalls = Boolean(matchedExitPoint);
      const hasAsyncCalls = pathNodes.some(node => Boolean(node.metadata?.is_async || node.metadata?.attributes?.isAsync));
      const maxPathDepth = Math.max(1, selectedPath.length - 1);
      const riskLevel = hasDatabaseCalls || hasExternalCalls || entryPoint.type === 'http' ? 'medium' : 'low';

      chains.push({
        id: `chain:${entryPoint.id}`,
        chain_type: matchedExitPoint ? 'entry-to-exit' : selectedPath.length > 1 ? 'dead-end' : 'dead-end',
        entry_point: {
          node_id: startNode.id,
          method_name: entryPoint.handler?.method_name || startNode.name,
          entry_point_id: entryPoint.id
        },
        exit_point: matchedExitPoint ? {
          node_id: matchedExitPoint.source_node,
          method_name: matchedExitPoint.operation?.action || matchedExitPoint.name,
          exit_point_id: matchedExitPoint.id
        } : undefined,
        call_path: selectedPath.map((step, index) => {
          const node = nodeById.get(step.nodeId);
          return {
            call_id: step.edge?.id || `entry:${entryPoint.id}`,
            node_id: step.nodeId,
            method_name: node?.name || step.nodeId,
            depth: index
          };
        }),
        characteristics: {
          total_calls: Math.max(0, selectedPath.length - 1),
          max_depth: maxPathDepth,
          has_external_calls: hasExternalCalls,
          has_database_calls: hasDatabaseCalls,
          has_async_calls: hasAsyncCalls,
          is_circular: false,
          is_recursive: false,
          complexity_score: maxPathDepth + (hasDatabaseCalls ? 2 : 0) + (hasExternalCalls ? 2 : 0)
        },
        risk_analysis: {
          risk_level: riskLevel,
          risk_factors: [
            ...(hasDatabaseCalls ? ['data-access'] : []),
            ...(hasExternalCalls ? ['external-boundary'] : []),
            ...(selectedPath.length === 1 ? ['unexpanded-entry-point'] : [])
          ]
        },
        criticality: entryPoint.type === 'http' ? 'medium' : 'low',
        criticality_factors: [entryPoint.type]
      });
    }

    return chains;
  }

  private rankChainEdge(edge: CASEdge): number {
    const ranks: Record<string, number> = {
      calls: 0,
      routes_to: 1,
      handles: 2,
      queries: 3,
      writes: 4,
      reads: 5,
      publishes: 6,
      emits: 7,
      depends_on: 8,
      uses: 9,
      implements: 10,
      implemented_by: 11,
      subscribes: 12
    };
    return ranks[edge.type] ?? 99;
  }

  private buildEnhancedFlowSummary(
    callChains: CASCallChain[],
    entryPoints: CASEntryPoint[]
  ): CASFlowSummary {
    const byCriticality = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0
    };

    const untestedCritical: string[] = [];
    const highErrorRate: string[] = [];

    for (const chain of callChains) {
      const crit = chain.criticality || 'low';
      byCriticality[crit]++;

      if ((crit === 'critical' || crit === 'high') && !chain.test_coverage?.covered) {
        untestedCritical.push(chain.id);
      }

      if (chain.runtime_stats?.error_rate_percent && chain.runtime_stats.error_rate_percent > 5) {
        highErrorRate.push(chain.id);
      }
    }

    return {
      total_critical_flows: byCriticality.critical + byCriticality.high,
      by_criticality: byCriticality,
      untested_critical_flows: untestedCritical,
      high_error_rate_flows: highErrorRate
    };
  }

  private enhanceChangeRisks(
    changeRisks: CASChangeRisk[],
    callGraph: CallGraphBuilder,
    callChains: CASCallChain[],
    entryPoints: CASEntryPoint[]
  ): CASChangeRisk[] {
    return changeRisks.map(risk => {
      const transitiveCallers = callGraph.getTransitiveCallers(risk.node_id);
      const affectedChains = callGraph.getAffectedCallChains(risk.node_id, callChains);
      const affectedEntries = callGraph.getEntryPointsReachingNode(risk.node_id, entryPoints);

      return {
        ...risk,
        downstream_impact: {
          ...risk.downstream_impact,
          transitive_callers: transitiveCallers,
          affected_call_chains: affectedChains,
          affected_entry_points: affectedEntries.map(e => e.id)
        }
      };
    });
  }

  private buildEnhancedSystemPurpose(
    basePurpose: SystemPurpose,
    domainConcepts: CASDomainConcept[],
    workflows: CASWorkflow[],
    workflowGraph: CASWorkflowGraph,
    domainExtractor: DomainExtractor,
    databaseEntities: string[],
    entryPointSummary: { type: string; count: number }[],
    frameworks: string[],
    externalServices: string[],
    flowGraph: CASFlowGraph
  ): EnhancedSystemPurpose {
    const coreConcepts = domainExtractor.getCoreConcepts(domainConcepts);
    const primaryDomain = domainExtractor.inferPrimaryDomain(domainConcepts);

    const description = this.buildQuickDescription(
      basePurpose,
      flowGraph,
      databaseEntities,
      entryPointSummary,
      frameworks,
      externalServices
    );

    const supportingWorkflows = workflows.filter(w => w.classification === 'supporting');

    return {
      ...basePurpose,
      primary_domain: primaryDomain,
      core_concepts: coreConcepts.slice(0, 10).map(c => c.name),
      inferred_description: description,
      primary_workflow_id: workflowGraph.primary_workflow_id,
      supporting_workflow_ids: supportingWorkflows.map(w => w.id)
    };
  }

  private buildQuickDescription(
    systemPurpose: SystemPurpose,
    flowGraph: CASFlowGraph,
    databaseEntities: string[],
    entryPoints: { type: string; count: number }[],
    frameworks: string[],
    externalServices: string[]
  ): string {
    const parts: string[] = [];

    const typeLabel = systemPurpose.primary_type.replace(/-/g, ' ');
    parts.push(`A ${typeLabel} system`);

    if (frameworks.length > 0) {
      parts.push(`built with ${frameworks.slice(0, 3).join(', ')}`);
    }

    const details: string[] = [];

    if (flowGraph.capabilities.length > 0) {
      const topCaps = [...flowGraph.capabilities]
        .sort((a, b) => b.signals.total_score - a.signals.total_score)
        .slice(0, 5)
        .map(c => c.name.toLowerCase().replace(/_/g, ' '));
      details.push(`Key capabilities: ${topCaps.join(', ')}`);
    }

    if (databaseEntities.length > 0) {
      details.push(`Data model: ${databaseEntities.slice(0, 5).join(', ')}${databaseEntities.length > 5 ? ` (+${databaseEntities.length - 5} more)` : ''}`);
    }

    if (entryPoints.length > 0) {
      const epSummary = entryPoints.map(ep => `${ep.count} ${ep.type}`).join(', ');
      details.push(`Entry points: ${epSummary}`);
    }

    if (externalServices.length > 0) {
      details.push(`Integrations: ${externalServices.slice(0, 3).join(', ')}`);
    }

    return parts.join(' ') + '. ' + details.join('. ') + '.';
  }


  private summarizeEntryPoints(entryPoints: CASEntryPoint[]): { type: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const ep of entryPoints) {
      counts.set(ep.type, (counts.get(ep.type) || 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count);
  }

  private buildFlowGraph(
    entryPoints: CASEntryPoint[],
    callChains: CASCallChain[],
    nodes: CASNode[],
    edges: CASEdge[],
    domainConcepts: CASDomainConcept[],
    dataEntities: CASDataEntity[],
    databaseSchema: CASDatabaseSchema,
    systemPurpose: SystemPurpose
  ): CASFlowGraph {
    const capabilityDetector = new CapabilityDetector();
    const capabilities = capabilityDetector.detectCapabilities(
      entryPoints,
      callChains,
      nodes,
      edges,
      domainConcepts,
      dataEntities
    );

    const chainAnalyzer = new CallChainAnalyzer();
    for (const cap of capabilities) {
      cap.complexity_profile = chainAnalyzer.analyzeCapabilityChains(cap, callChains, nodes);
    }

    const dependencyBuilder = new CapabilityDependencyBuilder();
    const dependencies = dependencyBuilder.buildDependencies(
      capabilities,
      nodes,
      edges,
      dataEntities,
      databaseSchema
    );

    for (const dep of dependencies) {
      const fromCap = capabilities.find(c => c.id === dep.from_capability);
      if (fromCap) {
        fromCap.depends_on.push(dep);
      }

      const toCap = capabilities.find(c => c.id === dep.to_capability);
      if (toCap) {
        toCap.depended_by.push(dep.from_capability);
      }
    }

    const scorer = new FlowScorer();
    scorer.scoreCapabilities(capabilities, domainConcepts, systemPurpose);

    const graphBuilder = new FlowGraphBuilder();
    return graphBuilder.buildFlowGraph(capabilities, dependencies, systemPurpose);
  }

  private buildChangeRisks(nodes: CASNode[], edges: CASEdge[], entryPoints: CASEntryPoint[], gitAnalyzer: GitAnalyzer): CASChangeRisk[] {
    const changeRisks: CASChangeRisk[] = [];
    const callerCounts = new Map<string, string[]>();
    const gitAvailable = gitAnalyzer.isAvailable();

    for (const edge of edges) {
      if (edge.type === 'calls' || edge.type === 'uses' || edge.type === 'depends_on') {
        if (!callerCounts.has(edge.target)) {
          callerCounts.set(edge.target, []);
        }
        callerCounts.get(edge.target)!.push(edge.source);
      }
    }

    const riskableNodeTypes = [
      'function', 'method', 'service', 'controller', 'serializer',
      'entity', 'model', 'route', 'handler', 'resolver', 'mutation'
    ];

    for (const node of nodes) {
      if (!riskableNodeTypes.includes(node.type)) {
        continue;
      }

      const directCallers = callerCounts.get(node.id) || [];
      const isEntryRelated = node.type === 'controller' || node.type === 'route' || node.type === 'handler';
      const isDataRelated = node.type === 'entity' || node.type === 'model' || node.type === 'serializer';

      if (directCallers.length < 2 && !node.metadata?.is_exported && !isEntryRelated && !isDataRelated) {
        continue;
      }

      const filePath = node.source?.file;
      const gitMetrics = filePath && gitAvailable ? gitAnalyzer.getFileMetrics(filePath) : null;

      const riskFactors: Array<{
        factor: 'many-callers' | 'critical-path' | 'high-traffic' | 'no-tests' | 'recent-bugs' | 'complex-logic' | 'external-dependency' | 'security-sensitive';
        severity: 'high' | 'medium' | 'low';
        details: string;
      }> = [];

      if (directCallers.length > 10) {
        riskFactors.push({
          factor: 'many-callers',
          severity: 'high',
          details: `Called by ${directCallers.length} functions`
        });
      } else if (directCallers.length > 5) {
        riskFactors.push({
          factor: 'many-callers',
          severity: 'medium',
          details: `Called by ${directCallers.length} functions`
        });
      }

      const complexity = node.metadata?.complexity?.cyclomatic || 0;
      if (complexity > 20) {
        riskFactors.push({
          factor: 'complex-logic',
          severity: 'high',
          details: `Cyclomatic complexity: ${complexity}`
        });
      } else if (complexity > 10) {
        riskFactors.push({
          factor: 'complex-logic',
          severity: 'medium',
          details: `Cyclomatic complexity: ${complexity}`
        });
      }

      const hasExternalDep = edges.some(e =>
        e.source === node.id && (e.type === 'external_call' || e.category === 'external')
      );
      if (hasExternalDep) {
        riskFactors.push({
          factor: 'external-dependency',
          severity: 'medium',
          details: 'Has external service dependencies'
        });
      }

      if (node.security?.authentication_required || node.security?.authorization_roles) {
        riskFactors.push({
          factor: 'security-sensitive',
          severity: 'high',
          details: 'Handles security-sensitive operations'
        });
      }

      if (gitMetrics && gitMetrics.bugFixRate > 0.3) {
        riskFactors.push({
          factor: 'recent-bugs',
          severity: 'high',
          details: `Bug fix density: ${Math.round(gitMetrics.bugFixRate * 100)}% of commits are bug fixes`
        });
      }

      if (!node.testing?.tested_by?.length) {
        riskFactors.push({
          factor: 'no-tests',
          severity: 'high',
          details: 'No direct test coverage detected'
        });
      }

      if (riskFactors.length === 0) continue;

      const highSeverityCount = riskFactors.filter(f => f.severity === 'high').length;
      const riskLevel: 'critical' | 'high' | 'medium' | 'low' =
        highSeverityCount >= 2 ? 'critical' :
        highSeverityCount === 1 ? 'high' :
        riskFactors.length >= 2 ? 'medium' : 'low';

      changeRisks.push({
        node_id: node.id,
        risk_level: riskLevel,
        risk_factors: riskFactors as any,
        downstream_impact: {
          direct_callers: directCallers,
          transitive_callers: [],
          affected_call_chains: [],
          affected_entry_points: []
        },
        test_protection: {
          has_direct_tests: node.testing?.tested_by?.length ? node.testing.tested_by.length > 0 : false,
          has_integration_tests: false,
          test_ids: node.testing?.tested_by
        },
        stability_context: {
          recent_churn: gitMetrics ? gitMetrics.isHighChurn : false,
          commit_count_30d: gitMetrics?.commits30d || 0,
          bug_fix_density: gitMetrics?.bugFixRate || 0,
          last_refactor: gitMetrics?.lastMajorChange || undefined
        }
      });
    }

    return changeRisks;
  }

  private buildChangeRiskSummary(changeRisks: CASChangeRisk[]): CASChangeRiskSummary {
    return {
      high_risk_nodes: changeRisks
        .filter(r => r.risk_level === 'critical' || r.risk_level === 'high')
        .map(r => r.node_id),
      untested_critical_paths: changeRisks
        .filter(r => r.risk_level === 'critical' && !r.test_protection.has_direct_tests)
        .map(r => r.node_id),
      recent_hotspots: changeRisks
        .filter(r => r.stability_context.recent_churn)
        .map(r => r.node_id)
    };
  }

  private buildDataEntities(nodes: CASNode[], edges: CASEdge[]): CASDataEntity[] {
    const entities: CASDataEntity[] = [];

    const entityNodes = nodes.filter(n =>
      n.type === 'entity' ||
      n.type === 'model' ||
      n.subcategories?.includes('entity') ||
      (n.type === 'class' && n.source?.file?.includes('/entities/'))
    );

    for (const entityNode of entityNodes) {
      const fields: Array<{
        name: string;
        type: string;
        is_sensitive: boolean;
        validation?: string[];
      }> = [];

      const propertyNodes = this.entityPropertyNodes(nodes, entityNode);

      const sensitivePatterns = [
        'password', 'secret', 'token', 'key', 'credential',
        'ssn', 'social_security', 'tax_id',
        'email', 'phone', 'address',
        'card', 'cvv', 'account_number'
      ];

      for (const prop of propertyNodes) {
        const nameLower = prop.name.toLowerCase();
        const isSensitive = sensitivePatterns.some(p => nameLower.includes(p));

        fields.push({
          name: prop.name,
          type: prop.signature?.return_type || 'unknown',
          is_sensitive: isSensitive
        });
      }

      const createdBy: string[] = [];
      const readBy: string[] = [];
      const updatedBy: string[] = [];
      const deletedBy: string[] = [];

      for (const edge of edges) {
        if (edge.target === entityNode.id || edge.source === entityNode.id) {
          const relatedNode = nodes.find(n =>
            n.id === (edge.target === entityNode.id ? edge.source : edge.target)
          );
          if (relatedNode) {
            const methodLower = relatedNode.name.toLowerCase();
            if (methodLower.includes('create') || methodLower.includes('add') || methodLower.includes('insert')) {
              createdBy.push(relatedNode.id);
            } else if (methodLower.includes('get') || methodLower.includes('find') || methodLower.includes('read') || methodLower.includes('fetch')) {
              readBy.push(relatedNode.id);
            } else if (methodLower.includes('update') || methodLower.includes('set') || methodLower.includes('modify')) {
              updatedBy.push(relatedNode.id);
            } else if (methodLower.includes('delete') || methodLower.includes('remove')) {
              deletedBy.push(relatedNode.id);
            }
          }
        }
      }

      entities.push({
        id: `entity_${entityNode.name.toLowerCase()}`,
        name: entityNode.name,
        schema_source: entityNode.source?.file,
        fields: fields.length > 0 ? fields : undefined,
        lifecycle: {
          created_by: [...new Set(createdBy)],
          read_by: [...new Set(readBy)],
          updated_by: [...new Set(updatedBy)],
          deleted_by: [...new Set(deletedBy)]
        }
      });
    }

    return entities;
  }

  private buildDataSummary(entities: CASDataEntity[], nodes: CASNode[]): CASDataSummary {
    const sensitiveDataNodes: string[] = [];

    for (const entity of entities) {
      if (entity.fields?.some(f => f.is_sensitive)) {
        sensitiveDataNodes.push(
          ...entity.lifecycle.created_by,
          ...entity.lifecycle.read_by,
          ...entity.lifecycle.updated_by
        );
      }
    }

    return {
      entities,
      sensitive_data_nodes: [...new Set(sensitiveDataNodes)],
      validation_gaps: []
    };
  }

  private buildBehavioralInvariants(
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    databaseSchema: CASDatabaseSchema,
    dataEntities: CASDataEntity[],
    securityBoundaries: CASSecurityBoundary[],
    testSuites: CASTestSuite[],
    projectPath: string
  ): CASBehavioralInvariant[] {
    const invariants: CASBehavioralInvariant[] = [];
    const migrationFiles = this.detectMigrationFiles(nodes, projectPath);

    for (const entity of this.scopedEntities(databaseSchema, dataEntities)) {
      const scopeFields = entity.fields.filter(field => this.isScopeField(field.name));
      const uniqueFields = entity.fields.filter(field => field.unique && !this.isScopeField(field.name));
      const relatedNodes = this.nodesRelatedToEntity(nodes, entity.name);
      const scopedCodeNodes = relatedNodes.filter(node => this.nodeText(node).match(/\b(tenant|organization|organisation|org|workspace|account|company)id\b/i));
      const relatedTests = this.testsRelatedToInvariant(testSuites, [
        entity.name,
        ...scopeFields.map(field => field.name),
        ...uniqueFields.map(field => field.name),
      ]);
      const gaps = [
        ...(scopedCodeNodes.length === 0 ? [`No code enforcement found for ${entity.name} tenant/organization scope.`] : []),
        ...uniqueFields.map(field => `Unique field ${field.name} appears on tenant-scoped entity ${entity.name}; verify a composite unique constraint or service preflight includes ${scopeFields.map(scope => scope.name).join(', ')}.`),
        ...(relatedTests.length === 0 ? [`No tests found that mention ${entity.name} scope or uniqueness.`] : []),
      ];

      invariants.push({
        id: `invariant_tenant_scope_${this.slugForId(entity.name)}`,
        name: `${entity.name} tenant/organization scope`,
        invariant_type: 'tenant-scope',
        description: `${entity.name} records appear scoped by ${scopeFields.map(field => field.name).join(', ')}, so reads and uniqueness checks should preserve that scope.`,
        scope: {
          entity_names: [entity.name],
          field_names: [...scopeFields.map(field => field.name), ...uniqueFields.map(field => field.name)],
          node_ids: relatedNodes.map(node => node.id).slice(0, 30),
          file_paths: [...new Set([entity.source_file, ...relatedNodes.map(node => node.source?.file)].filter((file): file is string => Boolean(file)))],
        },
        enforcement: [
          ...scopeFields.map(field => ({
            source: 'database-schema' as const,
            mechanism: `${field.name} scopes ${entity.name}`,
            confidence: 'inferred' as const,
            file: entity.source_file,
          })),
          ...scopedCodeNodes.slice(0, 12).map(node => ({
            source: 'code' as const,
            mechanism: `${node.name} references tenant/organization scope`,
            confidence: 'inferred' as const,
            node_id: node.id,
            file: node.source?.file,
            line: node.source?.line,
          })),
        ],
        evidence: [
          ...scopeFields.map(field => ({
            source: 'database_schema' as const,
            id: `${entity.name}.${field.name}`,
            file: entity.source_file,
          })),
          ...scopedCodeNodes.slice(0, 8).map(node => ({
            source: 'node' as const,
            id: node.id,
            file: node.source?.file,
            line: node.source?.line,
          })),
        ],
        related_tests: relatedTests,
        related_entities: [entity.name],
        gaps,
        confidence: scopedCodeNodes.length > 0 && gaps.length <= uniqueFields.length ? 'medium' : 'low',
      });
    }

    for (const entity of databaseSchema.entities || []) {
      for (const field of entity.fields || []) {
        if (!field.primary && !field.unique && field.nullable === undefined && field.default === undefined) continue;
        const mechanisms = [
          field.primary ? 'primary key' : '',
          field.unique ? 'unique' : '',
          field.nullable === false ? 'not nullable' : '',
          field.default ? `default ${field.default}` : '',
        ].filter(Boolean);
        invariants.push({
          id: `invariant_db_constraint_${this.slugForId(entity.name)}_${this.slugForId(field.name)}`,
          name: `${entity.name}.${field.name} database constraint`,
          invariant_type: 'db-constraint',
          description: `${entity.name}.${field.name} has database/ORM constraint semantics: ${mechanisms.join(', ')}.`,
          scope: {
            entity_names: [entity.name],
            field_names: [field.name],
            file_paths: entity.source_file ? [entity.source_file] : undefined,
          },
          enforcement: [{
            source: 'database-schema',
            mechanism: mechanisms.join(', '),
            confidence: 'enforced',
            file: entity.source_file,
          }],
          evidence: [{
            source: 'database_schema',
            id: `${entity.name}.${field.name}`,
            file: entity.source_file,
          }],
          related_tests: this.testsRelatedToInvariant(testSuites, [entity.name, field.name]),
          related_entities: [entity.name],
          confidence: 'high',
        });
      }
    }

    for (const boundary of securityBoundaries) {
      invariants.push({
        id: `invariant_security_${this.slugForId(boundary.id)}`,
        name: boundary.name,
        invariant_type: boundary.boundary_type === 'authorization' ? 'authorization' : 'auth-boundary',
        description: `${boundary.name} moves trust from ${boundary.trust_transition.from_trust_level} to ${boundary.trust_transition.to_trust_level}.`,
        scope: {
          node_ids: boundary.enforcement_points.map(point => point.node_id).filter(id => id !== 'entry_point_security'),
          entry_point_ids: entryPoints
            .filter(entry => boundary.sensitive_operations.includes(entry.source_node))
            .map(entry => entry.id),
        },
        enforcement: boundary.enforcement_points.map(point => ({
          source: 'security-boundary',
          mechanism: point.mechanism,
          confidence: point.confidence === 'enforced' ? 'enforced' : point.confidence === 'missing' ? 'missing' : 'inferred',
          node_id: point.node_id === 'entry_point_security' ? undefined : point.node_id,
        })),
        evidence: boundary.enforcement_points.map(point => ({
          source: 'security_boundary' as const,
          id: boundary.id,
          file: this.nodeFile(nodes, point.node_id),
          line: this.nodeLine(nodes, point.node_id),
        })),
        related_boundaries: [boundary.id],
        gaps: boundary.bypass_risks,
        confidence: boundary.enforcement_points.some(point => point.confidence === 'enforced') ? 'high' : 'medium',
      });
    }

    if ((databaseSchema.entities || []).length > 0) {
      invariants.push({
        id: 'invariant_database_migrations',
        name: 'Database schema changes use migrations',
        invariant_type: 'migration-contract',
        description: 'Database shape is represented by ORM schema and should be changed through migration files.',
        scope: {
          entity_names: (databaseSchema.entities || []).map(entity => entity.name),
          file_paths: migrationFiles,
        },
        enforcement: migrationFiles.length > 0
          ? migrationFiles.slice(0, 20).map(file => ({
            source: 'migration' as const,
            mechanism: 'Migration file present',
            confidence: 'enforced' as const,
            file,
          }))
          : [{
            source: 'migration' as const,
            mechanism: 'No migration files detected for database schema',
            confidence: 'missing' as const,
          }],
        evidence: migrationFiles.slice(0, 20).map(file => ({
          source: 'migration_file' as const,
          file,
        })),
        gaps: migrationFiles.length === 0 ? ['Database schema exists but no migration files were detected.'] : undefined,
        confidence: migrationFiles.length > 0 ? 'high' : 'low',
      });
    }

    const coveredNodeIds = new Set<string>();
    for (const suite of testSuites) {
      for (const nodeId of suite.coverage?.nodes_tested || []) coveredNodeIds.add(nodeId);
      for (const test of suite.tests || []) {
        for (const nodeId of test.targets || []) coveredNodeIds.add(nodeId);
      }
    }
    const behaviorNodes = nodes.filter(node => this.isBehaviorNode(node));
    if (behaviorNodes.length > 0 || testSuites.length > 0) {
      const untested = behaviorNodes.filter(node => !coveredNodeIds.has(node.id)).slice(0, 20);
      invariants.push({
        id: 'invariant_behavior_test_coverage',
        name: 'Behavioral code has test coverage evidence',
        invariant_type: 'test-coverage',
        description: 'Controllers, services, repositories, guards, and handlers should have direct or related test evidence.',
        scope: {
          node_ids: behaviorNodes.slice(0, 50).map(node => node.id),
          file_paths: testSuites.slice(0, 20).map(suite => suite.file_path),
        },
        enforcement: testSuites.slice(0, 20).map(suite => ({
          source: 'test' as const,
          mechanism: `${suite.framework} ${suite.test_type} suite ${suite.name}`,
          confidence: 'enforced' as const,
          file: suite.file_path,
        })),
        evidence: testSuites.slice(0, 20).map(suite => ({
          source: 'test_suite' as const,
          id: suite.id,
          file: suite.file_path,
        })),
        related_tests: testSuites.slice(0, 20).map(suite => suite.file_path),
        gaps: untested.length > 0 ? untested.map(node => `${node.name} has no direct test coverage evidence.`) : undefined,
        confidence: testSuites.length > 0 ? 'medium' : 'low',
      });
    }

    return this.dedupeBehavioralInvariants(invariants);
  }

  private buildBehavioralInvariantSummary(invariants: CASBehavioralInvariant[]): CASBehavioralInvariantSummary {
    const byType: Record<string, number> = {};
    const byConfidence: Record<string, number> = {};
    let enforced = 0;
    let inferred = 0;
    let missing = 0;

    for (const invariant of invariants) {
      byType[invariant.invariant_type] = (byType[invariant.invariant_type] || 0) + 1;
      byConfidence[invariant.confidence] = (byConfidence[invariant.confidence] || 0) + 1;
      for (const enforcement of invariant.enforcement) {
        if (enforcement.confidence === 'enforced') enforced++;
        else if (enforcement.confidence === 'missing') missing++;
        else inferred++;
      }
    }

    return {
      total: invariants.length,
      by_type: byType,
      by_confidence: byConfidence,
      enforced,
      inferred,
      missing,
      gaps: invariants.flatMap(invariant => (invariant.gaps || []).map(gap => ({
        invariant_id: invariant.id,
        gap,
        severity: this.invariantGapSeverity(invariant, gap),
      }))),
    };
  }

  private scopedEntities(databaseSchema: CASDatabaseSchema, dataEntities: CASDataEntity[]) {
    const byName = new Map<string, {
      name: string;
      source_file?: string;
      fields: Array<{ name: string; unique?: boolean; primary?: boolean }>;
    }>();

    for (const entity of databaseSchema.entities || []) {
      byName.set(entity.name, {
        name: entity.name,
        source_file: entity.source_file,
        fields: [
          ...(entity.fields || []).map(field => ({
            name: field.name,
            unique: field.unique,
            primary: field.primary,
          })),
          ...(entity.relationships || []).map(relationship => ({
            name: relationship.field,
          })),
        ],
      });
    }

    for (const entity of dataEntities || []) {
      const existing = byName.get(entity.name) || {
        name: entity.name,
        source_file: entity.schema_source,
        fields: [],
      };
      existing.fields = [
        ...existing.fields,
        ...((entity.fields || []).map(field => ({ name: field.name }))),
      ];
      byName.set(entity.name, existing);
    }

    return [...byName.values()]
      .map(entity => ({
        ...entity,
        fields: this.uniqueFields(entity.fields),
      }))
      .filter(entity => entity.fields.some(field => this.isScopeField(field.name)));
  }

  private uniqueFields(fields: Array<{ name: string; unique?: boolean; primary?: boolean }>) {
    const byName = new Map<string, { name: string; unique?: boolean; primary?: boolean }>();
    for (const field of fields) {
      const key = field.name.toLowerCase();
      const existing = byName.get(key);
      byName.set(key, {
        name: existing?.name || field.name,
        unique: Boolean(existing?.unique || field.unique),
        primary: Boolean(existing?.primary || field.primary),
      });
    }
    return [...byName.values()];
  }

  private isScopeField(name: string): boolean {
    return /^(tenant|tenantid|tenant_id|organization|organizationid|organization_id|organisation|orgid|org_id|workspace|workspaceid|workspace_id|account|accountid|account_id|company|companyid|company_id)$/i.test(name);
  }

  private nodesRelatedToEntity(nodes: CASNode[], entityName: string): CASNode[] {
    const entitySlug = entityName.toLowerCase();
    return nodes.filter(node => {
      const nameText = [
        node.name,
        node.qualified_name,
        node.type,
        ...(node.tags || []),
        ...(node.subcategories || []),
      ].filter(Boolean).join(' ').toLowerCase();
      const file = (node.source?.file || '').replace(/\\/g, '/').toLowerCase();
      const fileBase = file.split('/').pop() || '';
      const fileSegments = file.split('/').filter(Boolean);
      const exactName = new RegExp(`(^|[^a-z0-9])${entitySlug}([^a-z0-9]|$)`).test(nameText);
      const entityDirectory = fileSegments.includes(entitySlug);
      const entityFile = fileBase === `${entitySlug}.ts` ||
        fileBase === `${entitySlug}.js` ||
        fileBase === `${entitySlug}.entity.ts` ||
        fileBase === `${entitySlug}.model.ts` ||
        fileBase.startsWith(`${entitySlug}.`) ||
        fileBase.startsWith(`${entitySlug}-`) ||
        fileBase.startsWith(`${entitySlug}_`);
      const pluralDirectory = entitySlug.length > 4 && fileSegments.includes(`${entitySlug}s`);
      return exactName || entityDirectory || entityFile || pluralDirectory;
    });
  }

  private testsRelatedToInvariant(testSuites: CASTestSuite[], keywords: string[]): string[] {
    const terms = keywords.map(keyword => keyword.toLowerCase()).filter(Boolean);
    return [...new Set(testSuites
      .filter(suite => {
        const text = [
          suite.name,
          suite.file_path,
          ...(suite.tests || []).map(test => test.name),
          ...(suite.tests || []).flatMap(test => test.assertions?.map(assertion => assertion.description || assertion.target || '') || []),
        ].join(' ').toLowerCase();
        return terms.some(term => text.includes(term));
      })
      .map(suite => suite.file_path))];
  }

  private detectMigrationFiles(nodes: CASNode[], projectPath: string): string[] {
    const fromNodes = nodes
      .map(node => node.source?.file)
      .filter((file): file is string => Boolean(file))
      .filter(file => this.isMigrationFile(file));
    const fromDisk = [
      'migrations/**/*',
      'migration/**/*',
      'database/migrations/**/*',
      'prisma/migrations/**/*',
      'db/migrations/**/*',
      'src/migrations/**/*',
    ].flatMap(pattern => {
      try {
        return glob.sync(pattern, {
          cwd: projectPath,
          nodir: true,
          ignore: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.git/**'],
        });
      } catch {
        return [];
      }
    });
    return [...new Set([...fromNodes, ...fromDisk].map(file => file.replace(/\\/g, '/')))].slice(0, 100);
  }

  private isMigrationFile(file: string): boolean {
    const lower = file.toLowerCase();
    return lower.includes('/migrations/') ||
      lower.includes('/migration/') ||
      lower.includes('prisma/migrations') ||
      /(^|\/)\d{8,}.*\.(ts|js|sql|php|py)$/.test(lower);
  }

  private isBehaviorNode(node: CASNode): boolean {
    if (node.source?.file && this.isMigrationFile(node.source.file)) return false;
    if (node.name === 'constructor' || node.name === 'up' || node.name === 'down') return false;
    return ['controller', 'service', 'repository', 'guard', 'middleware', 'handler', 'resolver', 'gateway'].includes(node.type) ||
      Boolean(node.subcategories?.some(category => ['controller', 'service', 'repository', 'guard', 'middleware'].includes(category)));
  }

  private nodeText(node: CASNode): string {
    return [
      node.id,
      node.name,
      node.qualified_name,
      node.type,
      node.category,
      node.source?.file,
      node.signature?.return_type,
      ...(node.tags || []),
      ...(node.subcategories || []),
      ...(node.metadata?.annotations || []),
      ...Object.values((node.metadata?.attributes || {}) as Record<string, any>).map(value => String(value)),
    ].filter(Boolean).join(' ').toLowerCase();
  }

  private dedupeBehavioralInvariants(invariants: CASBehavioralInvariant[]): CASBehavioralInvariant[] {
    const seen = new Set<string>();
    const unique: CASBehavioralInvariant[] = [];
    for (const invariant of invariants) {
      if (seen.has(invariant.id)) continue;
      seen.add(invariant.id);
      unique.push(invariant);
    }
    return unique;
  }

  private invariantGapSeverity(invariant: CASBehavioralInvariant, gap: string): 'high' | 'medium' | 'low' {
    if (invariant.invariant_type === 'tenant-scope' && gap.toLowerCase().includes('unique')) return 'high';
    if (invariant.invariant_type === 'auth-boundary' || invariant.invariant_type === 'authorization') return 'high';
    if (invariant.invariant_type === 'migration-contract') return 'medium';
    return 'low';
  }

  private buildSecurityBoundaries(nodes: CASNode[], entryPoints: CASEntryPoint[]): CASSecurityBoundary[] {
    const boundaries: CASSecurityBoundary[] = [];

    const securityNodes = nodes.filter(n => {
      const nameLower = n.name.toLowerCase();
      const qualifiedLower = (n.qualified_name || '').toLowerCase();
      return n.type === 'guard' ||
             n.subcategories?.includes('guard') ||
             n.subcategories?.includes('middleware') ||
             n.subcategories?.includes('permission') ||
             nameLower.includes('guard') ||
             nameLower.includes('permission') ||
             nameLower.includes('authenticat') ||
             nameLower.includes('authoriz') ||
             qualifiedLower.includes('permission') ||
             qualifiedLower.includes('middleware');
    });

    const authNodes = securityNodes.filter(n => {
      const nameLower = n.name.toLowerCase();
      return nameLower.includes('auth') ||
             nameLower.includes('jwt') ||
             nameLower.includes('login') ||
             nameLower.includes('session') ||
             nameLower.includes('token') ||
             nameLower.includes('isauthenticated');
    });

    const authenticatedEntryPoints = entryPoints.filter(ep => ep.security?.authenticated);

    if (authNodes.length > 0 || authenticatedEntryPoints.length > 0) {
      const enforcementPoints: Array<{
        node_id: string;
        mechanism: string;
        confidence: 'enforced' | 'assumed' | 'missing';
      }> = authNodes.map(g => ({
        node_id: g.id,
        mechanism: this.inferAuthMechanism(g),
        confidence: 'enforced' as const
      }));

      if (enforcementPoints.length === 0 && authenticatedEntryPoints.length > 0) {
        enforcementPoints.push({
          node_id: 'entry_point_security',
          mechanism: 'Entry point authentication markers',
          confidence: 'assumed'
        });
      }

      boundaries.push({
        id: 'boundary_auth',
        name: 'Authentication Boundary',
        boundary_type: 'authentication',
        enforcement_points: enforcementPoints,
        trust_transition: {
          from_trust_level: 'untrusted',
          to_trust_level: 'partially-trusted'
        },
        sensitive_operations: authenticatedEntryPoints.map(ep => ep.source_node)
      });
    }

    const permissionNodes = securityNodes.filter(n => {
      const nameLower = n.name.toLowerCase();
      return nameLower.includes('role') ||
             nameLower.includes('permission') ||
             nameLower.includes('crud') ||
             nameLower.includes('access') ||
             nameLower.includes('policy');
    });

    if (permissionNodes.length > 0) {
      boundaries.push({
        id: 'boundary_authz',
        name: 'Authorization Boundary',
        boundary_type: 'authorization',
        enforcement_points: permissionNodes.map(g => ({
          node_id: g.id,
          mechanism: this.inferAuthzMechanism(g),
          confidence: 'enforced' as const
        })),
        trust_transition: {
          from_trust_level: 'partially-trusted',
          to_trust_level: 'trusted'
        },
        sensitive_operations: []
      });
    }

    const middlewareNodes = nodes.filter(n =>
      n.type === 'middleware' ||
      n.subcategories?.includes('middleware') ||
      n.name.toLowerCase().includes('middleware')
    );

    if (middlewareNodes.length > 0) {
      const securityMiddleware = middlewareNodes.filter(m => {
        const nameLower = m.name.toLowerCase();
        return nameLower.includes('security') ||
               nameLower.includes('cors') ||
               nameLower.includes('csrf') ||
               nameLower.includes('xss') ||
               nameLower.includes('helmet');
      });

      if (securityMiddleware.length > 0) {
        boundaries.push({
          id: 'boundary_security_middleware',
          name: 'Security Middleware Boundary',
          boundary_type: 'input-validation',
          enforcement_points: securityMiddleware.map(m => ({
            node_id: m.id,
            mechanism: `Security middleware: ${m.name}`,
            confidence: 'enforced' as const
          })),
          trust_transition: {
            from_trust_level: 'untrusted',
            to_trust_level: 'partially-trusted'
          },
          sensitive_operations: []
        });
      }
    }

    return boundaries;
  }

  private inferAuthMechanism(node: CASNode): string {
    const nameLower = node.name.toLowerCase();
    if (nameLower.includes('jwt')) return 'JWT validation';
    if (nameLower.includes('session')) return 'Session-based authentication';
    if (nameLower.includes('token')) return 'Token-based authentication';
    if (nameLower.includes('oauth')) return 'OAuth authentication';
    if (nameLower.includes('login')) return 'Login authentication';
    return 'Authentication check';
  }

  private inferAuthzMechanism(node: CASNode): string {
    const nameLower = node.name.toLowerCase();
    if (nameLower.includes('role')) return 'Role-based access control';
    if (nameLower.includes('permission')) return 'Permission-based access control';
    if (nameLower.includes('crud')) return 'CRUD permission enforcement';
    if (nameLower.includes('policy')) return 'Policy-based access control';
    return 'Authorization check';
  }

  private buildSecuritySummary(boundaries: CASSecurityBoundary[], nodes: CASNode[]): CASSecuritySummary {
    let enforced = 0;
    let assumed = 0;
    let missing = 0;

    for (const boundary of boundaries) {
      for (const point of boundary.enforcement_points) {
        if (point.confidence === 'enforced') enforced++;
        else if (point.confidence === 'assumed') assumed++;
        else missing++;
      }
    }

    return {
      boundaries,
      unprotected_sensitive_ops: [],
      assumed_vs_enforced: { enforced, assumed, missing }
    };
  }

  private buildFlowCoverage(
    nodes: CASNode[],
    entryPoints: CASEntryPoint[],
    callChains: CASCallChain[]
  ): CASFlowCoverage[] {
    const flowCoverage: CASFlowCoverage[] = [];

    const testedNodes = new Set<string>();
    const testNodeIds = new Set<string>();

    for (const ep of entryPoints) {
      if (ep.type === 'test') {
        if (ep.connected_nodes) {
          ep.connected_nodes.forEach(n => testedNodes.add(n));
        }
        testNodeIds.add(ep.source_node);
      }
    }

    for (const node of nodes) {
      if (node.testing?.tested_by && node.testing.tested_by.length > 0) {
        testedNodes.add(node.id);
        for (const testId of node.testing.tested_by) {
          testNodeIds.add(testId);
        }
      }
    }

    for (const chain of callChains) {
      if (!chain.call_path || chain.call_path.length === 0) continue;

      const chainNodeIds = chain.call_path.map(s => s.node_id);
      const testedSegments: CASFlowCoverage['tested_segments'] = [];
      const untestedSegments: CASFlowCoverage['untested_segments'] = [];

      for (const nodeId of chainNodeIds) {
        if (testedNodes.has(nodeId)) {
          testedSegments.push({
            node_id: nodeId,
            test_ids: [],
            assertion_count: 0
          });
        } else {
          const node = nodes.find(n => n.id === nodeId);
          const isSecurityRelated = node?.name?.toLowerCase().includes('auth') ||
            node?.name?.toLowerCase().includes('password');

          untestedSegments.push({
            node_id: nodeId,
            importance: isSecurityRelated ? 'critical' : 'medium',
            reason: `Node ${node?.name || nodeId} lacks test coverage`
          });
        }
      }

      const coveragePct = chainNodeIds.length > 0
        ? testedSegments.length / chainNodeIds.length
        : 0;

      const coverageStatus: CASFlowCoverage['coverage_status'] =
        coveragePct >= 1.0 ? 'fully-covered' :
        coveragePct > 0 ? 'partially-covered' : 'not-covered';

      const hasTestNodes = chainNodeIds.some(id => testNodeIds.has(id));

      flowCoverage.push({
        call_chain_id: chain.id,
        call_chain_name: chain.entry_point?.method_name,
        coverage_status: coverageStatus,
        coverage_percentage: Math.round(coveragePct * 100) / 100,
        tested_segments: testedSegments,
        untested_segments: untestedSegments,
        test_quality: {
          has_unit_tests: hasTestNodes,
          has_integration_tests: false,
          has_e2e_tests: false,
          uses_mocks: false
        }
      });
    }

    return flowCoverage;
  }

  private buildTestGaps(flowCoverage: CASFlowCoverage[], nodes: CASNode[]): CASTestGap[] {
    const gaps: CASTestGap[] = [];
    const testedNodeIds = new Set<string>();

    for (const node of nodes) {
      if (node.testing?.tested_by?.length) {
        testedNodeIds.add(node.id);
      }
    }

    const testableTypes = new Set([
      'function', 'method', 'class', 'controller', 'service',
      'middleware', 'route', 'endpoint', 'viewmodel', 'model'
    ]);

    const untestedNodes = nodes.filter(n =>
      testableTypes.has(n.type) &&
      !testedNodeIds.has(n.id) &&
      !n.name.startsWith('_') &&
      n.type !== 'method' || (n.type === 'method' && !n.name.startsWith('__'))
    ).filter(n =>
      testableTypes.has(n.type) &&
      !testedNodeIds.has(n.id) &&
      (n.metadata?.is_exported ||
       n.type === 'controller' ||
       n.type === 'service' ||
       n.type === 'middleware' ||
       n.type === 'endpoint' ||
       n.category === 'api' ||
       n.category === 'controller' ||
       n.category === 'service' ||
       n.subcategories?.includes('public') ||
       n.metadata?.access_modifier === 'public' ||
       (n.type === 'function' && n.level && n.level <= 2) ||
       (n.type === 'class' && !n.name.includes('Abstract') && !n.name.includes('Base')))
    );

    for (const fn of untestedNodes) {
      const nameLower = fn.name.toLowerCase();
      const isSecurityRelated = nameLower.includes('auth') ||
        nameLower.includes('password') ||
        nameLower.includes('permission') ||
        nameLower.includes('token') ||
        nameLower.includes('encrypt') ||
        nameLower.includes('decrypt');

      const isDataMutation = nameLower.includes('create') ||
        nameLower.includes('update') ||
        nameLower.includes('delete') ||
        nameLower.includes('remove') ||
        nameLower.includes('save');

      const severity: CASTestGap['severity'] =
        isSecurityRelated ? 'critical' :
        isDataMutation ? 'high' :
        fn.type === 'controller' || fn.type === 'endpoint' ? 'high' :
        'medium';

      gaps.push({
        gap_type: 'untested-flow',
        location: {
          node_id: fn.id
        },
        severity,
        recommendation: `Add tests for ${fn.name}`
      });
    }

    return gaps;
  }

  private buildTemporalStability(nodes: CASNode[], gitAnalyzer: GitAnalyzer): CASTemporalStability[] {
    const stability: CASTemporalStability[] = [];
    const gitAvailable = gitAnalyzer.isAvailable();

    for (const node of nodes) {
      if (node.type !== 'file' && node.type !== 'class' && node.type !== 'module') {
        continue;
      }

      const filePath = node.source?.file;
      const gitMetrics = filePath && gitAvailable ? gitAnalyzer.getFileMetrics(filePath) : null;

      const isLegacy = node.name.toLowerCase().includes('legacy') ||
        node.description?.toLowerCase().includes('deprecated') ||
        node.implementation_status?.deprecation?.is_deprecated === true ||
        (gitMetrics && gitMetrics.fileAgeDays > 730 && gitMetrics.commits30d === 0);

      const stabilityClass = this.calculateStabilityClass(gitMetrics, !!isLegacy);
      const stabilityScore = this.calculateStabilityScore(gitMetrics, !!isLegacy);

      const refactorFrequency: 'frequent' | 'occasional' | 'rare' =
        gitMetrics && gitMetrics.commits90d > 15 ? 'frequent' :
        gitMetrics && gitMetrics.commits90d > 5 ? 'occasional' : 'rare';

      stability.push({
        node_id: node.id,
        stability_score: stabilityScore,
        stability_class: stabilityClass,
        churn_metrics: {
          commits_30d: gitMetrics?.commits30d || 0,
          commits_90d: gitMetrics?.commits90d || 0,
          unique_authors_30d: gitMetrics?.uniqueAuthors30d || 0,
          lines_changed_30d: gitMetrics?.linesChanged30d || 0
        },
        quality_signals: {
          bug_fix_rate: gitMetrics?.bugFixRate || 0,
          refactor_frequency: refactorFrequency,
          has_recent_regression: gitMetrics?.hasRecentRegression || false
        },
        age_context: {
          file_age_days: gitMetrics?.fileAgeDays || 0,
          last_major_change: gitMetrics?.lastMajorChange || undefined,
          is_legacy: isLegacy || false
        },
        risk_correlation: gitMetrics ? {
          high_churn_high_bugs: gitMetrics.commits30d > 5 && gitMetrics.bugFixRate > 0.3,
          recent_refactor_unstable: gitMetrics.lastMajorChange !== null && gitMetrics.bugFixRate > 0.2
        } : undefined
      });
    }

    return stability;
  }

  private calculateStabilityClass(
    gitMetrics: { commits30d: number; bugFixRate: number; fileAgeDays: number; isHighChurn: boolean } | null,
    isLegacy: boolean
  ): 'stable' | 'evolving' | 'volatile' | 'fragile' {
    if (!gitMetrics) {
      return isLegacy ? 'stable' : 'evolving';
    }

    if (gitMetrics.bugFixRate > 0.3 || (gitMetrics.isHighChurn && gitMetrics.bugFixRate > 0.2)) {
      return 'fragile';
    }

    if (gitMetrics.commits30d > 10) {
      return 'volatile';
    }

    if (gitMetrics.commits30d <= 2 && gitMetrics.bugFixRate < 0.1 && gitMetrics.fileAgeDays > 180) {
      return 'stable';
    }

    return 'evolving';
  }

  private calculateStabilityScore(
    gitMetrics: { commits30d: number; bugFixRate: number; fileAgeDays: number; hasRecentRegression: boolean } | null,
    isLegacy: boolean
  ): number {
    if (!gitMetrics) {
      return isLegacy ? 90 : 70;
    }

    let score = 100;

    score -= Math.min(gitMetrics.commits30d * 3, 30);

    score -= Math.min(gitMetrics.bugFixRate * 50, 25);

    if (gitMetrics.hasRecentRegression) {
      score -= 15;
    }

    if (gitMetrics.fileAgeDays > 365 && gitMetrics.commits30d <= 2) {
      score += 10;
    }

    return Math.max(0, Math.min(100, Math.round(score)));
  }

  private buildStabilitySummary(stability: CASTemporalStability[]): CASStabilitySummary {
    const byClass: Record<string, number> = {
      stable: 0,
      evolving: 0,
      volatile: 0,
      fragile: 0
    };

    for (const s of stability) {
      byClass[s.stability_class]++;
    }

    return {
      by_stability_class: byClass,
      hotspots: stability
        .filter(s => s.stability_class === 'volatile' || s.stability_class === 'fragile')
        .map(s => ({
          node_id: s.node_id,
          reason: s.stability_class === 'fragile' ? 'High churn with bug fixes' : 'High change frequency'
        })),
      legacy_areas: stability
        .filter(s => s.age_context.is_legacy)
        .map(s => s.node_id)
    };
  }

  private buildSystemCapabilities(
    entryPoints: CASEntryPoint[],
    dataEntities: CASDataEntity[],
    nodes: CASNode[],
    edges: CASEdge[]
  ): SystemCapability[] {
    const capabilities: SystemCapability[] = [];

    const resourceGroups = new Map<string, {
      entryPoints: CASEntryPoint[];
      name: string;
    }>();

    for (const ep of entryPoints) {
      if (ep.type === 'test') continue;

      const resourceKey = this.inferResourceKey(ep);
      const resourceName = this.inferResourceName(ep, resourceKey);

      if (!resourceGroups.has(resourceKey)) {
        resourceGroups.set(resourceKey, { entryPoints: [], name: resourceName });
      }
      resourceGroups.get(resourceKey)!.entryPoints.push(ep);
    }

    let capIndex = 0;
    resourceGroups.forEach((group, resourceKey) => {
      const operations = group.entryPoints.map(ep => ({
        entry_point_id: ep.id,
        entry_point_type: ep.type,
        action: this.inferActionFromEntryPoint(ep),
        path_or_command: this.extractPathOrCommand(ep)
      }));

      const relatedNodeIds = new Set<string>();
      group.entryPoints.forEach(ep => {
        if (ep.source_node) relatedNodeIds.add(ep.source_node);
        const epAny = ep as any;
        if (epAny.handler?.node_id) relatedNodeIds.add(epAny.handler.node_id);
      });

      const relatedEntities = dataEntities.filter(de => {
        const entityNodeIds = [
          ...de.lifecycle.created_by,
          ...de.lifecycle.read_by,
          ...de.lifecycle.updated_by,
          ...de.lifecycle.deleted_by
        ];
        return entityNodeIds.some(id => relatedNodeIds.has(id));
      });

      const { criticality, factors } = this.calculateCriticalityFromSignals(
        group.entryPoints,
        relatedEntities,
        nodes,
        edges
      );

      const category = this.inferCapabilityCategory(group.entryPoints, resourceKey);

      capabilities.push({
        id: `cap_${capIndex++}`,
        name: group.name,
        description: this.generateCapabilityDescription(group.name, operations),
        category,
        operations,
        related_entities: relatedEntities.map(e => e.id),
        related_domains: [resourceKey],
        criticality,
        criticality_factors: factors
      });
    });

    return capabilities.sort((a, b) => {
      const critOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      return critOrder[a.criticality] - critOrder[b.criticality];
    });
  }

  private inferResourceKey(ep: CASEntryPoint): string {
    if (ep.type === 'http') {
      const path = ep.trigger?.path || '';
      const cleanPath = path.replace(/^\/api\//, '').replace(/^\//, '');
      const firstSegment = cleanPath.split('/')[0];
      if (firstSegment && !firstSegment.startsWith(':')) {
        return firstSegment.toLowerCase();
      }
      return 'general';
    }

    if (ep.type === 'cli') {
      const parts = ep.name.split(/[\s:]+/);
      return parts[0]?.toLowerCase() || 'commands';
    }

    if (ep.type === 'event' || ep.type === 'message') {
      return 'events';
    }

    if (ep.type === 'schedule') {
      return 'scheduled';
    }

    if (ep.type === 'page' || ep.type === 'route') {
      return 'pages';
    }

    return ep.type;
  }

  private inferResourceName(ep: CASEntryPoint, resourceKey: string): string {
    const name = resourceKey
      .replace(/-/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .split(' ')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');

    if (ep.type === 'cli') {
      return `${name} Commands`;
    }

    if (ep.type === 'event' || ep.type === 'message') {
      return `${name} Handlers`;
    }

    if (ep.type === 'schedule') {
      return 'Scheduled Tasks';
    }

    return `${name} Management`;
  }

  private inferActionFromEntryPoint(ep: CASEntryPoint): string {
    if (ep.type === 'http') {
      const method = ep.trigger?.method?.toLowerCase() || '';
      const path = ep.trigger?.path || '';
      const pathParts = path.split('/').filter(Boolean);
      const lastPart = pathParts[pathParts.length - 1];

      if (lastPart?.startsWith(':')) {
        switch (method) {
          case 'get': return 'View';
          case 'put':
          case 'patch': return 'Update';
          case 'delete': return 'Delete';
          default: return 'Manage';
        }
      }

      switch (method) {
        case 'get': return 'List';
        case 'post': return 'Create';
        case 'put':
        case 'patch': return 'Update';
        case 'delete': return 'Delete';
        default: return 'Access';
      }
    }

    if (ep.type === 'cli') {
      return 'Execute';
    }

    if (ep.type === 'event' || ep.type === 'message') {
      return 'Handle';
    }

    if (ep.type === 'schedule') {
      return 'Run';
    }

    return 'Process';
  }

  private extractPathOrCommand(ep: CASEntryPoint): string | undefined {
    if (ep.type === 'http') {
      return ep.trigger?.path;
    }
    if (ep.type === 'cli') {
      return ep.name;
    }
    return undefined;
  }

  private calculateCriticalityFromSignals(
    entryPoints: CASEntryPoint[],
    relatedEntities: CASDataEntity[],
    nodes: CASNode[],
    edges: CASEdge[]
  ): { criticality: 'critical' | 'high' | 'medium' | 'low'; factors: string[] } {
    let score = 0;
    const factors: string[] = [];

    const touchesSensitiveData = relatedEntities.some(e =>
      e.fields?.some(f => f.is_sensitive)
    );
    if (touchesSensitiveData) {
      score += 25;
      factors.push('Handles sensitive data (PII, credentials)');
    }

    const authPatterns = ['auth', 'login', 'logout', 'password', 'token', 'session', 'oauth'];
    const hasAuthPath = entryPoints.some(ep => {
      const path = ep.trigger?.path?.toLowerCase() || ep.name.toLowerCase();
      return authPatterns.some(p => path.includes(p));
    });
    if (hasAuthPath) {
      score += 20;
      factors.push('Authentication-related endpoint');
    }

    const paymentPatterns = ['payment', 'checkout', 'billing', 'invoice', 'subscription', 'charge', 'refund'];
    const hasPaymentPath = entryPoints.some(ep => {
      const path = ep.trigger?.path?.toLowerCase() || ep.name.toLowerCase();
      return paymentPatterns.some(p => path.includes(p));
    });
    if (hasPaymentPath) {
      score += 30;
      factors.push('Payment/financial operations');
    }

    const hasAuthRequired = entryPoints.some(ep =>
      ep.security?.authenticated ||
      (ep as any).security?.authenticated
    );
    if (hasAuthRequired) {
      score += 5;
      factors.push('Requires authentication');
    }

    const hasMutations = entryPoints.some(ep => {
      const method = ep.trigger?.method?.toUpperCase();
      return method === 'POST' || method === 'PUT' || method === 'DELETE' || method === 'PATCH';
    });
    if (hasMutations) {
      score += 10;
      factors.push('Performs data mutations');
    }

    const nodeIds = new Set<string>();
    entryPoints.forEach(ep => {
      if (ep.source_node) nodeIds.add(ep.source_node);
      const epAny = ep as any;
      if (epAny.handler?.node_id) nodeIds.add(epAny.handler.node_id);
    });

    let callerCount = 0;
    for (const edge of edges) {
      if ((edge.type === 'calls' || edge.type === 'uses') && nodeIds.has(edge.target)) {
        callerCount++;
      }
    }
    if (callerCount > 5) {
      score += Math.min(callerCount, 10);
      factors.push(`Called by ${callerCount} other components`);
    }

    const adminPatterns = ['admin', 'manage', 'delete', 'remove', 'destroy'];
    const hasAdminOps = entryPoints.some(ep => {
      const path = ep.trigger?.path?.toLowerCase() || ep.name.toLowerCase();
      return adminPatterns.some(p => path.includes(p));
    });
    if (hasAdminOps) {
      score += 15;
      factors.push('Administrative operations');
    }

    let criticality: 'critical' | 'high' | 'medium' | 'low';
    if (score >= 70) {
      criticality = 'critical';
    } else if (score >= 50) {
      criticality = 'high';
    } else if (score >= 25) {
      criticality = 'medium';
    } else {
      criticality = 'low';
    }

    return { criticality, factors };
  }

  private inferCapabilityCategory(
    entryPoints: CASEntryPoint[],
    resourceKey: string
  ): 'core' | 'supporting' | 'admin' | 'internal' {
    const adminPatterns = ['admin', 'manage', 'system', 'config', 'setting'];
    if (adminPatterns.some(p => resourceKey.includes(p))) {
      return 'admin';
    }

    const internalPatterns = ['health', 'status', 'metrics', 'internal', 'debug'];
    if (internalPatterns.some(p => resourceKey.includes(p))) {
      return 'internal';
    }

    const hasMutations = entryPoints.some(ep => {
      const method = ep.trigger?.method?.toUpperCase();
      return method === 'POST' || method === 'PUT' || method === 'DELETE';
    });

    if (hasMutations) {
      return 'core';
    }

    return 'supporting';
  }

  private generateCapabilityDescription(name: string, operations: Array<{ action: string }>): string {
    const uniqueActions = [...new Set(operations.map(o => o.action.toLowerCase()))];
    if (uniqueActions.length === 0) {
      return `Manages ${name.toLowerCase()} functionality`;
    }
    return `${uniqueActions.join(', ')} operations for ${name.toLowerCase()}`;
  }

  private inferSystemPurpose(
    entryPoints: CASEntryPoint[],
    dataEntities: CASDataEntity[],
    capabilities: SystemCapability[],
    nodes: CASNode[]
  ): SystemPurpose {
    interface SystemSignature {
      type: string;
      description: string;
      indicators: {
        pathPatterns?: string[];
        verbPatterns?: string[];
        entityPatterns?: string[];
        nodeTypePatterns?: string[];
        capabilityPatterns?: string[];
      };
      distinctiveness: number;
      weight: number;
    }

    const signatures: SystemSignature[] = [
      {
        type: 'verification-service',
        description: 'Data verification and validation system',
        indicators: {
          pathPatterns: ['verify', 'validate', 'check', 'barcode', 'scan', 'lookup'],
          verbPatterns: ['verify', 'validate', 'check', 'scan'],
          entityPatterns: ['verification', 'validator', 'barcode', 'serial', 'gtin', 'lot'],
          capabilityPatterns: ['verify', 'validate', 'check', 'scan'],
        },
        distinctiveness: 3,
        weight: 0
      },
      {
        type: 'sync-service',
        description: 'Data synchronization and replication system',
        indicators: {
          pathPatterns: ['sync', 'push', 'pull', 'replicate', 'mirror', 'synchronization'],
          verbPatterns: ['sync', 'push', 'pull', 'replicate'],
          entityPatterns: ['sync', 'replication', 'source', 'target', 'connection'],
          capabilityPatterns: ['sync', 'push', 'pull', 'synchronization'],
        },
        distinctiveness: 3,
        weight: 0
      },
      {
        type: 'e-commerce',
        description: 'Online shopping and commerce platform',
        indicators: {
          pathPatterns: ['cart', 'checkout', 'shop', 'store', 'catalog', 'wishlist'],
          verbPatterns: ['purchase', 'buy', 'add-to-cart'],
          entityPatterns: ['product', 'order', 'cart', 'payment', 'customer', 'sku', 'inventory', 'price'],
          capabilityPatterns: ['checkout', 'cart', 'purchase', 'catalog'],
        },
        distinctiveness: 2.5,
        weight: 0
      },
      {
        type: 'messaging-service',
        description: 'Message queue and event processing system',
        indicators: {
          pathPatterns: ['message', 'queue', 'publish', 'subscribe', 'topic', 'channel'],
          verbPatterns: ['publish', 'subscribe', 'send', 'receive', 'broadcast'],
          entityPatterns: ['message', 'queue', 'topic', 'subscriber', 'publisher', 'event'],
          capabilityPatterns: ['publish', 'subscribe', 'message', 'notify'],
        },
        distinctiveness: 3,
        weight: 0
      },
      {
        type: 'workflow-engine',
        description: 'Business process and workflow automation',
        indicators: {
          pathPatterns: ['workflow', 'process', 'task', 'step', 'approval', 'stage'],
          verbPatterns: ['approve', 'reject', 'submit', 'escalate'],
          entityPatterns: ['workflow', 'process', 'task', 'stage', 'approval', 'assignee'],
          capabilityPatterns: ['workflow', 'process', 'task', 'approve'],
        },
        distinctiveness: 3,
        weight: 0
      },
      {
        type: 'scheduling-service',
        description: 'Appointment and scheduling management',
        indicators: {
          pathPatterns: ['schedule', 'appointment', 'booking', 'calendar', 'slot', 'availability'],
          verbPatterns: ['schedule', 'book', 'reserve', 'cancel'],
          entityPatterns: ['schedule', 'appointment', 'booking', 'slot', 'calendar', 'availability'],
          capabilityPatterns: ['schedule', 'book', 'availability'],
        },
        distinctiveness: 3,
        weight: 0
      },
      {
        type: 'notification-service',
        description: 'Notification and alerting system',
        indicators: {
          pathPatterns: ['notification', 'alert', 'email', 'sms', 'push', 'webhook'],
          verbPatterns: ['notify', 'alert', 'send', 'trigger'],
          entityPatterns: ['notification', 'alert', 'template', 'recipient', 'channel'],
          capabilityPatterns: ['notify', 'alert', 'send'],
        },
        distinctiveness: 2.5,
        weight: 0
      },
      {
        type: 'document-management',
        description: 'Document storage and management system',
        indicators: {
          pathPatterns: ['document', 'file', 'upload', 'download', 'attachment', 'storage'],
          verbPatterns: ['upload', 'download', 'attach', 'store'],
          entityPatterns: ['document', 'file', 'attachment', 'folder', 'version'],
          capabilityPatterns: ['upload', 'download', 'document', 'file'],
        },
        distinctiveness: 2.5,
        weight: 0
      },
      {
        type: 'search-service',
        description: 'Search and discovery system',
        indicators: {
          pathPatterns: ['search', 'query', 'find', 'filter', 'index', 'suggest'],
          verbPatterns: ['search', 'query', 'find', 'filter'],
          entityPatterns: ['index', 'query', 'result', 'facet', 'suggestion'],
          capabilityPatterns: ['search', 'query', 'find'],
        },
        distinctiveness: 2,
        weight: 0
      },
      {
        type: 'inventory-management',
        description: 'Inventory and stock management system',
        indicators: {
          pathPatterns: ['inventory', 'stock', 'warehouse', 'shipment', 'transfer'],
          verbPatterns: ['transfer', 'receive', 'ship', 'adjust'],
          entityPatterns: ['inventory', 'stock', 'warehouse', 'location', 'shipment', 'transfer'],
          capabilityPatterns: ['inventory', 'stock', 'warehouse', 'shipment'],
        },
        distinctiveness: 3,
        weight: 0
      },
      {
        type: 'crm-system',
        description: 'Customer relationship management',
        indicators: {
          pathPatterns: ['customer', 'contact', 'lead', 'opportunity', 'account', 'deal'],
          verbPatterns: ['convert', 'qualify', 'assign'],
          entityPatterns: ['customer', 'contact', 'lead', 'opportunity', 'account', 'deal', 'campaign'],
          capabilityPatterns: ['customer', 'lead', 'contact', 'opportunity'],
        },
        distinctiveness: 2.5,
        weight: 0
      },
      {
        type: 'saas-platform',
        description: 'Multi-tenant SaaS application',
        indicators: {
          pathPatterns: ['workspace', 'organization', 'team', 'subscription', 'tenant', 'plan'],
          entityPatterns: ['workspace', 'organization', 'subscription', 'tenant', 'plan', 'billing'],
          capabilityPatterns: ['workspace', 'organization', 'subscription'],
        },
        distinctiveness: 2.5,
        weight: 0
      },
      {
        type: 'content-management',
        description: 'Content management system',
        indicators: {
          pathPatterns: ['post', 'article', 'page', 'blog', 'media', 'category', 'tag'],
          verbPatterns: ['publish', 'draft', 'archive'],
          entityPatterns: ['post', 'article', 'page', 'content', 'media', 'category', 'author'],
          capabilityPatterns: ['publish', 'content', 'article', 'media'],
        },
        distinctiveness: 2,
        weight: 0
      },
      {
        type: 'data-processing',
        description: 'Data processing and ETL pipeline',
        indicators: {
          pathPatterns: ['process', 'transform', 'import', 'export', 'batch', 'pipeline', 'etl'],
          verbPatterns: ['process', 'transform', 'import', 'export', 'extract'],
          entityPatterns: ['job', 'task', 'queue', 'pipeline', 'batch', 'transformation'],
          capabilityPatterns: ['process', 'transform', 'import', 'export', 'batch'],
        },
        distinctiveness: 2,
        weight: 0
      },
      {
        type: 'authentication-service',
        description: 'Authentication and identity management',
        indicators: {
          pathPatterns: ['auth', 'login', 'oauth', 'sso', 'identity', 'token', 'session'],
          verbPatterns: ['login', 'logout', 'authenticate', 'authorize'],
          entityPatterns: ['user', 'session', 'token', 'credential', 'role', 'permission'],
          capabilityPatterns: ['login', 'auth', 'session', 'token'],
        },
        distinctiveness: 2,
        weight: 0
      },
      {
        type: 'analytics-platform',
        description: 'Analytics and reporting platform',
        indicators: {
          pathPatterns: ['analytics', 'report', 'dashboard', 'metric', 'insight', 'chart'],
          verbPatterns: ['aggregate', 'analyze', 'track'],
          entityPatterns: ['metric', 'report', 'event', 'aggregation', 'dimension', 'measure'],
          capabilityPatterns: ['analytics', 'report', 'dashboard', 'metric'],
        },
        distinctiveness: 2.5,
        weight: 0
      },
      {
        type: 'payment-service',
        description: 'Payment processing system',
        indicators: {
          pathPatterns: ['payment', 'charge', 'refund', 'invoice', 'transaction', 'payout'],
          verbPatterns: ['charge', 'refund', 'pay', 'settle'],
          entityPatterns: ['payment', 'transaction', 'invoice', 'refund', 'payout', 'account'],
          capabilityPatterns: ['payment', 'charge', 'refund', 'invoice'],
        },
        distinctiveness: 3,
        weight: 0
      },
      {
        type: 'iot-platform',
        description: 'IoT device management platform',
        indicators: {
          pathPatterns: ['device', 'sensor', 'telemetry', 'firmware', 'provision', 'command'],
          verbPatterns: ['provision', 'register', 'configure'],
          entityPatterns: ['device', 'sensor', 'telemetry', 'firmware', 'reading', 'gateway'],
          capabilityPatterns: ['device', 'sensor', 'telemetry', 'provision'],
        },
        distinctiveness: 3,
        weight: 0
      },
      {
        type: 'desktop-application',
        description: 'Desktop GUI application',
        indicators: {
          nodeTypePatterns: ['window', 'viewmodel', 'ui_component', 'command', 'converter', 'view'],
          entityPatterns: ['settings', 'preferences', 'configuration'],
          capabilityPatterns: ['window', 'dialog', 'form', 'display'],
        },
        distinctiveness: 2,
        weight: 0
      },
      {
        type: 'medical-device-software',
        description: 'Medical device and clinical measurement software',
        indicators: {
          pathPatterns: ['patient', 'test', 'device', 'muscle', 'force', 'measurement', 'evaluator', 'protocol'],
          entityPatterns: ['patient', 'test', 'evaluator', 'protocol', 'muscle', 'device', 'measurement', 'normvalues', 'sequence'],
          nodeTypePatterns: ['window', 'viewmodel', 'service', 'database_context'],
          capabilityPatterns: ['patient', 'test', 'device', 'measurement', 'protocol', 'evaluator', 'report'],
        },
        distinctiveness: 4,
        weight: 0
      },
      {
        type: 'clinical-testing-platform',
        description: 'Clinical testing, assessment, and rehabilitation platform',
        indicators: {
          pathPatterns: ['inclinometry', 'grip', 'pinch', 'muscle', 'rom', 'strength', 'rehabilitation'],
          entityPatterns: ['muscletest', 'testinfo', 'coverletter', 'standardmuscles', 'custommuscles', 'normvalues'],
          capabilityPatterns: ['muscle', 'grip', 'pinch', 'inclinometry', 'test', 'assessment'],
        },
        distinctiveness: 5,
        weight: 0
      },
      {
        type: 'hardware-device-software',
        description: 'Hardware device communication and control software',
        indicators: {
          pathPatterns: ['device', 'connection', 'sensor', 'serial', 'usb', 'bluetooth', 'port', 'calibrate'],
          entityPatterns: ['device', 'connection', 'sensor', 'reading', 'calibration', 'firmware'],
          nodeTypePatterns: ['service'],
          capabilityPatterns: ['device', 'connect', 'calibrate', 'sensor', 'reading'],
        },
        distinctiveness: 3.5,
        weight: 0
      },
      {
        type: 'patient-management',
        description: 'Patient data management and records system',
        indicators: {
          pathPatterns: ['patient', 'record', 'history', 'demographic', 'visit', 'chart'],
          entityPatterns: ['patient', 'record', 'evaluator', 'visit', 'chart', 'history', 'coverletter'],
          capabilityPatterns: ['patient', 'record', 'history', 'demographic'],
        },
        distinctiveness: 3.5,
        weight: 0
      },
      {
        type: 'api-gateway',
        description: 'API gateway and routing service',
        indicators: {
          pathPatterns: ['gateway', 'proxy', 'route', 'upstream', 'rate-limit'],
          entityPatterns: ['route', 'upstream', 'service', 'consumer', 'plugin'],
          capabilityPatterns: ['route', 'proxy', 'gateway'],
        },
        distinctiveness: 3,
        weight: 0
      },
      {
        type: 'api-service',
        description: 'REST/GraphQL API backend',
        indicators: {
          pathPatterns: ['api', 'graphql', 'rest', 'resource'],
          nodeTypePatterns: ['controller', 'service', 'repository', 'resolver'],
          capabilityPatterns: ['crud', 'resource'],
        },
        distinctiveness: 1,
        weight: 0
      },
      {
        type: 'cli-tool',
        description: 'Command-line interface tool',
        indicators: {
          capabilityPatterns: ['command', 'execute', 'run'],
          nodeTypePatterns: ['command', 'cli'],
        },
        distinctiveness: 3,
        weight: 0
      },
      {
        type: 'gaming-platform',
        description: 'Gaming, card game, or interactive entertainment platform',
        indicators: {
          pathPatterns: ['game', 'player', 'deck', 'card', 'match', 'lobby', 'turn', 'score', 'commander', 'board'],
          verbPatterns: ['play', 'draw', 'shuffle', 'deal', 'attack', 'defend', 'cast', 'mulligan'],
          entityPatterns: ['game', 'player', 'deck', 'card', 'match', 'lobby', 'turn', 'score', 'hand', 'board', 'commander', 'mana'],
          capabilityPatterns: ['game', 'match', 'lobby', 'player', 'deck'],
        },
        distinctiveness: 4,
        weight: 0
      },
      {
        type: 'multiplayer-application',
        description: 'Real-time multiplayer application with websocket communication',
        indicators: {
          pathPatterns: ['socket', 'lobby', 'room', 'player', 'matchmaking', 'realtime', 'session'],
          verbPatterns: ['join', 'leave', 'broadcast', 'emit', 'connect'],
          entityPatterns: ['socket', 'room', 'lobby', 'player', 'session', 'connection', 'event'],
          capabilityPatterns: ['socket', 'lobby', 'room', 'matchmaking'],
        },
        distinctiveness: 3.5,
        weight: 0
      },
      {
        type: 'web-application',
        description: 'Full-stack web application with frontend and backend',
        indicators: {
          pathPatterns: ['page', 'component', 'layout', 'api', 'route', 'middleware', 'hook', 'context', 'provider'],
          entityPatterns: ['user', 'session', 'page', 'component', 'layout', 'route'],
          nodeTypePatterns: ['controller', 'service', 'middleware'],
          capabilityPatterns: ['page', 'route', 'api', 'component'],
        },
        distinctiveness: 1,
        weight: 0
      },
      {
        type: 'devtools-platform',
        description: 'Developer tools, code analysis, or visualization platform',
        indicators: {
          pathPatterns: ['analyzer', 'parser', 'ast', 'visualiz', 'blueprint', 'diagram', 'graph', 'node', 'edge', 'render', 'canvas', 'viewport', 'zoom', 'pan', 'layout', 'telemetry', 'instrument', 'sdk', 'plugin'],
          verbPatterns: ['analyze', 'parse', 'render', 'visualize', 'instrument', 'inspect', 'transform', 'compile', 'lint', 'format', 'detect', 'trace', 'profile'],
          entityPatterns: ['node', 'edge', 'graph', 'ast', 'token', 'analyzer', 'parser', 'blueprint', 'diagram', 'canvas', 'viewport', 'layer', 'component', 'manifest', 'telemetry'],
          capabilityPatterns: ['analysis', 'parsing', 'visualization', 'rendering', 'instrumentation', 'detection', 'inspection'],
        },
        distinctiveness: 5,
        weight: 0
      },
      {
        type: 'education-platform',
        description: 'Learning management system or educational platform',
        indicators: {
          pathPatterns: ['course', 'lesson', 'quiz', 'certificate', 'learning', 'curriculum', 'enrollment', 'tutorial', 'assignment', 'student', 'instructor'],
          verbPatterns: ['enroll', 'complete', 'submit', 'grade', 'certify', 'learn', 'study', 'teach'],
          entityPatterns: ['course', 'lesson', 'quiz', 'student', 'instructor', 'enrollment', 'certificate', 'curriculum', 'assignment', 'grade', 'progress', 'achievement', 'leaderboard'],
          capabilityPatterns: ['course', 'lesson', 'quiz', 'certificate', 'learning', 'enrollment'],
        },
        distinctiveness: 4.5,
        weight: 0
      }
    ];

    const evidence: string[] = [];
    const signatureEvidence = new Map<string, string[]>();

    const paths = entryPoints.map(ep => (ep.trigger?.path || ep.name).toLowerCase());
    const nodeNames = nodes.map(n => n.name.toLowerCase());
    const namespaceNames = nodes.filter(n => n.type === 'namespace').map(n => n.name.toLowerCase());
    const entityNames = dataEntities.map(de => de.name.toLowerCase());
    const capabilityNames = capabilities.map(c => c.name.toLowerCase());
    const nodeTypeList = nodes.map(n => n.type.toLowerCase());

    const countMatches = (items: string[], patterns: string[]): { count: number; matched: string[] } => {
      const matched: string[] = [];
      let count = 0;
      for (const item of items) {
        for (const pattern of patterns) {
          if (item.includes(pattern)) {
            if (!matched.includes(pattern)) {
              matched.push(pattern);
            }
            count++;
          }
        }
      }
      return { count, matched };
    };

    for (const sig of signatures) {
      let score = 0;
      const typeEvidence: string[] = [];

      if (sig.indicators.pathPatterns) {
        const pathResult = countMatches(paths, sig.indicators.pathPatterns);
        const nodeNameResult = countMatches(nodeNames, sig.indicators.pathPatterns);
        const nsResult = countMatches(namespaceNames, sig.indicators.pathPatterns);
        const allMatched = [...new Set([...pathResult.matched, ...nodeNameResult.matched, ...nsResult.matched])];
        const totalCount = pathResult.count + nodeNameResult.count + nsResult.count;
        const cappedCount = Math.min(totalCount, allMatched.length * 5);
        if (allMatched.length > 0) {
          score += cappedCount * 2 * sig.distinctiveness;
          typeEvidence.push(`Endpoints: ${allMatched.join(', ')}`);
        }
      }

      if (sig.indicators.verbPatterns) {
        const pathResult = countMatches(paths, sig.indicators.verbPatterns);
        const nodeNameResult = countMatches(nodeNames, sig.indicators.verbPatterns);
        const allMatched = [...new Set([...pathResult.matched, ...nodeNameResult.matched])];
        const totalCount = pathResult.count + nodeNameResult.count;
        const cappedCount = Math.min(totalCount, allMatched.length * 5);
        if (allMatched.length > 0) {
          score += cappedCount * 3 * sig.distinctiveness;
          if (!typeEvidence.some(e => e.startsWith('Endpoints:'))) {
            typeEvidence.push(`Actions: ${allMatched.join(', ')}`);
          }
        }
      }

      if (sig.indicators.entityPatterns) {
        const result = countMatches(entityNames, sig.indicators.entityPatterns);
        if (result.count > 0) {
          score += result.count * 4 * sig.distinctiveness;
          typeEvidence.push(`Entities: ${result.matched.join(', ')}`);
        }
      }

      if (sig.indicators.nodeTypePatterns) {
        const result = countMatches(nodeTypeList, sig.indicators.nodeTypePatterns);
        if (result.count > 0) {
          score += result.matched.length * 2;
        }
      }

      if (sig.indicators.capabilityPatterns) {
        const result = countMatches(capabilityNames, sig.indicators.capabilityPatterns);
        const cappedCount = Math.min(result.count, result.matched.length * 5);
        if (result.count > 0) {
          score += cappedCount * 3 * sig.distinctiveness;
          typeEvidence.push(`Capabilities: ${result.matched.join(', ')}`);
        }
      }

      sig.weight = score;
      if (typeEvidence.length > 0) {
        signatureEvidence.set(sig.type, typeEvidence);
      }
    }

    signatures.sort((a, b) => b.weight - a.weight);

    const topMatch = signatures[0];
    const secondBest = signatures[1];

    const maxPossibleScore = Math.max(
      paths.length * 5 * 3,
      entityNames.length * 4 * 3,
      50
    );
    let confidence = topMatch.weight / maxPossibleScore;

    if (topMatch.weight > 0 && secondBest.weight > 0) {
      const separation = (topMatch.weight - secondBest.weight) / topMatch.weight;
      confidence = Math.min(confidence + (separation * 0.3), 1.0);
    }

    confidence = Math.max(0.1, Math.min(0.95, confidence));

    const topEvidence = signatureEvidence.get(topMatch.type) || [];
    evidence.push(...topEvidence);

    const secondaryTypes = signatures
      .slice(1, 4)
      .filter(s => s.weight > topMatch.weight * 0.3)
      .map(s => s.type);

    const cliEntryPoints = entryPoints.filter(ep => ep.type === 'cli');
    const httpEntryPoints = entryPoints.filter(ep => ep.type === 'http');

    if (cliEntryPoints.length > httpEntryPoints.length && cliEntryPoints.length > 0) {
      return {
        primary_type: 'cli-tool',
        confidence: 0.9,
        evidence: ['Primary interface is CLI commands'],
        secondary_types: topMatch.type !== 'cli-tool' ? [topMatch.type] : secondaryTypes
      };
    }

    if (topMatch.weight === 0) {
      const hasHttpEndpoints = httpEntryPoints.length > 0;
      const hasEntities = dataEntities.length > 0;

      if (hasHttpEndpoints && hasEntities) {
        return {
          primary_type: 'api-service',
          confidence: 0.4,
          evidence: [`${httpEntryPoints.length} HTTP endpoints`, `${dataEntities.length} data entities`],
          secondary_types: undefined
        };
      }

      return {
        primary_type: 'general-application',
        confidence: 0.2,
        evidence: ['No distinctive patterns detected'],
        secondary_types: undefined
      };
    }

    return {
      primary_type: topMatch.type,
      confidence: Math.round(confidence * 100) / 100,
      evidence: evidence.slice(0, 5),
      secondary_types: secondaryTypes.length > 0 ? secondaryTypes : undefined
    };
  }

  private linkRouteHandlers(
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[]
  ): void {
    const functionNodesByFile = new Map<string, CASNode[]>();
    for (const node of nodes) {
      if (node.type === 'function' || node.type === 'method') {
        const file = node.source?.file || '';
        if (!functionNodesByFile.has(file)) {
          functionNodesByFile.set(file, []);
        }
        functionNodesByFile.get(file)!.push(node);
      }
    }

    const existingEdgeIds = new Set(edges.map(e => e.id));

    for (const ep of entryPoints) {
      const supportedTypes = ['http', 'websocket', 'message', 'event'];
      if (!supportedTypes.includes(ep.type)) continue;
      if (!ep.handler?.method_name) continue;

      const handlerName = ep.handler.method_name;
      const handlerFile = ep.handler.file || '';
      const routeNodeId = ep.source_node;

      if (!handlerName || handlerName.length === 0) continue;

      const filesToSearch: string[] = [];
      if (handlerFile) {
        for (const file of functionNodesByFile.keys()) {
          if (file.includes(handlerFile) || handlerFile.includes(file.replace(/^.*?\//, ''))) {
            filesToSearch.push(file);
          }
        }
      }

      if (filesToSearch.length === 0) {
        filesToSearch.push(...functionNodesByFile.keys());
      }

      let matchedFunctionNode: CASNode | null = null;

      for (const file of filesToSearch) {
        const functionsInFile = functionNodesByFile.get(file) || [];
        const exactMatch = functionsInFile.find(n => n.name === handlerName);
        if (exactMatch) {
          matchedFunctionNode = exactMatch;
          break;
        }
      }

      if (!matchedFunctionNode) {
        for (const file of filesToSearch) {
          const functionsInFile = functionNodesByFile.get(file) || [];
          const partialMatch = functionsInFile.find(n =>
            n.name.toLowerCase() === handlerName.toLowerCase() ||
            n.name.includes(handlerName) ||
            handlerName.includes(n.name)
          );
          if (partialMatch) {
            matchedFunctionNode = partialMatch;
            break;
          }
        }
      }

      if (matchedFunctionNode) {
        if (ep.handler) {
          ep.handler.node_id = matchedFunctionNode.id;
        }

        const edgeId = `route_calls_${routeNodeId}_${matchedFunctionNode.id}`;
        if (!existingEdgeIds.has(edgeId)) {
          const framework = ep.metadata?.graphql_operation_type ? 'graphene' :
                           ep.metadata?.task_type === 'celery' ? 'celery' :
                           ep.source_analyzer || 'web';
          const relationship = ep.metadata?.graphql_operation_type ? 'graphql_resolver' :
                              ep.metadata?.task_type === 'celery' ? 'task_handler' :
                              'route_handler';

          edges.push({
            id: edgeId,
            source: routeNodeId,
            target: matchedFunctionNode.id,
            type: 'calls',
            metadata: {
              attributes: {
                framework,
                relationship,
                entry_point_type: ep.type
              }
            }
          });
          existingEdgeIds.add(edgeId);
        }
      }
    }
  }

  private buildTestSuites(nodes: CASNode[], entryPoints: CASEntryPoint[], projectPath: string): CASTestSuite[] {
    const testSuites: CASTestSuite[] = [];
    const addedSuiteIds = new Set<string>();

    const suiteNodes = nodes.filter(n =>
      n.type === 'test' && n.subcategories?.includes('suite')
    );

    if (suiteNodes.length > 0) {
      const fileToSuites = new Map<string, CASNode[]>();
      for (const suite of suiteNodes) {
        const file = suite.source?.file || '';
        if (!fileToSuites.has(file)) fileToSuites.set(file, []);
        fileToSuites.get(file)!.push(suite);
      }

      const individualTests = nodes.filter(n =>
        n.type === 'test' && !n.subcategories?.includes('suite')
      );

      for (const suite of suiteNodes) {
        const suiteFile = suite.source?.file || '';
        const testsInSuite = individualTests.filter(t =>
          t.source?.file === suiteFile &&
          (t.parent === suite.id || (!t.parent && suiteFile))
        );

        if (testsInSuite.length > 0) {
          const suiteId = `suite_${suite.id}`;
          addedSuiteIds.add(suiteId);
          testSuites.push({
            id: suiteId,
            name: suite.name,
            file_path: suiteFile,
            test_type: this.inferTestType(suite),
            framework: this.inferTestFramework(suite),
            tests: testsInSuite.map(t => ({
              id: `test_${t.id}`,
              name: t.name,
              description: t.description,
              test_type: this.inferTestType(t),
              status: {
                skipped: false,
                focused: false,
                flaky: false
              },
              source: t.source?.file && t.source?.line ? {
                file: t.source.file,
                line: t.source.line,
                end_line: t.source.end_line
              } : undefined
            }))
          });
        }
      }
    }

    const testModules = nodes.filter(n =>
      n.type === 'module' &&
      (n.name === 'tests' || n.name === 'test' || n.name.endsWith('_tests') || n.name.endsWith('_test')) &&
      !addedSuiteIds.has(`suite_${n.id}`)
    );

    for (const testModule of testModules) {
      const moduleFile = testModule.source?.file || '';
      const childFunctions = nodes.filter(n =>
        (n.type === 'function' || n.type === 'method') &&
        (n.parent === testModule.id || (moduleFile && n.source?.file === moduleFile && !n.parent)) &&
        (n.name.startsWith('test_') || n.name.startsWith('test') || n.metadata?.is_test)
      );

      if (childFunctions.length > 0) {
        const suiteId = `suite_${testModule.id}`;
        addedSuiteIds.add(suiteId);
        testSuites.push({
          id: suiteId,
          name: testModule.name,
          file_path: moduleFile,
          test_type: this.inferTestType(testModule),
          framework: this.inferTestFramework(testModule),
          tests: childFunctions.map(m => ({
            id: `test_${m.id}`,
            name: m.name,
            description: m.description,
            test_type: this.inferTestType(testModule),
            status: {
              skipped: false,
              focused: false,
              flaky: false
            },
            source: m.source?.file && m.source?.line ? {
              file: m.source.file,
              line: m.source.line,
              end_line: m.source.end_line
            } : undefined
          }))
        });
      }
    }

    const testClasses = nodes.filter(n =>
      n.type === 'class' &&
      (n.name.toLowerCase().includes('test') ||
       n.name.startsWith('Test') ||
       n.subcategories?.includes('test')) &&
      !addedSuiteIds.has(`suite_${n.id}`)
    );

    for (const testClass of testClasses) {
      const testMethods = nodes.filter(n =>
        n.type === 'method' &&
        n.parent === testClass.id &&
        (n.name.startsWith('test_') || n.name.startsWith('test'))
      );

      if (testMethods.length > 0) {
        const suiteId = `suite_${testClass.id}`;
        addedSuiteIds.add(suiteId);
        testSuites.push({
          id: suiteId,
          name: testClass.name,
          file_path: testClass.source?.file || '',
          test_type: this.inferTestType(testClass),
          framework: this.inferTestFramework(testClass),
          tests: testMethods.map(m => ({
            id: `test_${m.id}`,
            name: m.name,
            description: m.description,
            test_type: this.inferTestType(testClass),
            status: {
              skipped: false,
              focused: false,
              flaky: false
            },
            source: m.source?.file && m.source?.line ? {
              file: m.source.file,
              line: m.source.line,
              end_line: m.source.end_line
            } : undefined
          }))
        });
      }
    }

    const describeBlocks = nodes.filter(n =>
      (n.type === 'function' || n.type === 'block' || n.type === 'call_expression') &&
      (n.name.startsWith('describe') || n.name.startsWith('context') || n.name.startsWith('suite')) &&
      !addedSuiteIds.has(`suite_${n.id}`)
    );

    for (const describe of describeBlocks) {
      const itBlocks = nodes.filter(n =>
        n.parent === describe.id &&
        (n.name.startsWith('it') || n.name.startsWith('test') || n.name.startsWith('specify'))
      );

      if (itBlocks.length > 0) {
        const suiteId = `suite_${describe.id}`;
        addedSuiteIds.add(suiteId);
        testSuites.push({
          id: suiteId,
          name: describe.name,
          file_path: describe.source?.file || '',
          test_type: this.inferTestType(describe),
          framework: this.inferTestFramework(describe),
          tests: itBlocks.map(m => ({
            id: `test_${m.id}`,
            name: m.name,
            description: m.description,
            test_type: this.inferTestType(describe),
            status: {
              skipped: m.name.startsWith('xit') || m.name.startsWith('xtest'),
              focused: m.name.startsWith('fit') || m.name.startsWith('ftest'),
              flaky: false
            },
            source: m.source?.file && m.source?.line ? {
              file: m.source.file,
              line: m.source.line,
              end_line: m.source.end_line
            } : undefined
          }))
        });
      }
    }

    const testFiles = nodes.filter(n => n.type === 'file' && this.isTestFileNode(n));

    const suiteFiles = new Set(testSuites.map(s => s.file_path));

    for (const testFile of testFiles) {
      if (suiteFiles.has(testFile.source?.file || '')) continue;
      const fileId = `suite_file_${testFile.id}`;
      if (addedSuiteIds.has(fileId)) continue;

      const childTests = nodes.filter(n =>
        (n.parent === testFile.id || n.source?.file === testFile.source?.file) &&
        (n.type === 'function' || n.type === 'method') &&
        (n.name.startsWith('test') || n.name.startsWith('it') ||
         n.name.startsWith('should') || n.name.startsWith('Test'))
      );
      const inferredTests = childTests.length > 0
        ? childTests.map(m => ({
          id: `test_${m.id}`,
          name: m.name,
          description: m.description,
          test_type: this.inferTestType(testFile),
          status: {
            skipped: false,
            focused: false,
            flaky: false
          },
          source: m.source?.file && m.source?.line ? {
            file: m.source.file,
            line: m.source.line,
            end_line: m.source.end_line
          } : undefined
        }))
        : this.extractTestCasesFromFile(projectPath, testFile);

      if (inferredTests.length > 0) {
        addedSuiteIds.add(fileId);
        testSuites.push({
          id: fileId,
          name: testFile.name,
          file_path: testFile.source?.file || testFile.name,
          test_type: this.inferTestType(testFile),
          framework: this.inferTestFramework(testFile),
          tests: inferredTests
        });
      }
    }

    return testSuites;
  }

  private isTestFileNode(node: CASNode): boolean {
    const file = (node.source?.file || node.name || '').replace(/\\/g, '/');
    const name = path.basename(file);
    return /\.(spec|test)\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(name) ||
      /\.cy\.(ts|tsx|js|jsx)$/i.test(name) ||
      /^test_.*\.py$/i.test(name) ||
      /_test\.py$/i.test(name) ||
      /_test\.(go|rs)$/i.test(name) ||
      /(Test|Tests)\.(java|kt|cs|php)$/i.test(name) ||
      (/\/tests?\//i.test(file) && this.looksLikeExecutableTestFile(file));
  }

  private looksLikeExecutableTestFile(file: string): boolean {
    const name = path.basename(file);
    if (name === '__init__.py' || name.endsWith('.d.ts')) return false;
    if (/\.(spec|test)\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(name)) return true;
    if (/^test_.*\.py$/i.test(name) || /_test\.py$/i.test(name)) return true;
    if (/_test\.(go|rs)$/i.test(name)) return true;
    if (/(Test|Tests)\.(java|kt|cs|php)$/i.test(name)) return true;
    return false;
  }

  private extractTestCasesFromFile(projectPath: string, testFile: CASNode): CASTestCase[] {
    const sourceFile = testFile.source?.file || testFile.name;
    const absolutePath = path.isAbsolute(sourceFile) ? sourceFile : path.join(projectPath, sourceFile);
    if (!fs.existsSync(absolutePath)) return [];
    const content = fs.readFileSync(absolutePath, 'utf8');
    const testType = this.inferTestType(testFile);
    const tests: CASTestCase[] = [];

    const patterns = this.testCasePatternsForFile(sourceFile);
    for (const pattern of patterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.regex.exec(content)) !== null) {
        const name = match[pattern.nameGroup] || match[0].trim();
        const line = this.lineNumberAtOffset(content, match.index);
        tests.push({
          id: this.testCaseId(sourceFile, name, line, tests.length),
          name,
          test_type: testType,
          status: {
            skipped: pattern.skipped(match[0]),
            focused: pattern.focused(match[0]),
            flaky: false
          },
          source: {
            file: sourceFile,
            line
          }
        });
      }
    }

    return this.dedupeTestCases(tests);
  }

  private testCasePatternsForFile(file: string): Array<{
    regex: RegExp;
    nameGroup: number;
    skipped: (raw: string) => boolean;
    focused: (raw: string) => boolean;
  }> {
    const lowerFile = file.toLowerCase();
    const commonStatus = {
      skipped: (raw: string) => /\.skip\b|^x(it|test|describe)\b/.test(raw.trim()),
      focused: (raw: string) => /\.only\b|^f(it|test|describe)\b/.test(raw.trim())
    };

    if (lowerFile.endsWith('.py')) {
      return [
        { regex: /^\s*(?:async\s+)?def\s+(test_[A-Za-z0-9_]+)\s*\(/gm, nameGroup: 1, skipped: () => false, focused: () => false },
        { regex: /^\s*class\s+(Test[A-Za-z0-9_]+)\s*[:(]/gm, nameGroup: 1, skipped: () => false, focused: () => false },
      ];
    }
    if (lowerFile.endsWith('_test.go')) {
      return [
        { regex: /^\s*func\s+(Test[A-Za-z0-9_]+)\s*\(/gm, nameGroup: 1, skipped: () => false, focused: () => false },
      ];
    }
    if (lowerFile.endsWith('_test.rs')) {
      return [
        { regex: /#\[(?:tokio::)?test\][\s\S]{0,160}?\bfn\s+([A-Za-z0-9_]+)/g, nameGroup: 1, skipped: () => false, focused: () => false },
      ];
    }
    if (/\.(java|kt|cs|php)$/i.test(lowerFile)) {
      return [
        { regex: /@Test[\s\S]{0,220}?\b(?:fun|void|public\s+\w+|function)\s+([A-Za-z0-9_]+)/g, nameGroup: 1, skipped: () => false, focused: () => false },
      ];
    }
    return [
      {
        regex: /\b(?:describe|context|suite|it|test|specify)(?:\.(?:skip|only))?(?:\.each\s*\([^)]*\))?\s*\(\s*(['"`])([^'"`]+)\1/g,
        nameGroup: 2,
        skipped: commonStatus.skipped,
        focused: commonStatus.focused
      },
      {
        regex: /\b(?:xdescribe|xit|xtest|fdescribe|fit|ftest)\s*\(\s*(['"`])([^'"`]+)\1/g,
        nameGroup: 2,
        skipped: commonStatus.skipped,
        focused: commonStatus.focused
      },
    ];
  }

  private lineNumberAtOffset(content: string, offset: number): number {
    return content.slice(0, offset).split(/\r?\n/).length;
  }

  private testCaseId(file: string, name: string, line: number, index: number): string {
    const slug = `${file}:${line}:${name}:${index}`
      .replace(/\\/g, '/')
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toLowerCase();
    return `test_${slug || `case_${index}`}`;
  }

  private dedupeTestCases(tests: CASTestCase[]): CASTestCase[] {
    const seen = new Set<string>();
    return tests.filter(test => {
      const key = `${test.source?.file}:${test.source?.line}:${test.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private inferTestType(node: CASNode): 'unit' | 'integration' | 'e2e' | 'acceptance' {
    const name = (node.name || '').toLowerCase();
    const file = (node.source?.file || '').toLowerCase();

    if (name.includes('e2e') || file.includes('e2e') || file.includes('cypress')) return 'e2e';
    if (name.includes('integration') || file.includes('integration')) return 'integration';
    if (name.includes('acceptance') || file.includes('acceptance')) return 'acceptance';
    return 'unit';
  }

  private inferTestFramework(node: CASNode): string {
    const file = (node.source?.file || '').toLowerCase();
    const name = (node.name || '').toLowerCase();
    const lang = node.metadata?.language;

    if (file.endsWith('.spec.ts') || file.endsWith('.test.ts') || file.endsWith('.spec.js') || file.endsWith('.test.js')) {
      if (file.includes('cypress')) return 'cypress';
      if (file.includes('vitest')) return 'vitest';
      return 'jest';
    }
    if (file.endsWith('.test.tsx') || file.endsWith('.spec.tsx')) return 'jest';
    if (name.includes('testcase') || file.includes('unittest')) return 'unittest';
    if (file.includes('pytest') || file.includes('conftest')) return 'pytest';
    if (file.includes('django')) return 'django.test';
    if (file.endsWith('.py') && (file.includes('/tests/') || name.startsWith('test') || name.endsWith('tests'))) return 'pytest';
    if (file.endsWith('_test.go')) return 'go-test';
    if (file.endsWith('test.java') || file.endsWith('test.kt')) return 'junit';
    if (file.endsWith('tests.cs') || file.endsWith('test.cs')) return 'xunit';
    if (file.endsWith('_test.rs')) return 'rust-test';
    if (lang === 'python') return 'pytest';
    if (lang === 'typescript' || lang === 'javascript') return 'jest';
    return 'unknown';
  }

  private buildMocks(nodes: CASNode[]): CASMock[] {
    const mocks: CASMock[] = [];

    const mockNodes = nodes.filter(n =>
      n.name.toLowerCase().includes('mock') ||
      n.name.includes('Mock') ||
      n.subcategories?.includes('mock')
    );

    for (const mock of mockNodes) {
      mocks.push({
        id: `mock_${mock.id}`,
        name: mock.name,
        type: this.inferMockType(mock),
        framework: 'unittest.mock'
      });
    }

    return mocks;
  }

  private inferMockType(node: CASNode): 'mock' | 'stub' | 'spy' | 'fake' {
    const name = node.name.toLowerCase();
    if (name.includes('stub')) return 'stub';
    if (name.includes('spy')) return 'spy';
    if (name.includes('fake')) return 'fake';
    return 'mock';
  }

  private buildFixtures(nodes: CASNode[]): CASFixture[] {
    const fixtures: CASFixture[] = [];
    const addedIds = new Set<string>();

    const fixtureNodes = nodes.filter(n =>
      n.name.includes('fixture') ||
      n.subcategories?.includes('fixture')
    );

    for (const fixture of fixtureNodes) {
      const id = `fixture_${fixture.id}`;
      if (addedIds.has(id)) continue;
      addedIds.add(id);
      fixtures.push({
        id,
        name: fixture.name,
        type: 'fixture',
        file_path: fixture.source?.file || ''
      });
    }

    const confTestFiles = nodes.filter(n =>
      n.type === 'file' &&
      (n.name === 'conftest.py' || n.source?.file?.endsWith('conftest.py'))
    );

    for (const conftest of confTestFiles) {
      const fixtureFunctions = nodes.filter(n =>
        n.parent === conftest.id &&
        n.type === 'function'
      );

      for (const fn of fixtureFunctions) {
        const id = `fixture_${fn.id}`;
        if (addedIds.has(id)) continue;
        addedIds.add(id);
        fixtures.push({
          id,
          name: fn.name,
          type: 'fixture',
          file_path: fn.source?.file || conftest.source?.file || ''
        });
      }
    }

    const setupMethods = nodes.filter(n =>
      (n.type === 'method' || n.type === 'function' || n.type === 'hook') &&
      (n.name === 'setUp' || n.name === 'tearDown' ||
       n.name === 'setUpClass' || n.name === 'tearDownClass' ||
       n.name === 'beforeEach' || n.name === 'afterEach' ||
       n.name === 'beforeAll' || n.name === 'afterAll' ||
       n.name === 'before' || n.name === 'after' ||
       n.name === 'setupForTest')
    );

    for (const setup of setupMethods) {
      const id = `fixture_${setup.id}`;
      if (addedIds.has(id)) continue;
      addedIds.add(id);
      fixtures.push({
        id,
        name: setup.name,
        type: 'fixture',
        file_path: setup.source?.file || ''
      });
    }

    const setupFiles = nodes.filter(n =>
      n.type === 'file' &&
      (n.name.startsWith('jest.setup') || n.name.startsWith('vitest.setup') ||
       n.name === 'setup.ts' || n.name === 'setup.js' ||
       n.name === 'test-setup.ts' || n.name === 'test-setup.js' ||
       n.name === 'globalSetup.ts' || n.name === 'globalSetup.js')
    );

    for (const setupFile of setupFiles) {
      const id = `fixture_${setupFile.id}`;
      if (addedIds.has(id)) continue;
      addedIds.add(id);
      fixtures.push({
        id,
        name: setupFile.name,
        type: 'fixture',
        file_path: setupFile.source?.file || setupFile.name
      });
    }

    const factoryNodes = nodes.filter(n =>
      (n.type === 'function' || n.type === 'class') &&
      (n.name.toLowerCase().includes('factory') ||
       n.name.toLowerCase().includes('builder') ||
       n.name.toLowerCase().includes('seed'))
    );

    for (const factory of factoryNodes) {
      const id = `fixture_${factory.id}`;
      if (addedIds.has(id)) continue;
      addedIds.add(id);
      fixtures.push({
        id,
        name: factory.name,
        type: 'factory',
        file_path: factory.source?.file || ''
      });
    }

    return fixtures;
  }

  private buildTestSummary(nodes: CASNode[], entryPoints: CASEntryPoint[]): CASTestSummary {
    const testNodes = nodes.filter(n =>
      (n.type === 'method' || n.type === 'function') &&
      (n.name.startsWith('test_') || n.name.startsWith('test') ||
       n.name.startsWith('it') || n.name.startsWith('should') ||
       n.name.startsWith('specify') || n.subcategories?.includes('test'))
    );

    let unit = 0;
    let integration = 0;
    let e2e = 0;
    let acceptance = 0;

    for (const node of testNodes) {
      const type = this.inferTestType(node);
      switch (type) {
        case 'unit': unit++; break;
        case 'integration': integration++; break;
        case 'e2e': e2e++; break;
        case 'acceptance': acceptance++; break;
      }
    }

    return {
      total_tests: testNodes.length,
      by_type: {
        unit,
        integration,
        e2e,
        acceptance,
        bdd: 0,
        other: 0
      },
      by_status: {
        passing: testNodes.length,
        failing: 0,
        skipped: 0,
        flaky: 0
      },
      coverage: {
        overall_percentage: undefined
      },
      mocks: {
        total: nodes.filter(n => n.name.toLowerCase().includes('mock')).length
      },
      fixtures: {
        total: nodes.filter(n =>
          n.name.includes('fixture') ||
          n.name === 'beforeEach' || n.name === 'afterEach' ||
          n.name === 'beforeAll' || n.name === 'afterAll' ||
          n.name === 'setUp' || n.name === 'tearDown'
        ).length
      }
    };
  }

  private buildValidation(
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[] = [],
    exitPoints: CASExitPoint[] = [],
    runtimeLinks: CASRuntimeStaticLink[] = [],
    analysisFacts: CASAnalysisFact[] = []
  ): CASValidation {
    const nodeIds = new Set(nodes.map(n => n.id));
    const entryPointIds = new Set(entryPoints.map(entryPoint => entryPoint.id));
    const exitPointIds = new Set(exitPoints.map(exitPoint => exitPoint.id));
    const graphEndpointIds = new Set([...nodeIds, ...entryPointIds, ...exitPointIds]);
    const warnings: Array<{ path?: string; message?: string }> = [];
    let danglingEdges = 0;
    const connectedNodeIds = new Set<string>();

    for (const edge of edges) {
      if (!graphEndpointIds.has(edge.source)) {
        danglingEdges++;
        warnings.push({
          path: `edges[${edge.id}].source`,
          message: `Edge source "${edge.source}" references nonexistent graph endpoint`
        });
      } else if (nodeIds.has(edge.source)) {
        connectedNodeIds.add(edge.source);
      }
      if (!graphEndpointIds.has(edge.target)) {
        danglingEdges++;
        warnings.push({
          path: `edges[${edge.id}].target`,
          message: `Edge target "${edge.target}" references nonexistent graph endpoint`
        });
      } else if (nodeIds.has(edge.target)) {
        connectedNodeIds.add(edge.target);
      }
    }

    const nodesWithLocation = nodes.filter(n => n.source?.file && n.source?.line).length;
    const edgesWithMetadata = edges.filter(e => e.metadata && Object.keys(e.metadata).length > 0).length;
    const documentedNodes = nodes.filter(n => n.documentation).length;
    const entryPointNodeIds = new Set(entryPoints.flatMap(entryPoint => [entryPoint.source_node, entryPoint.handler?.node_id].filter(Boolean) as string[]));
    const exitPointNodeIds = new Set(exitPoints.map(exitPoint => exitPoint.source_node).filter(Boolean));
    const orphanedNodes = nodes.filter(node =>
      !connectedNodeIds.has(node.id) &&
      !entryPointNodeIds.has(node.id) &&
      !exitPointNodeIds.has(node.id) &&
      node.type !== 'system'
    ).length;
    const entryPointsWithHandlers = entryPoints.filter(entryPoint => {
      const handlerNodeId = entryPoint.handler?.node_id || entryPoint.source_node;
      return !!handlerNodeId && nodeIds.has(handlerNodeId);
    }).length;
    const exitPointsWithSources = exitPoints.filter(exitPoint => nodeIds.has(exitPoint.source_node)).length;
    const runtimeLinksWithInstrumentation = runtimeLinks.filter(link => link.instrumentation_points.length > 0).length;
    const factsWithEvidence = analysisFacts.filter(fact => fact.evidence.length > 0).length;
    const coverageParts = [
      nodes.length > 0 ? nodesWithLocation / nodes.length : 1,
      edges.length > 0 ? (edges.length - danglingEdges) / edges.length : 1,
      entryPoints.length > 0 ? entryPointsWithHandlers / entryPoints.length : 1,
      exitPoints.length > 0 ? exitPointsWithSources / exitPoints.length : 1,
      runtimeLinks.length > 0 ? runtimeLinksWithInstrumentation / runtimeLinks.length : 1,
      analysisFacts.length > 0 ? factsWithEvidence / analysisFacts.length : 1
    ];
    const relationshipCoverageScore = Math.round(
      (coverageParts.reduce((sum, value) => sum + value, 0) / coverageParts.length) * 100
    );

    return {
      schema_version: '1.8.0',
      validation_warnings: warnings.length > 0 ? warnings : undefined,
      completeness: {
        nodes_with_location: nodesWithLocation,
        edges_with_metadata: edgesWithMetadata,
        documented_nodes: documentedNodes
      },
      graph_integrity: {
        total_edges: edges.length,
        dangling_edges: danglingEdges,
        connected_nodes: connectedNodeIds.size,
        orphaned_nodes: orphanedNodes,
        entry_points_with_handlers: entryPointsWithHandlers,
        exit_points_with_sources: exitPointsWithSources,
        runtime_links_with_instrumentation: runtimeLinksWithInstrumentation,
        facts_with_evidence: factsWithEvidence,
        relationship_coverage_score: relationshipCoverageScore
      }
    };
  }

  private buildDocumentationSummary(nodes: CASNode[]): CASDocumentationSummary {
    const functionTypes = new Set(['function', 'method', 'constructor']);
    const classTypes = new Set(['class']);
    const interfaceTypes = new Set(['interface', 'type_alias']);
    const moduleTypes = new Set(['module', 'namespace', 'package']);

    const byType = {
      functions: { documented: 0, total: 0, coverage: 0 },
      classes: { documented: 0, total: 0, coverage: 0 },
      interfaces: { documented: 0, total: 0, coverage: 0 },
      modules: { documented: 0, total: 0, coverage: 0 }
    };

    let totalDocumented = 0;
    let totalDescriptionLength = 0;
    let paramsDocumented = 0;
    let returnsDocumented = 0;
    let examplesProvided = 0;
    let deprecatedItems = 0;
    const byDocType: Record<string, number> = {};
    const missingDocs: CASDocumentationSummary['missing_documentation'] = [];

    for (const node of nodes) {
      const hasDoc = !!node.documentation;
      const type = node.type;

      if (functionTypes.has(type)) {
        byType.functions.total++;
        if (hasDoc) byType.functions.documented++;
      } else if (classTypes.has(type)) {
        byType.classes.total++;
        if (hasDoc) byType.classes.documented++;
      } else if (interfaceTypes.has(type)) {
        byType.interfaces.total++;
        if (hasDoc) byType.interfaces.documented++;
      } else if (moduleTypes.has(type)) {
        byType.modules.total++;
        if (hasDoc) byType.modules.documented++;
      }

      if (hasDoc) {
        totalDocumented++;
        const doc = node.documentation!;
        const desc = doc.description || doc.summary || doc.raw || '';
        totalDescriptionLength += desc.length;

        if (doc.parameters && doc.parameters.length > 0) paramsDocumented++;
        if (doc.returns || doc.return_info) returnsDocumented++;
        if (doc.examples && doc.examples.length > 0) examplesProvided++;
        if (doc.tags?.some(t => t.tag === 'deprecated')) deprecatedItems++;

        const format = doc.format || doc.type || 'other';
        byDocType[format] = (byDocType[format] || 0) + 1;
      } else if (node.metadata?.is_exported || node.metadata?.access_modifier === 'public') {
        const importance: 'low' | 'medium' | 'high' =
          classTypes.has(type) || interfaceTypes.has(type) ? 'high' :
          functionTypes.has(type) ? 'medium' : 'low';

        missingDocs.push({
          node_id: node.id,
          node_name: node.name,
          node_type: type,
          importance,
          reason: `Exported ${type} lacks documentation`
        });
      }
    }

    for (const key of Object.keys(byType) as Array<keyof typeof byType>) {
      const entry = byType[key];
      entry.coverage = entry.total > 0 ? entry.documented / entry.total : 0;
    }

    const totalApplicable = byType.functions.total + byType.classes.total +
      byType.interfaces.total + byType.modules.total;

    return {
      total_documented_nodes: totalDocumented,
      documentation_coverage: totalApplicable > 0 ? totalDocumented / totalApplicable : 0,
      by_type: byType,
      by_documentation_type: byDocType,
      quality_metrics: {
        average_description_length: totalDocumented > 0 ? Math.round(totalDescriptionLength / totalDocumented) : 0,
        parameters_documented: paramsDocumented,
        returns_documented: returnsDocumented,
        examples_provided: examplesProvided,
        deprecated_items: deprecatedItems
      },
      missing_documentation: missingDocs.slice(0, 100)
    };
  }

  private buildTodosSummary(nodes: CASNode[]): CASTodoSummary {
    let totalTodos = 0;
    let totalFixmes = 0;
    let totalHacks = 0;
    let totalWarnings = 0;
    const byPriority = { critical: 0, high: 0, medium: 0, low: 0 };
    const byCategory: Record<string, number> = {};
    let technicalDebtItems = 0;
    let blockingItems = 0;
    const fileMap = new Map<string, { count: number; types: Set<string> }>();

    for (const node of nodes) {
      if (!node.todos || node.todos.length === 0) continue;

      for (const todo of node.todos) {
        switch (todo.type) {
          case 'TODO': totalTodos++; break;
          case 'FIXME': totalFixmes++; break;
          case 'HACK': totalHacks++; break;
          case 'WARNING': totalWarnings++; break;
        }

        const priority = todo.priority || 'medium';
        byPriority[priority]++;

        const category = todo.category || todo.classification?.category || 'general';
        byCategory[category] = (byCategory[category] || 0) + 1;

        if (todo.classification?.technical_debt || todo.type === 'HACK' || todo.type === 'REFACTOR' as any) {
          technicalDebtItems++;
        }
        if (todo.classification?.blocking) {
          blockingItems++;
        }

        const file = todo.location?.file || node.source?.file || 'unknown';
        if (!fileMap.has(file)) {
          fileMap.set(file, { count: 0, types: new Set() });
        }
        const entry = fileMap.get(file)!;
        entry.count++;
        entry.types.add(todo.type);
      }
    }

    const hotspots = Array.from(fileMap.entries())
      .map(([file, data]) => ({
        file,
        todo_count: data.count,
        types: Array.from(data.types)
      }))
      .sort((a, b) => b.todo_count - a.todo_count)
      .slice(0, 20);

    return {
      total_todos: totalTodos,
      total_fixmes: totalFixmes,
      total_hacks: totalHacks,
      total_warnings: totalWarnings,
      by_priority: byPriority,
      by_category: byCategory,
      technical_debt_items: technicalDebtItems,
      blocking_items: blockingItems,
      hotspots
    };
  }

  private buildImplementationHealth(nodes: CASNode[]): CASImplementationHealth {
    let complete = 0;
    let partial = 0;
    let stubs = 0;
    let notImplemented = 0;
    let deprecated = 0;
    let experimental = 0;
    const riskAreas: CASImplementationHealth['risk_areas'] = [];
    const deprecationTimeline: CASImplementationHealth['deprecation_timeline'] = [];

    for (const node of nodes) {
      if (!node.implementation_status) continue;

      switch (node.implementation_status.status) {
        case 'complete': complete++; break;
        case 'partial': partial++; break;
        case 'stub': stubs++; break;
        case 'not-implemented': notImplemented++; break;
        case 'deprecated': deprecated++; break;
        case 'experimental': experimental++; break;
      }

      if (node.implementation_status.status === 'stub' || node.implementation_status.status === 'not-implemented') {
        riskAreas.push({
          node_id: node.id,
          node_name: node.name,
          risk_type: 'incomplete',
          risk_level: node.implementation_status.status === 'not-implemented' ? 'high' : 'medium',
          recommendation: `Complete implementation of ${node.name}`
        });
      }

      if (node.implementation_status.status === 'deprecated') {
        riskAreas.push({
          node_id: node.id,
          node_name: node.name,
          risk_type: 'deprecated',
          risk_level: 'medium',
          recommendation: `Migrate away from deprecated ${node.name}`
        });

        if (node.implementation_status.deprecation) {
          deprecationTimeline.push({
            node_id: node.id,
            node_name: node.name,
            deprecated_since: node.implementation_status.deprecation.deprecated_since || 'unknown',
            removal_version: node.implementation_status.deprecation.removal_version
          });
        }
      }

      if (node.implementation_status.status === 'experimental') {
        riskAreas.push({
          node_id: node.id,
          node_name: node.name,
          risk_type: 'unstable',
          risk_level: 'low',
          recommendation: `Monitor stability of experimental ${node.name}`
        });
      }
    }

    const total = complete + partial + stubs + notImplemented + deprecated + experimental;
    const healthScore = total > 0 ? (complete + partial * 0.5) / total : 1.0;

    return {
      complete_implementations: complete,
      partial_implementations: partial,
      stubs,
      not_implemented: notImplemented,
      deprecated,
      experimental,
      health_score: Math.round(healthScore * 100) / 100,
      risk_areas: riskAreas.slice(0, 50),
      deprecation_timeline: deprecationTimeline.length > 0 ? deprecationTimeline : undefined
    };
  }

  private buildRuntime(
    projectPath: string,
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[],
    externalServices: CASExternalService[],
    configuration: CASConfiguration,
    callChains: CASCallChain[]
  ): CASRuntime {
    const packageJsonPath = path.join(projectPath, 'package.json');
    const dockerfilePath = path.join(projectPath, 'Dockerfile');
    const dockerComposePath = path.join(projectPath, 'docker-compose.yml');
    const composePath = path.join(projectPath, 'compose.yml');
    const packageJson = fs.existsSync(packageJsonPath) ? fs.readJsonSync(packageJsonPath) : {};
    const scripts = packageJson.scripts || {};
    const runtimeDependencies = [
      ...Object.keys(packageJson.dependencies || {}),
      ...Object.keys(packageJson.peerDependencies || {})
    ];

    const healthEntryPoint = entryPoints.find(ep => {
      const value = `${ep.name} ${ep.trigger?.path || ''}`.toLowerCase();
      return value.includes('health') || value.includes('ready') || value.includes('live');
    });
    const metricsEntryPoint = entryPoints.find(ep => {
      const value = `${ep.name} ${ep.trigger?.path || ''}`.toLowerCase();
      return value.includes('metrics') || value.includes('prometheus');
    });

    const deployment: CASRuntime['deployment'] = {};
    if (fs.existsSync(dockerfilePath)) {
      deployment.type = 'container';
    }
    if (fs.existsSync(dockerComposePath) || fs.existsSync(composePath)) {
      deployment.orchestration = 'docker-compose';
    } else if (fs.existsSync(path.join(projectPath, 'k8s')) || fs.existsSync(path.join(projectPath, 'kubernetes'))) {
      deployment.orchestration = 'kubernetes';
    } else if (fs.existsSync(path.join(projectPath, 'vercel.json'))) {
      deployment.type = 'vercel';
    } else if (fs.existsSync(path.join(projectPath, 'render.yaml'))) {
      deployment.type = 'render';
    }

    const runtime: CASRuntime = {};
    if (Object.keys(deployment).length > 0) {
      runtime.deployment = deployment;
    }

    const runtimeName = packageJson.engines?.node
      ? `node ${packageJson.engines.node}`
      : packageJson.engines?.python
        ? `python ${packageJson.engines.python}`
        : scripts.start
          ? 'node'
          : undefined;

    runtime.dependencies = {
      runtime: runtimeName,
      system_libraries: runtimeDependencies.slice(0, 50),
      external_services: externalServices.map(service => service.name)
    };

    if (healthEntryPoint || metricsEntryPoint || configuration.environment_variables?.some(env => env.name.toLowerCase().includes('log'))) {
      runtime.monitoring = {
        health_check: healthEntryPoint?.trigger?.path || healthEntryPoint?.name,
        readiness_check: entryPoints.find(ep => `${ep.name} ${ep.trigger?.path || ''}`.toLowerCase().includes('ready'))?.trigger?.path,
        metrics_endpoint: metricsEntryPoint?.trigger?.path || metricsEntryPoint?.name,
        logging: configuration.environment_variables?.some(env => env.name.toLowerCase().includes('log'))
          ? { destinations: ['application'] }
          : undefined
      };
    }

    runtime.instrumentation = {
      instrumentable_entry_points: entryPoints
        .filter(ep => ep.source_node || ep.handler?.node_id)
        .map(ep => ep.id),
      instrumentable_exit_points: exitPoints
        .filter(ep => ep.source_node || (ep.connected_nodes || []).length > 0)
        .map(ep => ep.id),
      observed_call_chains: callChains
        .filter(chain => !!chain.runtime_stats)
        .map(chain => chain.id),
      missing_runtime_coverage: callChains
        .filter(chain => !chain.runtime_stats)
        .slice(0, 100)
        .map(chain => chain.id)
    };

    return runtime;
  }

  private buildRepositoryLinks(
    projectPath: string,
    nodes: CASNode[],
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[],
    externalServices: CASExternalService[],
    libraries: CASLibrary[],
    databaseSchema: CASDatabaseSchema,
    configuration: CASConfiguration
  ): CASCrossRepositoryLink[] {
    const sourceRepository = {
      url: this.readGitRemote(projectPath),
      path: projectPath
    };
    const links: CASCrossRepositoryLink[] = [];

    for (const service of externalServices) {
      if (!service.endpoint) continue;
      links.push({
        id: `repo_link_api_${service.id}`,
        type: 'api',
        source_repository: {
          ...sourceRepository,
          node_ids: service.connected_nodes
        },
        target_repository: {
          url: service.endpoint
        },
        connection: {
          protocol: service.endpoint.startsWith('http') ? 'http' : service.type,
          endpoint: service.endpoint
        },
        metadata: {
          verified: false,
          confidence: 0.7,
          evidence: [{
            kind: 'runtime-signal',
            source: service.name,
            confidence: 0.7
          }]
        }
      });
    }

    for (const library of libraries) {
      const name = library.name || '';
      const lower = name.toLowerCase();
      const isContractPackage = name.startsWith('@') ||
        lower.includes('client') ||
        lower.includes('sdk') ||
        lower.includes('schema') ||
        lower.includes('proto') ||
        lower.includes('contract');

      if (!isContractPackage) continue;

      links.push({
        id: `repo_link_library_${this.slugForId(name)}`,
        type: lower.includes('schema') || lower.includes('proto') || lower.includes('contract') ? 'shared-schema' : 'library',
        source_repository: {
          ...sourceRepository,
          node_ids: library.connected_nodes
        },
        connection: {
          package_name: name,
          version: library.version
        },
        metadata: {
          verified: false,
          confidence: name.startsWith('@') ? 0.75 : 0.55,
          evidence: [{
            kind: 'dependency',
            source: name,
            confidence: name.startsWith('@') ? 0.75 : 0.55
          }]
        }
      });
    }

    for (const exitPoint of exitPoints) {
      if (exitPoint.type !== 'message' && exitPoint.type !== 'event') continue;
      links.push({
        id: `repo_link_message_${exitPoint.id}`,
        type: 'message-contract',
        source_repository: {
          ...sourceRepository,
          node_ids: [exitPoint.source_node, ...(exitPoint.connected_nodes || [])].filter(Boolean)
        },
        connection: {
          broker: exitPoint.target?.service_id,
          exchange: exitPoint.target?.resource,
          routing_key: exitPoint.target?.endpoint
        },
        metadata: {
          verified: false,
          confidence: 0.65,
          evidence: [{
            kind: 'graph',
            source: exitPoint.id,
            file: this.nodeFile(nodes, exitPoint.source_node),
            confidence: 0.65
          }]
        }
      });
    }

    if (databaseSchema.entities.length > 0) {
      const configFiles = configuration.config_files?.map(file => file.path).filter((value): value is string => !!value) || [];
      links.push({
        id: `repo_link_database_${this.slugForId(databaseSchema.entities.map(entity => entity.name).slice(0, 5).join('_'))}`,
        type: 'shared-database',
        source_repository: {
          ...sourceRepository,
          node_ids: databaseSchema.entities
            .flatMap(entity => nodes
              .filter(node => entity.source_file && node.source?.file === entity.source_file)
              .map(node => node.id))
            .slice(0, 100)
        },
        connection: {
          contract: databaseSchema.entities.map(entity => entity.name).join(',')
        },
        metadata: {
          verified: false,
          confidence: configFiles.length > 0 ? 0.7 : 0.5,
          evidence: configFiles.length > 0
            ? configFiles.map(file => ({
              kind: 'configuration' as const,
              source: file,
              file,
              confidence: 0.7
            }))
            : [{
              kind: 'graph' as const,
              source: 'database_schema',
              confidence: 0.5
            }]
        }
      });
    }

    return links;
  }

  private buildRuntimeStaticLinks(
    nodes: CASNode[],
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[],
    callChains: CASCallChain[],
    externalServices: CASExternalService[]
  ): CASRuntimeStaticLink[] {
    const links: CASRuntimeStaticLink[] = [];

    for (const entryPoint of entryPoints) {
      const signal = entryPoint.trigger?.path
        ? `${entryPoint.trigger?.method || entryPoint.type} ${entryPoint.trigger.path}`
        : `${entryPoint.type} ${entryPoint.name}`;
      const instrumentationPoints = [entryPoint.source_node, entryPoint.handler?.node_id].filter((value): value is string => !!value);
      links.push({
        id: `runtime_entry_${entryPoint.id}`,
        kind: 'entry-point',
        static_id: entryPoint.id,
        runtime_signal: signal,
        telemetry_status: instrumentationPoints.length > 0 ? 'instrumentable' : 'not-instrumented',
        confidence: instrumentationPoints.length > 0 ? 0.85 : 0.4,
        instrumentation_points: instrumentationPoints,
        evidence: [{
          kind: 'route',
          source: entryPoint.id,
          file: this.nodeFile(nodes, entryPoint.source_node),
          line: this.nodeLine(nodes, entryPoint.source_node),
          confidence: instrumentationPoints.length > 0 ? 0.85 : 0.4
        }]
      });
    }

    for (const exitPoint of exitPoints) {
      const instrumentationPoints = [exitPoint.source_node, ...(exitPoint.connected_nodes || [])].filter(Boolean);
      links.push({
        id: `runtime_exit_${exitPoint.id}`,
        kind: 'exit-point',
        static_id: exitPoint.id,
        runtime_signal: exitPoint.target?.endpoint || exitPoint.target?.resource || exitPoint.name || exitPoint.type,
        telemetry_status: instrumentationPoints.length > 0 ? 'instrumentable' : 'not-instrumented',
        confidence: instrumentationPoints.length > 0 ? 0.8 : 0.4,
        instrumentation_points: instrumentationPoints,
        evidence: [{
          kind: 'graph',
          source: exitPoint.id,
          file: this.nodeFile(nodes, exitPoint.source_node),
          line: this.nodeLine(nodes, exitPoint.source_node),
          confidence: instrumentationPoints.length > 0 ? 0.8 : 0.4
        }]
      });
    }

    for (const chain of callChains) {
      const instrumentationPoints = chain.call_path.map(step => step.node_id);
      links.push({
        id: `runtime_chain_${chain.id}`,
        kind: 'call-chain',
        static_id: chain.id,
        runtime_signal: chain.business_context?.business_process || chain.business_context?.feature_area || chain.entry_point?.method_name || chain.id,
        telemetry_status: chain.runtime_stats ? 'observed' : instrumentationPoints.length > 0 ? 'instrumentable' : 'not-instrumented',
        confidence: chain.runtime_stats ? 0.95 : instrumentationPoints.length > 0 ? 0.75 : 0.35,
        instrumentation_points: instrumentationPoints,
        evidence: [{
          kind: chain.runtime_stats ? 'runtime-signal' : 'graph',
          source: chain.id,
          confidence: chain.runtime_stats ? 0.95 : 0.75
        }]
      });
    }

    for (const service of externalServices) {
      links.push({
        id: `runtime_service_${service.id}`,
        kind: 'external-service',
        static_id: service.id,
        runtime_signal: service.endpoint || service.name,
        telemetry_status: (service.connected_nodes || []).length > 0 ? 'instrumentable' : 'not-instrumented',
        confidence: (service.connected_nodes || []).length > 0 ? 0.75 : 0.45,
        instrumentation_points: service.connected_nodes || [],
        evidence: [{
          kind: 'runtime-signal',
          source: service.name,
          confidence: (service.connected_nodes || []).length > 0 ? 0.75 : 0.45
        }]
      });
    }

    return links;
  }

  private buildAnalysisFacts(
    nodes: CASNode[],
    edges: CASEdge[],
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[],
    externalServices: CASExternalService[],
    workflows: CASWorkflow[],
    capabilities: SystemCapability[],
    runtimeLinks: CASRuntimeStaticLink[],
    repositoryLinks: CASCrossRepositoryLink[],
    contributions: any[]
  ): CASAnalysisFact[] {
    const analyzerName = contributions[0]?.analyzer_name || 'AnalyzerOrchestrator';
    const facts: CASAnalysisFact[] = [];

    for (const node of nodes) {
      if (!node.source?.file) continue;
      facts.push({
        id: `fact_node_${node.id}`,
        subject_type: 'node',
        subject_id: node.id,
        fact_type: 'definition',
        claim: `${node.name} is a ${node.type}`,
        confidence: 0.9,
        produced_by: node.primaryAnalyzer || analyzerName,
        evidence: [{
          kind: 'source-location',
          source: node.name,
          file: node.source.file,
          line: node.source.line,
          excerpt: node.source.raw,
          confidence: 0.9
        }]
      });
    }

    for (const edge of edges) {
      const location = edge.metadata?.locations?.[0];
      facts.push({
        id: `fact_edge_${edge.id}`,
        subject_type: 'edge',
        subject_id: edge.id,
        fact_type: 'relationship',
        claim: `${edge.source} ${edge.type} ${edge.target}`,
        confidence: edge.metadata?.confidence || 0.75,
        produced_by: analyzerName,
        evidence: [{
          kind: location ? 'source-location' : 'graph',
          source: edge.id,
          file: location?.file,
          line: location?.line,
          confidence: edge.metadata?.confidence || 0.75
        }]
      });
    }

    for (const entryPoint of entryPoints) {
      facts.push({
        id: `fact_entry_${entryPoint.id}`,
        subject_type: 'entry_point',
        subject_id: entryPoint.id,
        fact_type: 'entry',
        claim: `${entryPoint.name} exposes ${entryPoint.type}`,
        confidence: 0.85,
        produced_by: entryPoint.source_analyzer || analyzerName,
        evidence: [{
          kind: 'route',
          source: entryPoint.id,
          file: this.nodeFile(nodes, entryPoint.source_node),
          line: this.nodeLine(nodes, entryPoint.source_node),
          confidence: 0.85
        }]
      });
    }

    for (const exitPoint of exitPoints) {
      facts.push({
        id: `fact_exit_${exitPoint.id}`,
        subject_type: 'exit_point',
        subject_id: exitPoint.id,
        fact_type: 'exit',
        claim: `${exitPoint.name || exitPoint.id} leaves the system through ${exitPoint.type}`,
        confidence: 0.8,
        produced_by: analyzerName,
        evidence: [{
          kind: 'graph',
          source: exitPoint.id,
          file: this.nodeFile(nodes, exitPoint.source_node),
          line: this.nodeLine(nodes, exitPoint.source_node),
          confidence: 0.8
        }]
      });
    }

    for (const workflow of workflows) {
      const evidence = workflow.entry_points.length > 0
        ? workflow.entry_points.map(entryPointId => ({
          kind: 'graph' as const,
          source: entryPointId,
          confidence: 0.75
        }))
        : [{
          kind: 'graph' as const,
          source: workflow.id,
          confidence: 0.6
        }];

      facts.push({
        id: `fact_workflow_${workflow.id}`,
        subject_type: 'workflow',
        subject_id: workflow.id,
        fact_type: 'workflow',
        claim: `${workflow.name} is a ${workflow.classification} ${workflow.workflow_type} workflow`,
        confidence: 0.75,
        produced_by: 'WorkflowDetector',
        evidence
      });
    }

    for (const capability of capabilities) {
      const evidence = capability.operations.length > 0
        ? capability.operations.map(operation => ({
          kind: 'route' as const,
          source: operation.entry_point_id,
          confidence: 0.75
        }))
        : [{
          kind: 'graph' as const,
          source: capability.id,
          confidence: 0.6
        }];

      facts.push({
        id: `fact_capability_${capability.id}`,
        subject_type: 'capability',
        subject_id: capability.id,
        fact_type: 'capability',
        claim: `${capability.name} is a ${capability.criticality} ${capability.category} capability`,
        confidence: 0.75,
        produced_by: 'CapabilityDetector',
        evidence
      });
    }

    for (const runtimeLink of runtimeLinks) {
      facts.push({
        id: `fact_runtime_${runtimeLink.id}`,
        subject_type: 'runtime_link',
        subject_id: runtimeLink.id,
        fact_type: 'runtime-correlation',
        claim: `${runtimeLink.static_id} maps to runtime signal ${runtimeLink.runtime_signal}`,
        confidence: runtimeLink.confidence,
        produced_by: 'AnalyzerOrchestrator',
        evidence: runtimeLink.evidence
      });
    }

    for (const repositoryLink of repositoryLinks) {
      const confidence = repositoryLink.metadata?.confidence || 0.5;
      const evidence = repositoryLink.metadata?.evidence?.length
        ? repositoryLink.metadata.evidence
        : [{
          kind: 'graph' as const,
          source: repositoryLink.id,
          confidence
        }];

      facts.push({
        id: `fact_repository_${repositoryLink.id}`,
        subject_type: 'repository_link',
        subject_id: repositoryLink.id,
        fact_type: 'cross-repository',
        claim: `${repositoryLink.id} links this codebase through ${repositoryLink.type}`,
        confidence,
        produced_by: 'AnalyzerOrchestrator',
        evidence
      });
    }

    for (const service of externalServices) {
      facts.push({
        id: `fact_service_${service.id}`,
        subject_type: 'external_service',
        subject_id: service.id,
        fact_type: 'relationship',
        claim: `${service.name} is an external ${service.type} dependency`,
        confidence: 0.7,
        produced_by: analyzerName,
        evidence: [{
          kind: 'graph',
          source: service.id,
          confidence: 0.7
        }]
      });
    }

    return facts;
  }

  private readGitRemote(projectPath: string): string | undefined {
    const gitConfigPath = path.join(projectPath, '.git', 'config');
    if (!fs.existsSync(gitConfigPath)) return undefined;

    const config = fs.readFileSync(gitConfigPath, 'utf-8');
    const match = config.match(/\[remote "origin"\][\s\S]*?url = (.+)/);
    return match?.[1]?.trim();
  }

  private slugForId(value: string): string {
    return value.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'unknown';
  }

  private nodeFile(nodes: CASNode[], nodeId?: string): string | undefined {
    if (!nodeId) return undefined;
    return nodes.find(node => node.id === nodeId)?.source?.file;
  }

  private nodeLine(nodes: CASNode[], nodeId?: string): number | undefined {
    if (!nodeId) return undefined;
    return nodes.find(node => node.id === nodeId)?.source?.line;
  }

  private buildMethodCalls(nodes: CASNode[], edges: CASEdge[]): CASMethodCall[] {
    const methodCalls: CASMethodCall[] = [];
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    const callEdgeTypes = new Set(['calls', 'invokes', 'method_call', 'delegates_to']);
    const seen = new Set<string>();

    for (const edge of edges) {
      if (!callEdgeTypes.has(edge.type)) continue;

      const sourceNode = nodeMap.get(edge.source);
      const targetNode = nodeMap.get(edge.target);

      if (!sourceNode) continue;

      const attrs: Record<string, any> = { ...(edge.metadata || {}), ...(edge.metadata?.attributes || {}) };
      const locations = edge.metadata?.locations || [];
      const firstLocation = locations[0];

      const methodName = targetNode?.name || attrs.method_name || attrs.target_method || attrs.method || 'unknown';
      const file = firstLocation?.file || sourceNode.source?.file || '';
      const line = firstLocation?.line || attrs.line || sourceNode.source?.line || 0;
      const key = `${edge.source}:${edge.target}:${methodName}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const callType = this.normalizeMethodCallType(attrs.call_type, targetNode);
      const resolutionType = this.normalizeMethodCallResolution(attrs.resolution_type, targetNode, edge.target);

      methodCalls.push({
        id: `mc_${edge.id}_${edge.target}`,
        caller_node: edge.source,
        target_node: targetNode ? edge.target : undefined,
        call_details: {
          method_name: methodName,
          signature: targetNode?.signature ? this.formatSignature(targetNode) : undefined,
          location: { file, line, column: 0 },
          call_type: callType,
          resolution_type: resolutionType
        },
        execution_context: {
          is_async: !!sourceNode.metadata?.is_async || !!edge.metadata?.async || !!attrs.is_async,
          is_conditional: !!edge.metadata?.conditional || !!attrs.is_conditional,
          is_in_loop: !!attrs.is_in_loop,
          is_recursive: edge.source === edge.target,
          call_depth: 0,
          conditional_depth: attrs.is_conditional ? 1 : 0,
          loop_depth: attrs.is_in_loop ? 1 : 0,
          enclosing_function: sourceNode.type === 'function' || sourceNode.type === 'method' ? sourceNode.name : undefined,
          enclosing_class: sourceNode.parent ? nodeMap.get(sourceNode.parent)?.name : undefined
        },
        arguments: Array.isArray(attrs.arguments) ? attrs.arguments.map((arg: any, index: number) => ({
          position: index,
          type: arg.type,
          value: arg.value === undefined ? undefined : String(arg.value),
          is_literal: !!arg.is_literal,
          is_variable: !arg.is_literal
        })) : undefined,
        external_details: this.buildMethodCallExternalDetails(attrs, resolutionType, edge.target),
        performance_hints: {
          is_hot_path: !!sourceNode.call_graph?.is_hot_path,
          is_potential_bottleneck: attrs.target_type === 'database' || attrs.target_type === 'api',
          is_critical_path: attrs.target_type === 'database' || attrs.target_type === 'api'
        }
      });
    }

    return methodCalls;
  }

  private normalizeMethodCallType(rawType: unknown, targetNode?: CASNode): CASMethodCall['call_details']['call_type'] {
    if (targetNode?.type === 'constructor') return 'constructor';
    if (typeof rawType !== 'string') return targetNode?.type === 'method' ? 'method' : 'direct';

    const lower = rawType.toLowerCase();
    if (['direct', 'method', 'constructor', 'abstract', 'interface', 'callback', 'hook', 'dynamic'].includes(lower)) {
      return lower as CASMethodCall['call_details']['call_type'];
    }
    if (lower.includes('constructor')) return 'constructor';
    if (lower.includes('abstract')) return 'abstract';
    if (lower.includes('interface')) return 'interface';
    if (lower.includes('callback')) return 'callback';
    if (lower.includes('hook') || lower.includes('event')) return 'hook';
    if (lower.includes('dynamic')) return 'dynamic';
    if (lower.includes('method') || lower.includes('injection') || lower.includes('library')) return 'method';
    return 'direct';
  }

  private normalizeMethodCallResolution(rawType: unknown, targetNode: CASNode | undefined, targetId: string): CASMethodCall['call_details']['resolution_type'] {
    if (targetNode) return 'static';
    if (typeof rawType === 'string') {
      const lower = rawType.toLowerCase();
      if (['dynamic', 'polymorphic', 'external', 'unresolved'].includes(lower)) {
        return lower as CASMethodCall['call_details']['resolution_type'];
      }
    }
    return targetId.startsWith('exit_') ? 'external' : 'unresolved';
  }

  private buildMethodCallExternalDetails(
    attrs: Record<string, any>,
    resolutionType: CASMethodCall['call_details']['resolution_type'],
    targetId: string
  ): CASMethodCall['external_details'] | undefined {
    if (resolutionType !== 'external') return undefined;

    return {
      library: attrs.library || attrs.target_object || attrs.target_type || 'external',
      module: attrs.module || attrs.endpoint,
      is_builtin: !!attrs.is_builtin,
      is_sdk: attrs.target_type === 'sdk' || attrs.call_type === 'library_call',
      exit_point_id: targetId.startsWith('exit_') ? targetId : undefined
    };
  }

  private formatSignature(node: CASNode): string {
    if (!node.signature?.parameters) return node.name;
    const params = node.signature.parameters
      .map(p => `${p.name}${p.type ? ': ' + p.type : ''}`)
      .join(', ');
    const returnType = node.signature?.return_type ? `: ${node.signature.return_type}` : '';
    return `${node.name}(${params})${returnType}`;
  }

  private buildAllDecorators(nodes: CASNode[]): CASDecorator[] {
    const decorators: CASDecorator[] = [];

    for (const node of nodes) {
      const callGraphDecs = node.call_graph?.decorators || [];
      const attrDecs = (node.metadata?.attributes as any)?.decorators || [];

      for (const dec of callGraphDecs) {
        const name = dec.name;
        const category = this.classifyDecoratorCategory(name);

        decorators.push({
          id: `dec_${node.id}_${name}`,
          target_node: node.id,
          decorator_info: {
            name,
            type: this.inferDecoratorTargetType(node),
            framework: this.inferDecoratorFramework(name),
            source_location: {
              file: node.source?.file || '',
              line: node.source?.line || 0,
              column: node.source?.column || 0
            }
          },
          semantic_meaning: {
            category,
            behavior: this.describeDecoratorBehavior(name, category),
            affects_runtime: category !== 'other'
          },
          parameters: dec.arguments ? Object.entries(dec.arguments).map(([pName, value]) => ({
            name: pName,
            value,
            type: typeof value
          })) : undefined,
          routing_info: category === 'routing' ? this.extractRoutingInfo(dec) : undefined,
          security_info: category === 'security' ? this.extractSecurityInfo(dec) : undefined
        });
      }

      for (const dec of attrDecs) {
        const name = typeof dec === 'string' ? dec : dec.name;
        if (!name) continue;

        const alreadyAdded = decorators.some(d => d.id === `dec_${node.id}_${name}`);
        if (alreadyAdded) continue;

        const category = this.classifyDecoratorCategory(name);

        decorators.push({
          id: `dec_${node.id}_${name}`,
          target_node: node.id,
          decorator_info: {
            name,
            type: this.inferDecoratorTargetType(node),
            framework: this.inferDecoratorFramework(name),
            source_location: {
              file: node.source?.file || '',
              line: node.source?.line || 0,
              column: node.source?.column || 0
            }
          },
          semantic_meaning: {
            category,
            behavior: this.describeDecoratorBehavior(name, category),
            affects_runtime: category !== 'other'
          }
        });
      }
    }

    return decorators;
  }

  private classifyDecoratorCategory(name: string): CASDecorator['semantic_meaning']['category'] {
    const lower = name.toLowerCase();
    const routingDecorators = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'controller', 'route', 'requestmapping', 'getmapping', 'postmapping', 'httpget', 'httppost', 'httpput', 'httpdelete'];
    const validationDecorators = ['validate', 'validationpipe', 'isstring', 'isnumber', 'isnotempty', 'body', 'param', 'query'];
    const securityDecorators = ['guard', 'useguards', 'authorize', 'roles', 'authenticated', 'auth', 'allowedtypes'];
    const lifecycleDecorators = ['oninit', 'ondestroy', 'onmoduleinit', 'beforeeach', 'aftereach', 'setup', 'teardown'];
    const injectionDecorators = ['inject', 'injectable', 'service', 'component', 'module', 'autowired'];
    const configDecorators = ['configurable', 'configuration', 'value', 'property'];

    if (routingDecorators.some(d => lower.includes(d))) return 'routing';
    if (validationDecorators.some(d => lower.includes(d))) return 'validation';
    if (securityDecorators.some(d => lower.includes(d))) return 'security';
    if (lifecycleDecorators.some(d => lower.includes(d))) return 'lifecycle';
    if (injectionDecorators.some(d => lower.includes(d))) return 'injection';
    if (configDecorators.some(d => lower.includes(d))) return 'configuration';
    return 'other';
  }

  private inferDecoratorTargetType(node: CASNode): CASDecorator['decorator_info']['type'] {
    if (node.type === 'class') return 'class';
    if (node.type === 'property' || node.type === 'field') return 'property';
    if (node.type === 'parameter') return 'parameter';
    return 'method';
  }

  private inferDecoratorFramework(name: string): string {
    const lower = name.toLowerCase();
    if (['controller', 'injectable', 'module', 'guard', 'pipe', 'interceptor', 'useguards'].some(d => lower.includes(d))) return 'nestjs';
    if (['component', 'directive', 'ngmodule', 'input', 'output'].some(d => lower.includes(d))) return 'angular';
    if (['requestmapping', 'getmapping', 'postmapping', 'autowired', 'service', 'repository'].some(d => lower.includes(d))) return 'spring';
    if (['httpget', 'httppost', 'httpput', 'httpdelete', 'authorize', 'apicontroller'].some(d => lower.includes(d))) return 'aspnet';
    if (['pytest', 'fixture'].some(d => lower.includes(d))) return 'pytest';
    return 'generic';
  }

  private describeDecoratorBehavior(name: string, category: CASDecorator['semantic_meaning']['category']): string {
    switch (category) {
      case 'routing': return `Defines HTTP route handler via @${name}`;
      case 'validation': return `Validates input data via @${name}`;
      case 'security': return `Enforces security policy via @${name}`;
      case 'lifecycle': return `Hooks into lifecycle event via @${name}`;
      case 'injection': return `Manages dependency injection via @${name}`;
      case 'configuration': return `Configures behavior via @${name}`;
      default: return `Applies @${name} decorator`;
    }
  }

  private extractRoutingInfo(dec: { name: string; arguments?: Record<string, any>; provides?: string[] }): CASDecorator['routing_info'] {
    return {
      method: dec.name.toUpperCase(),
      path: dec.arguments?.path || dec.arguments?.value || '/',
      parameters: dec.arguments?.params || []
    };
  }

  private extractSecurityInfo(dec: { name: string; arguments?: Record<string, any>; provides?: string[] }): CASDecorator['security_info'] {
    return {
      authentication_required: true,
      roles: dec.arguments?.roles || dec.provides || [],
      permissions: dec.arguments?.permissions || []
    };
  }

  private enrichNodeCallGraphs(
    nodes: CASNode[],
    callGraphBuilder: CallGraphBuilder,
    entryPoints: CASEntryPoint[],
    exitPoints: CASExitPoint[]
  ): void {
    const entryNodeIds = new Set(entryPoints.map(ep => ep.source_node));
    const exitNodeIds = new Set(exitPoints.map(ep => ep.source_node));
    const nodeMap = new Map(nodes.map(n => [n.id, n]));

    for (const node of nodes) {
      if (node.type === 'file' || node.type === 'directory') continue;

      const callees = callGraphBuilder.getDirectCallees(node.id);
      const callers = callGraphBuilder.getDirectCallers(node.id);

      if (callees.length === 0 && callers.length === 0 && !node.call_graph) continue;

      const existingCallGraph = node.call_graph || {} as CASCallGraph;

      const calls: CASCallGraph['calls'] = callees.map(targetId => {
        const target = nodeMap.get(targetId);
        const targetType: 'function' | 'method' | 'constructor' | 'api' | 'external' =
          exitNodeIds.has(targetId) ? 'external' :
          target?.type === 'constructor' ? 'constructor' :
          target?.type === 'method' ? 'method' : 'function';

        return {
          target_id: targetId,
          target_name: target?.name || targetId,
          target_type: targetType,
          call_type: 'direct' as const,
          location: {
            line: node.source?.line || 0
          }
        };
      });

      const calledBy: CASCallGraph['called_by'] = callers.map(sourceId => {
        const source = nodeMap.get(sourceId);
        return {
          source_id: sourceId,
          source_name: source?.name || sourceId,
          source_type: source?.type || 'unknown',
          location: {
            file: source?.source?.file || '',
            line: source?.source?.line || 0
          }
        };
      });

      node.call_graph = {
        ...existingCallGraph,
        calls: calls.length > 0 ? calls : existingCallGraph.calls,
        called_by: calledBy.length > 0 ? calledBy : existingCallGraph.called_by,
        call_chain_depth: callees.length > 0 ? 1 : 0,
        is_entry_point: entryNodeIds.has(node.id),
        is_exit_point: exitNodeIds.has(node.id),
        total_calls_made: callees.length,
        total_calls_received: callers.length
      };
    }
  }

  private buildSecurityContexts(
    nodes: CASNode[],
    entryPoints: CASEntryPoint[],
    edges: CASEdge[]
  ): CASSecurityContext[] {
    const contexts: CASSecurityContext[] = [];
    const securityKeywords = ['auth', 'guard', 'middleware', 'permission', 'role', 'token', 'jwt', 'session', 'encrypt', 'decrypt', 'hash', 'password', 'credential', 'security', 'validate', 'sanitize'];

    const securityNodes = nodes.filter(n => {
      const nameLower = n.name.toLowerCase();
      return securityKeywords.some(kw => nameLower.includes(kw));
    });

    const authNodes = securityNodes.filter(n => {
      const name = n.name.toLowerCase();
      return name.includes('auth') || name.includes('login') || name.includes('session') || name.includes('token');
    });

    if (authNodes.length > 0) {
      const methods = new Set<string>();
      for (const node of authNodes) {
        const name = node.name.toLowerCase();
        if (name.includes('jwt') || name.includes('token')) methods.add('jwt');
        if (name.includes('session')) methods.add('session');
        if (name.includes('oauth')) methods.add('oauth');
        if (name.includes('basic')) methods.add('basic');
        if (name.includes('api') && name.includes('key')) methods.add('api_key');
      }
      if (methods.size === 0) methods.add('custom');

      contexts.push({
        id: 'security_ctx_authentication',
        name: 'Authentication',
        type: 'authentication',
        scope: {
          node_ids: authNodes.map(n => n.id),
          entry_points: entryPoints
            .filter(ep => ep.metadata?.requires_auth || ep.metadata?.guards?.length)
            .map(ep => ep.id)
        },
        requirements: {
          authentication: {
            required: true,
            methods: Array.from(methods)
          }
        }
      });
    }

    const authzNodes = securityNodes.filter(n => {
      const name = n.name.toLowerCase();
      return name.includes('role') || name.includes('permission') || name.includes('guard') || name.includes('authorize') || name.includes('policy');
    });

    if (authzNodes.length > 0) {
      const roles = new Set<string>();
      const permissions = new Set<string>();
      for (const node of authzNodes) {
        const attrs = node.metadata?.attributes as Record<string, any> | undefined;
        if (attrs?.roles && Array.isArray(attrs.roles)) {
          (attrs.roles as string[]).forEach(r => roles.add(r));
        }
        if (attrs?.permissions && Array.isArray(attrs.permissions)) {
          (attrs.permissions as string[]).forEach(p => permissions.add(p));
        }
      }

      contexts.push({
        id: 'security_ctx_authorization',
        name: 'Authorization',
        type: 'authorization',
        scope: {
          node_ids: authzNodes.map(n => n.id)
        },
        requirements: {
          authorization: {
            roles: Array.from(roles),
            permissions: Array.from(permissions)
          }
        }
      });
    }

    const encryptionNodes = securityNodes.filter(n => {
      const name = n.name.toLowerCase();
      return name.includes('encrypt') || name.includes('decrypt') || name.includes('hash') || name.includes('cipher');
    });

    if (encryptionNodes.length > 0) {
      contexts.push({
        id: 'security_ctx_encryption',
        name: 'Encryption',
        type: 'encryption',
        scope: {
          node_ids: encryptionNodes.map(n => n.id)
        },
        requirements: {
          data_protection: {
            encryption_at_rest: encryptionNodes.some(n => n.name.toLowerCase().includes('storage') || n.name.toLowerCase().includes('persist')),
            encryption_in_transit: encryptionNodes.some(n => n.name.toLowerCase().includes('transport') || n.name.toLowerCase().includes('tls'))
          }
        }
      });
    }

    return contexts;
  }

  private buildAllConfiguration(
    nodes: CASNode[],
    exitPoints: CASExitPoint[],
    externalServices: CASExternalService[],
    projectPath?: string
  ): CASConfiguration {
    const configFilePatterns = ['.env', 'config', 'tsconfig', 'package.json', 'settings', 'appsettings', 'application.properties', 'application.yml', 'docker-compose', 'dockerfile', 'cargo.toml', 'go.mod', 'composer.json', 'pom.xml', 'build.gradle'];
    const envVars: CASConfiguration['environment_variables'] = [];
    const configFiles: CASConfiguration['config_files'] = [];
    const requiredServices: CASConfiguration['required_services'] = [];

    for (const node of nodes) {
      if (node.type !== 'file' && node.type !== 'config') continue;

      const fileName = (node.source?.file || node.name || '').toLowerCase();
      const baseName = path.basename(fileName);

      if (configFilePatterns.some(p => baseName.includes(p))) {
        const format = this.inferConfigFormat(baseName);
        configFiles.push({
          path: node.source?.file || node.name,
          format,
          environment_specific: baseName.includes('dev') || baseName.includes('prod') || baseName.includes('staging') || baseName.includes('test')
        });
      }

      if (baseName.startsWith('.env') || baseName === 'environment.ts' || baseName === 'settings.py') {
        const attrs = node.metadata?.attributes as Record<string, any> | undefined;
        const envMetadata = attrs?.environment_variables;
        if (Array.isArray(envMetadata)) {
          for (const ev of envMetadata) {
            envVars.push({
              name: ev.name || ev,
              required: ev.required,
              description: ev.description,
              sensitive: ev.sensitive || this.isSensitiveEnvVar(ev.name || ev)
            });
          }
        }
      }
    }

    for (const ep of exitPoints) {
      const serviceName = ep.target?.service_id || ep.target?.endpoint || ep.name;
      if (ep.type === 'database') {
        requiredServices.push({
          service: serviceName || 'database',
          optional: false
        });
      } else if (ep.type === 'api' || ep.type === 'sdk' || ep.type === 'webhook') {
        requiredServices.push({
          service: serviceName || ep.name,
          optional: ep.metadata?.optional === true
        });
      } else if (ep.type === 'message') {
        requiredServices.push({
          service: serviceName || 'message_queue',
          optional: false
        });
      }
    }

    for (const svc of externalServices) {
      const existing = requiredServices.find(r => r.service === svc.name);
      if (!existing) {
        requiredServices.push({
          service: svc.name,
          optional: false
        });
      }
    }

    if (projectPath && configFiles.length === 0) {
      const fsConfigPatterns = [
        'package.json', 'tsconfig.json', 'tsconfig.*.json',
        '.env', '.env.example', '.env.local',
        'docker-compose.yml', 'docker-compose.yaml', 'Dockerfile',
        'jest.config.*', 'vitest.config.*', '.eslintrc.*', '.prettierrc*',
        'webpack.config.*', 'vite.config.*', 'next.config.*',
        'settings.py', 'manage.py', 'requirements.txt', 'setup.py', 'pyproject.toml',
        'Cargo.toml', 'go.mod', 'composer.json', 'pom.xml', 'build.gradle',
        'appsettings.json', 'appsettings.*.json', 'launchSettings.json',
        '*.csproj', '*.sln'
      ];

      for (const pattern of fsConfigPatterns) {
        try {
          const matches = require('glob').globSync(pattern, {
            cwd: projectPath,
            ignore: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.git/**', '**/target/**', '**/vendor/**', '**/__pycache__/**']
          });
          for (const match of matches) {
            const baseName = path.basename(match).toLowerCase();
            const alreadyAdded = configFiles.some(cf => cf.path === match);
            if (!alreadyAdded) {
              configFiles.push({
                path: match,
                format: this.inferConfigFormat(baseName),
                environment_specific: baseName.includes('dev') || baseName.includes('prod') || baseName.includes('staging') || baseName.includes('test') || baseName.includes('local')
              });
            }
          }
        } catch {}
      }
    }

    return {
      environment_variables: envVars.length > 0 ? envVars : undefined,
      config_files: configFiles.length > 0 ? configFiles : undefined,
      required_services: requiredServices.length > 0 ? requiredServices : undefined
    };
  }

  private inferConfigFormat(fileName: string): string {
    if (fileName.endsWith('.json')) return 'json';
    if (fileName.endsWith('.yml') || fileName.endsWith('.yaml')) return 'yaml';
    if (fileName.endsWith('.toml')) return 'toml';
    if (fileName.endsWith('.xml')) return 'xml';
    if (fileName.endsWith('.properties')) return 'properties';
    if (fileName.endsWith('.ini')) return 'ini';
    if (fileName.startsWith('.env')) return 'dotenv';
    if (fileName.endsWith('.ts') || fileName.endsWith('.js')) return 'typescript';
    if (fileName.endsWith('.py')) return 'python';
    return 'other';
  }

  private isSensitiveEnvVar(name: string): boolean {
    const sensitive = ['secret', 'password', 'key', 'token', 'credential', 'auth', 'private'];
    const lower = (name || '').toLowerCase();
    return sensitive.some(s => lower.includes(s));
  }

  private deriveParentFromContainsEdges(nodes: CASNode[], edges: CASEdge[]): void {
    const nodeMap = new Map<string, CASNode>();
    for (const node of nodes) {
      nodeMap.set(node.id, node);
    }

    const containsEdges = edges.filter(e => e.type === 'contains');
    for (const edge of containsEdges) {
      const child = nodeMap.get(edge.target);
      if (child && !child.parent) {
        const parent = nodeMap.get(edge.source);
        if (parent) {
          child.parent = edge.source;
        }
      }
    }
  }

  private enrichNodePerspectives(nodes: CASNode[], perspectives: CASPerspective[]): void {
    const trivialTypes = new Set(['import', 'using']);

    if (perspectives.length > 0) {
      for (const perspective of perspectives) {
        const visibleTypes = perspective.connection_rules?.visible_node_types;

        let matchedCount = 0;
        if (visibleTypes && visibleTypes.length > 0) {
          matchedCount = nodes.filter(n => visibleTypes.includes(n.type)).length;
        }

        const useStrictFilter = visibleTypes && visibleTypes.length > 0 && matchedCount > 0;

        for (const node of nodes) {
          if (trivialTypes.has(node.type)) continue;

          if (useStrictFilter && !this.nodeMatchesPerspective(node, visibleTypes!)) {
            continue;
          }

          if (!node.perspectives) {
            node.perspectives = {};
          }

          const hierarchy = this.buildPerspectiveHierarchy(node, perspective);

          node.perspectives[perspective.id] = {
            hierarchy,
            level: node.level || 1,
            priority: this.calculatePerspectivePriority(node, perspective)
          };
        }
      }
    }

    const uncoveredNodes = nodes.filter(n => !trivialTypes.has(n.type) && (!n.perspectives || Object.keys(n.perspectives).length === 0));
    if (uncoveredNodes.length > 0) {
      const fallbackPerspective: CASPerspective = {
        id: 'code-structure',
        name: 'Code Structure',
        type: 'structure',
        description: 'Structural organization of the codebase',
        analyzer_id: 'orchestrator',
        connection_rules: {
          visible_node_types: []
        }
      };

      for (const node of uncoveredNodes) {
        if (!node.perspectives) {
          node.perspectives = {};
        }
        node.perspectives[fallbackPerspective.id] = {
          hierarchy: ['structure', node.category || node.type, node.name],
          level: node.level || 1,
          priority: this.calculatePerspectivePriority(node, fallbackPerspective)
        };
      }
    }
  }

  private nodeMatchesPerspective(node: CASNode, visibleTypes: string[]): boolean {
    if (visibleTypes.includes(node.type)) return true;

    for (const vt of visibleTypes) {
      const suffix = vt.replace(/^[a-z]+_/, '');
      if (suffix === node.type) return true;
      if (node.category === suffix) return true;
      if (node.subcategories?.includes(suffix)) return true;
      if (node.subcategories?.includes(vt)) return true;
    }

    return false;
  }

  private buildPerspectiveHierarchy(node: CASNode, perspective: CASPerspective): string[] {
    const hierarchy: string[] = [];

    if (perspective.type === 'flow') {
      hierarchy.push('flow');
      if (node.category) hierarchy.push(node.category);
      hierarchy.push(node.type);
    } else if (perspective.type === 'structure') {
      hierarchy.push('structure');
      if (node.category) hierarchy.push(node.category);
      if (node.subcategories?.[0]) hierarchy.push(node.subcategories[0]);
    } else if (perspective.type === 'security') {
      hierarchy.push('security');
      hierarchy.push(node.type);
    } else {
      hierarchy.push(perspective.type);
      if (node.category) hierarchy.push(node.category);
    }

    hierarchy.push(node.name);
    return hierarchy;
  }

  private calculatePerspectivePriority(node: CASNode, perspective: CASPerspective): number {
    let priority = 50;

    if (node.metadata?.is_exported) priority += 20;
    if (node.type === 'class' || node.type === 'module') priority += 10;
    if (node.type === 'function' || node.type === 'method') priority += 5;

    if (perspective.type === 'flow' && (node.type === 'controller' || node.type === 'route' || node.type === 'endpoint')) {
      priority += 30;
    }
    if (perspective.type === 'data' && (node.type === 'entity' || node.type === 'model' || node.type === 'schema')) {
      priority += 30;
    }

    return Math.min(100, priority);
  }

  private detectLibrariesFromManifests(projectPath: string): CASLibrary[] {
    const libraries: CASLibrary[] = [];
    const seen = new Set<string>();

    const packageJsonPath = path.join(projectPath, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        const addDeps = (deps: Record<string, string> | undefined, type: CASLibrary['type']) => {
          if (!deps) return;
          for (const [name, version] of Object.entries(deps)) {
            const key = `${name}@${type}`;
            if (seen.has(key)) continue;
            seen.add(key);
            libraries.push({
              id: `lib_${name.replace(/[^a-zA-Z0-9]/g, '_')}`,
              name,
              version: version.replace(/^[\^~>=<]/, ''),
              type,
              package_manager: 'npm'
            });
          }
        };
        addDeps(pkg.dependencies, 'production');
        addDeps(pkg.devDependencies, 'development');
        addDeps(pkg.peerDependencies, 'peer');
        addDeps(pkg.optionalDependencies, 'optional');
      } catch { }
    }

    const requirementsFiles = ['requirements.txt', 'requirements/base.txt', 'requirements/production.txt'];
    for (const reqFile of requirementsFiles) {
      const reqPath = path.join(projectPath, reqFile);
      if (fs.existsSync(reqPath)) {
        try {
          const rawContent = fs.readFileSync(reqPath);
          const content = rawContent.toString('utf8').replace(/\0/g, '').replace(/\uFEFF/g, '');
          for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
            const match = trimmed.match(/^([a-zA-Z0-9_.-]+)\s*(?:[><=!~]+\s*(.+))?/);
            if (match) {
              const name = match[1];
              const version = match[2]?.split(',')[0]?.trim();
              const key = `py_${name}`;
              if (seen.has(key)) continue;
              seen.add(key);
              libraries.push({
                id: `lib_${name.replace(/[^a-zA-Z0-9]/g, '_')}`,
                name,
                version,
                type: 'production',
                package_manager: 'pip'
              });
            }
          }
        } catch { }
      }
    }

    const pipfilePath = path.join(projectPath, 'Pipfile');
    if (fs.existsSync(pipfilePath) && libraries.filter(l => l.package_manager === 'pip').length === 0) {
      try {
        const content = fs.readFileSync(pipfilePath, 'utf8');
        let section = '';
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.startsWith('[')) {
            section = trimmed.replace(/[\[\]]/g, '').toLowerCase();
            continue;
          }
          if (section === 'packages' || section === 'dev-packages') {
            const match = trimmed.match(/^([a-zA-Z0-9_.-]+)\s*=/);
            if (match) {
              const name = match[1];
              const key = `py_${name}`;
              if (seen.has(key)) continue;
              seen.add(key);
              libraries.push({
                id: `lib_${name.replace(/[^a-zA-Z0-9]/g, '_')}`,
                name,
                type: section === 'dev-packages' ? 'development' : 'production',
                package_manager: 'pipenv'
              });
            }
          }
        }
      } catch { }
    }

    const cargoPath = path.join(projectPath, 'Cargo.toml');
    if (fs.existsSync(cargoPath)) {
      try {
        const content = fs.readFileSync(cargoPath, 'utf8');
        let section = '';
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.startsWith('[')) {
            section = trimmed.replace(/[\[\]]/g, '').toLowerCase();
            continue;
          }
          if (section === 'dependencies' || section === 'dev-dependencies') {
            const match = trimmed.match(/^([a-zA-Z0-9_-]+)\s*=/);
            if (match) {
              const name = match[1];
              const key = `cargo_${name}`;
              if (seen.has(key)) continue;
              seen.add(key);
              const versionMatch = trimmed.match(/"([^"]+)"/);
              libraries.push({
                id: `lib_${name.replace(/[^a-zA-Z0-9]/g, '_')}`,
                name,
                version: versionMatch?.[1],
                type: section === 'dev-dependencies' ? 'development' : 'production',
                package_manager: 'cargo'
              });
            }
          }
        }
      } catch { }
    }

    const pyprojectPath = path.join(projectPath, 'pyproject.toml');
    if (fs.existsSync(pyprojectPath) && libraries.filter(l => l.package_manager === 'pip' || l.package_manager === 'pipenv').length === 0) {
      try {
        const content = fs.readFileSync(pyprojectPath, 'utf8');
        let inDeps = false;
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.match(/^\[.*dependencies.*\]/i)) {
            inDeps = true;
            continue;
          }
          if (trimmed.startsWith('[') && inDeps) {
            inDeps = false;
            continue;
          }
          if (inDeps) {
            const match = trimmed.match(/^"?([a-zA-Z0-9_.-]+)"?\s*(?:[><=!~]+\s*"?([^",\]]+))?/);
            if (match && !match[1].startsWith('#')) {
              const name = match[1];
              const key = `py_${name}`;
              if (seen.has(key)) continue;
              seen.add(key);
              libraries.push({
                id: `lib_${name.replace(/[^a-zA-Z0-9]/g, '_')}`,
                name,
                version: match[2]?.replace(/"/g, ''),
                type: 'production',
                package_manager: 'pip'
              });
            }
          }
        }
      } catch { }
    }

    if (libraries.length === 0) {
      const manifestNames = ['package.json', 'requirements.txt', 'Cargo.toml', 'Pipfile', 'pyproject.toml', 'go.mod', 'Gemfile'];
      try {
        const entries = fs.readdirSync(projectPath, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'build' || entry.name === '__pycache__') continue;
          const subPath = path.join(projectPath, entry.name);
          for (const manifest of manifestNames) {
            const manifestPath = path.join(subPath, manifest);
            if (!fs.existsSync(manifestPath)) continue;
            if (manifest === 'package.json') {
              try {
                const pkg = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                const addDeps = (deps: Record<string, string> | undefined, type: CASLibrary['type']) => {
                  if (!deps) return;
                  for (const [name, version] of Object.entries(deps)) {
                    const key = `${name}@${type}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    libraries.push({
                      id: `lib_${name.replace(/[^a-zA-Z0-9]/g, '_')}`,
                      name,
                      version: version.replace(/^[\^~>=<]/, ''),
                      type,
                      package_manager: 'npm'
                    });
                  }
                };
                addDeps(pkg.dependencies, 'production');
                addDeps(pkg.devDependencies, 'development');
              } catch { }
            } else if (manifest === 'requirements.txt') {
              try {
                const content = fs.readFileSync(manifestPath, 'utf8');
                for (const line of content.split('\n')) {
                  const trimmed = line.trim();
                  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
                  const match = trimmed.match(/^([a-zA-Z0-9_.-]+)\s*(?:[><=!~]+\s*(.+))?/);
                  if (match) {
                    const name = match[1];
                    const key = `py_${name}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    libraries.push({
                      id: `lib_${name.replace(/[^a-zA-Z0-9]/g, '_')}`,
                      name,
                      version: match[2]?.split(',')[0]?.trim(),
                      type: 'production',
                      package_manager: 'pip'
                    });
                  }
                }
              } catch { }
            } else if (manifest === 'Cargo.toml') {
              try {
                const content = fs.readFileSync(manifestPath, 'utf8');
                let section = '';
                for (const line of content.split('\n')) {
                  const trimmed = line.trim();
                  if (trimmed.startsWith('[')) {
                    section = trimmed.replace(/[\[\]]/g, '').toLowerCase();
                    continue;
                  }
                  if (section === 'dependencies' || section === 'dev-dependencies') {
                    const match = trimmed.match(/^([a-zA-Z0-9_-]+)\s*=/);
                    if (match) {
                      const name = match[1];
                      const key = `cargo_${name}`;
                      if (seen.has(key)) continue;
                      seen.add(key);
                      const versionMatch = trimmed.match(/"([^"]+)"/);
                      libraries.push({
                        id: `lib_${name.replace(/[^a-zA-Z0-9]/g, '_')}`,
                        name,
                        version: versionMatch?.[1],
                        type: section === 'dev-dependencies' ? 'development' : 'production',
                        package_manager: 'cargo'
                      });
                    }
                  }
                }
              } catch { }
            }
            if (libraries.length > 0) break;
          }
          if (libraries.length > 0) break;
        }
      } catch { }
    }

    return libraries;
  }
}
