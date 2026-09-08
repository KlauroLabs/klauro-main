import * as path from 'node:path';
import type { CASAnalyzerContribution, CASAnalyzerSourceInputs, CASOutput, CASSourceInputIdentity } from '../../types/cas.types';
import { invalidateIncrementalSourceInputs } from './analyzer-contribution-summary';
import { compactCasSourceInputIdentities, sourceInputIdentityAt } from './cas-source-input-identities';
import { AnalyzerSourceInputCapture } from './analyzer-source-inputs';
import { withAnalyzerFileReadTracking } from './analyzer-file-read-cache';

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
  private readonly retainedInputs = new Map<string, CASAnalyzerSourceInputs>();
  private readonly retainedPaths = new Map<string, Set<string>>();
  private readonly requiredInputs = new Map<string, Set<string>>();
  private readonly captures = new Map<string, AnalyzerSourceInputCapture>();
  private readonly unknownInputs = new Set<string>();
  private readonly changed: Set<string>;
  private readonly inputRoot: string;
  private fileAnalysisComplete = false;

  constructor(private readonly projectPath: string, previous: CASOutput, changedFiles: readonly string[]) {
    this.changed = new Set(changedFiles.map(file => path.resolve(projectPath, file)));
    const previousRoot = previous.system.root_path || projectPath;
    this.inputRoot = path.resolve(projectPath, path.relative(previousRoot, previous.source_input_root || previousRoot));
    for (const contribution of previous.analyzer_contributions) {
      const id = contribution.analyzer_id;
      const inputs = contribution.source_inputs;
      const identities = inputs?.version === 1 && Array.isArray(inputs.files)
        ? inputs.files
        : inputs?.version === 2 && Array.isArray(inputs.identity_indices)
          ? inputs.identity_indices.map(index => sourceInputIdentityAt(previous.source_input_identities, index))
          : undefined;
      if (!inputs || inputs.coverage !== 'observed-reads' || !identities ||
        identities.some(identity => !identity || typeof identity.path !== 'string')) {
        this.unknownInputs.add(id);
        if (this.changed.size > 0) this.affectedAnalyzerIds.add(id);
        continue;
      }
      const files = identities as CASSourceInputIdentity[];
      this.retainedInputs.set(id, { version: 1, coverage: inputs.coverage, reason: inputs.reason,
        digest_algorithm: inputs.digest_algorithm, outside_root_reads: inputs.outside_root_reads, files });
      const paths = new Set(files.map(file => path.resolve(this.inputRoot, file.path)));
      this.retainedPaths.set(id, paths);
      const required = new Set([...paths].filter(file => this.changed.has(file)));
      this.requiredInputs.set(id, required);
      if (required.size > 0 || (inputs.outside_root_reads > 0 && this.changed.size > 0)) this.affectedAnalyzerIds.add(id);
      if (inputs.outside_root_reads > 0 && this.changed.size > 0) this.unknownInputs.add(id);
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
      const files = new Set((await analyzer.getRelevantFiles(root)).map(file => path.resolve(root, file)));
      this.relevantFiles.set(id, files);
      if ([...this.requiredInputs.get(id) || []].some(file => !files.has(file))) this.unresolvedFileEligibility.add(id);
    }
    return this;
  }

  matchingAnalyzerIds(file: string): string[] {
    const absolute = path.resolve(this.projectPath, file);
    return [...this.affectedAnalyzerIds].filter(id =>
      this.relevantFiles.has(id) && this.relevantFiles.get(id)!.has(absolute)
    );
  }

  projectAnalyzerIds(registrations: readonly SourceInputAnalyzerRegistration[]): Set<string> {
    const fileScoped = new Set(registrations.filter(({ id, analyzer }) =>
      analyzer.incrementalContributionScope() === 'file' && !this.unresolvedFileEligibility.has(id) &&
      !this.unknownInputs.has(id) && (!this.fileAnalysisComplete || this.unobservedInputs(id).length === 0) &&
      analyzer.supportsIncrementalAnalysis() && typeof analyzer.analyzeFileSingle === 'function'
    ).map(registration => registration.id));
    return new Set([...this.affectedAnalyzerIds].filter(id => !fileScoped.has(id)));
  }

  async analyzeFile<T>(
    id: string, file: string, analyze: () => Promise<T>,
    cache?: { key: string | null; load?: (key: string) => Promise<T | null>; save?: (key: string, result: T) => Promise<void> },
  ): Promise<T> {
    const absolute = path.resolve(this.projectPath, file);
    const retained = this.retainedInputs.get(id);
    if (!retained) this.unknownInputs.add(id);
    if (this.changed.has(absolute) || !this.retainedPaths.get(id)?.has(absolute)) {
      const required = this.requiredInputs.get(id) || new Set<string>();
      required.add(absolute);
      this.requiredInputs.set(id, required);
      this.affectedAnalyzerIds.add(id);
    }
    const cached = cache?.key && cache.load ? await cache.load(cache.key) : null;
    if (cached) return cached;
    const tracked = await withAnalyzerFileReadTracking(analyze);
    const capture = this.captures.get(id) || new AnalyzerSourceInputCapture();
    capture.merge(tracked.sourceInputs);
    this.captures.set(id, capture);
    if (cache?.key && cache.save && tracked.result) await cache.save(cache.key, tracked.result);
    return tracked.result;
  }

  finalizeFileAnalysis(registrations: readonly SourceInputAnalyzerRegistration[], selected: Set<string>): void {
    this.fileAnalysisComplete = true;
    for (const id of this.projectAnalyzerIds(registrations)) selected.add(id);
  }

  private unobservedInputs(id: string): string[] {
    const files = this.captures.get(id)?.snapshot(this.inputRoot).files || [];
    const observed = new Set(files.filter(file => file.status === 'captured').map(file => path.resolve(this.inputRoot, file.path)));
    return [...this.requiredInputs.get(id) || []].filter(file => !observed.has(file));
  }

  record(contribution: CASAnalyzerContribution): void {
    const inputs = contribution.source_inputs;
    this.refreshed.set(contribution.analyzer_id, inputs?.version === 1 ? {
      ...contribution, source_inputs: {
        ...inputs, files: inputs.files.map(file => ({
          ...file, path: path.relative(this.inputRoot, path.resolve(this.projectPath, file.path)).replace(/\\/g, '/'),
        })),
      },
    } : contribution);
  }

  private retainedContribution(contribution: CASAnalyzerContribution): CASAnalyzerContribution {
    const id = contribution.analyzer_id;
    const inputs = this.retainedInputs.get(id);
    if (!inputs || this.unknownInputs.has(id) || this.unobservedInputs(id).length > 0) {
      return invalidateIncrementalSourceInputs([contribution])[0];
    }
    const fresh = this.captures.get(id)?.snapshot(this.inputRoot);
    const files = new Map(inputs.files.map(file => [file.path, file]));
    for (const file of fresh?.files || []) files.set(file.path, file);
    return {
      ...contribution, source_inputs: {
        ...inputs, files: [...files.values()].sort((left, right) => left.path.localeCompare(right.path)),
        outside_root_reads: inputs.outside_root_reads + (fresh?.outside_root_reads || 0),
      },
    };
  }

  apply(output: CASOutput): CASOutput {
    const existingIds = new Set(output.analyzer_contributions.map(contribution => contribution.analyzer_id));
    const updated: CASOutput = {
      ...output,
      analyzer_contributions: [
        ...output.analyzer_contributions.map(contribution => this.refreshed.get(contribution.analyzer_id) || this.retainedContribution(contribution)),
        ...[...this.refreshed.values()].filter(contribution => !existingIds.has(contribution.analyzer_id)),
      ],
      source_input_identities: undefined,
      source_input_catalog: undefined,
      source_input_root: this.inputRoot,
    };
    compactCasSourceInputIdentities(updated);
    return updated;
  }
}
