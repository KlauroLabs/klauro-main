import * as path from 'node:path';
import type { CASAnalyzerContribution, CASOutput } from '../../types/cas.types';
import { invalidateIncrementalSourceInputs } from './analyzer-contribution-summary';
import { compactCasSourceInputIdentities, sourceInputIdentityAt } from './cas-source-input-identities';

type SourceInputAnalyzerRegistration = {
  id: string;
  analyzer: {
    incrementalContributionScope(): 'file' | 'project';
    supportsIncrementalAnalysis(): boolean;
    analyzeFileSingle?: unknown;
    getRelevantFiles?: (projectPath: string) => Promise<string[]>;
  };
};

export class IncrementalSourceInputRefresh {
  readonly affectedAnalyzerIds = new Set<string>();
  private readonly refreshed = new Map<string, CASAnalyzerContribution>();
  private readonly relevantFiles = new Map<string, Set<string>>();
  private readonly unresolvedFileEligibility = new Set<string>();

  constructor(private readonly projectPath: string, previous: CASOutput, changedFiles: readonly string[]) {
    const changed = new Set(changedFiles.map(file => path.resolve(projectPath, file)));
    const previousRoot = previous.system.root_path || projectPath;
    const root = previous.source_input_root || previousRoot;
    const changedIdentity = (file: string) => changed.has(path.resolve(projectPath, path.relative(previousRoot, path.resolve(root, file))));
    for (const contribution of previous.analyzer_contributions) {
      const inputs = contribution.source_inputs;
      if (!inputs || changed.size === 0) continue;
      const identities = inputs.version === 1 && Array.isArray(inputs.files)
        ? inputs.files
        : inputs.version === 2 && Array.isArray(inputs.identity_indices)
          ? inputs.identity_indices.map(index => sourceInputIdentityAt(previous.source_input_identities, index))
          : undefined;
      if (inputs.coverage !== 'observed-reads' || !identities || identities.some(identity => !identity || typeof identity.path !== 'string' || changedIdentity(identity.path))) {
        this.affectedAnalyzerIds.add(contribution.analyzer_id);
      }
    }
  }

  async resolveFileEligibility(
    registrations: readonly SourceInputAnalyzerRegistration[],
    analyzerRoots: ReadonlyMap<string, string> = new Map(),
  ): Promise<this> {
    for (const { id, analyzer } of registrations) {
      if (!this.affectedAnalyzerIds.has(id) || !analyzer.supportsIncrementalAnalysis() || typeof analyzer.analyzeFileSingle !== 'function') continue;
      if (!analyzer.getRelevantFiles) {
        this.unresolvedFileEligibility.add(id);
        continue;
      }
      const root = analyzerRoots.get(id) || this.projectPath;
      const files = await analyzer.getRelevantFiles(root);
      this.relevantFiles.set(id, new Set(files.map(file => path.resolve(root, file))));
    }
    return this;
  }

  matchingAnalyzerIds(file: string): string[] {
    const absolute = path.resolve(this.projectPath, file);
    return [...this.affectedAnalyzerIds].filter(id =>
      !this.unresolvedFileEligibility.has(id) && (!this.relevantFiles.has(id) || this.relevantFiles.get(id)!.has(absolute))
    );
  }

  projectAnalyzerIds(registrations: readonly SourceInputAnalyzerRegistration[]): Set<string> {
    const fileScoped = new Set(registrations.filter(({ id, analyzer }) =>
      analyzer.incrementalContributionScope() === 'file' && !this.unresolvedFileEligibility.has(id) &&
      analyzer.supportsIncrementalAnalysis() && typeof analyzer.analyzeFileSingle === 'function'
    ).map(registration => registration.id));
    return new Set([...this.affectedAnalyzerIds].filter(id => !fileScoped.has(id)));
  }

  record(contribution: CASAnalyzerContribution): void {
    this.refreshed.set(contribution.analyzer_id, contribution);
  }

  apply(output: CASOutput): CASOutput {
    const previous = invalidateIncrementalSourceInputs(output.analyzer_contributions);
    const existingIds = new Set(previous.map(contribution => contribution.analyzer_id));
    const updated: CASOutput = {
      ...output,
      analyzer_contributions: [
        ...previous.map(contribution => this.refreshed.get(contribution.analyzer_id) || contribution),
        ...[...this.refreshed.values()].filter(contribution => !existingIds.has(contribution.analyzer_id)),
      ],
      source_input_identities: undefined,
      source_input_catalog: undefined,
      source_input_root: this.projectPath,
    };
    compactCasSourceInputIdentities(updated);
    return updated;
  }
}
