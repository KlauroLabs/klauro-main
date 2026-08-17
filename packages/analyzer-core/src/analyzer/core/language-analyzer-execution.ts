import { CASAnalysisError, CASBehavior, CASCategories, CASContribution, CASEdge, CASNode, CASPattern, CASPerspective, CASTag } from '../../types/cas.types';

export interface LanguageExecutionRegistration {
  id: string;
  name: string;
  consumesExistingAnalysis?: boolean;
}

export interface AnalysisAccumulators<MergeIndexes = unknown> {
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
  analysisErrors: CASAnalysisError[];
  mergeIndexes: MergeIndexes;
}

interface LanguageExecutionOptions<Registration extends LanguageExecutionRegistration, Context, MergeIndexes> {
  registrations: Registration[];
  context: Context;
  projectPath: string;
  accumulators: AnalysisAccumulators<MergeIndexes>;
  createMergeIndexes: (target: {
    allNodes: CASNode[];
    allEdges: CASEdge[];
    allEntryPoints: any[];
    allExitPoints: any[];
  }) => MergeIndexes;
  runAnalyzer: (
    registration: Registration,
    context: Context,
    projectPath: string,
    accumulators: AnalysisAccumulators<MergeIndexes>
  ) => Promise<void>;
  mergeContribution: (
    target: {
      allNodes: CASNode[];
      allEdges: CASEdge[];
      allEntryPoints: any[];
      allExitPoints: any[];
    },
    contribution: CASContribution,
    analyzerId: string,
    analysisErrors: CASAnalysisError[],
    mergeIndexes: MergeIndexes
  ) => Promise<void>;
  mergeCategories: (target: CASCategories, source: CASCategories) => void;
  logTiming: (phase: string, startedAt: number) => void;
  yieldAfterAnalyzer: () => Promise<void>;
}

function createEmptyAccumulators<MergeIndexes>(
  createMergeIndexes: LanguageExecutionOptions<any, any, MergeIndexes>['createMergeIndexes']
): AnalysisAccumulators<MergeIndexes> {
  const allNodes: CASNode[] = [];
  const allEdges: CASEdge[] = [];
  const allEntryPoints: any[] = [];
  const allExitPoints: any[] = [];
  return {
    allNodes,
    allEdges,
    allEntryPoints,
    allExitPoints,
    allBehaviors: [],
    allPatterns: [],
    allTags: [],
    allPerspectives: [],
    allLibraries: [],
    categories: {},
    contributions: [],
    analysisErrors: [],
    mergeIndexes: createMergeIndexes({ allNodes, allEdges, allEntryPoints, allExitPoints }),
  };
}

function recordFailure(
  registration: LanguageExecutionRegistration,
  error: unknown,
  analysisErrors: CASAnalysisError[]
): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error running analyzer ${registration.id}:`, error);
  analysisErrors.push({
    severity: 'error',
    code: 'ANALYZER_FAILURE',
    message: `${registration.name} failed: ${message}`,
    analyzer: registration.id,
    recoverable: true,
  });
}

async function mergeIsolated<Registration extends LanguageExecutionRegistration, Context, MergeIndexes>(
  options: LanguageExecutionOptions<Registration, Context, MergeIndexes>,
  registration: Registration,
  isolated: AnalysisAccumulators<MergeIndexes>
): Promise<void> {
  const target = options.accumulators;
  await options.mergeContribution(
    target,
    {
      nodes: isolated.allNodes,
      edges: isolated.allEdges,
      entry_points: isolated.allEntryPoints,
      exit_points: isolated.allExitPoints,
      analyzer_metadata: {
        analyzer_id: registration.id,
        analyzer_name: registration.name,
        contribution_type: 'language',
      },
    },
    registration.id,
    target.analysisErrors,
    target.mergeIndexes
  );
  target.allBehaviors.push(...isolated.allBehaviors);
  target.allPatterns.push(...isolated.allPatterns);
  target.allTags.push(...isolated.allTags);
  target.allPerspectives.push(...isolated.allPerspectives);
  target.allLibraries.push(...isolated.allLibraries);
  target.contributions.push(...isolated.contributions);
  target.analysisErrors.push(...isolated.analysisErrors);
  options.mergeCategories(target.categories, isolated.categories);
}

export async function executeLanguageAnalyzers<Registration extends LanguageExecutionRegistration, Context, MergeIndexes>(
  options: LanguageExecutionOptions<Registration, Context, MergeIndexes>
): Promise<void> {
  for (let index = 0; index < options.registrations.length;) {
    const registration = options.registrations[index];
    if (registration.consumesExistingAnalysis !== false) {
      try {
        const startedAt = Date.now();
        await options.runAnalyzer(registration, options.context, options.projectPath, options.accumulators);
        options.logTiming(`language_${registration.id}`, startedAt);
        await options.yieldAfterAnalyzer();
      } catch (error) {
        recordFailure(registration, error, options.accumulators.analysisErrors);
      }
      index++;
      continue;
    }

    const batch: Registration[] = [];
    while (
      index < options.registrations.length &&
      options.registrations[index].consumesExistingAnalysis === false
    ) {
      batch.push(options.registrations[index]);
      index++;
    }
    const settled = await Promise.allSettled(batch.map(async isolatedRegistration => {
      const isolated = createEmptyAccumulators(options.createMergeIndexes);
      const startedAt = Date.now();
      await options.runAnalyzer(
        isolatedRegistration,
        { ...options.context },
        options.projectPath,
        isolated
      );
      options.logTiming(`language_${isolatedRegistration.id}`, startedAt);
      return isolated;
    }));

    for (let batchIndex = 0; batchIndex < settled.length; batchIndex++) {
      const result = settled[batchIndex];
      const isolatedRegistration = batch[batchIndex];
      if (result.status === 'rejected') {
        recordFailure(isolatedRegistration, result.reason, options.accumulators.analysisErrors);
      } else {
        await mergeIsolated(options, isolatedRegistration, result.value);
      }
      await options.yieldAfterAnalyzer();
    }
  }
}
