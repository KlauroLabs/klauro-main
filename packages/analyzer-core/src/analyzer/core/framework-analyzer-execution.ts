import type { CASContribution } from '../../types/cas.types';

export interface FrameworkExecutionRegistration {
  id: string;
  name: string;
}

export interface FrameworkExecutionEvent<Registration> {
  registration: Registration;
  stage: 'before-analysis' | 'before-merge' | 'after-merge';
}

interface FrameworkExecutionOptions<Registration extends FrameworkExecutionRegistration> {
  registrations: readonly Registration[];
  runAnalyzer: (registration: Registration) => Promise<CASContribution>;
  mergeResult: (
    registration: Registration,
    result: CASContribution,
    executionTime: number,
  ) => Promise<void>;
  recordFailure: (registration: Registration, error: unknown) => void;
  onExecutionEvent?: (event: FrameworkExecutionEvent<Registration>) => void;
  yieldAfterAnalyzer: () => Promise<void>;
}

export async function executeFrameworkAnalyzers<Registration extends FrameworkExecutionRegistration>(
  options: FrameworkExecutionOptions<Registration>,
): Promise<void> {
  const registrations = [...options.registrations].sort((left, right) => left.id.localeCompare(right.id));
  for (const registration of registrations) {
    options.onExecutionEvent?.({ registration, stage: 'before-analysis' });
    const startedAt = Date.now();
    let result: CASContribution;
    try {
      result = await options.runAnalyzer(registration);
    } catch (error) {
      options.recordFailure(registration, error);
      await options.yieldAfterAnalyzer();
      continue;
    }

    const executionTime = Date.now() - startedAt;
    options.onExecutionEvent?.({ registration, stage: 'before-merge' });
    await options.mergeResult(registration, result, executionTime);
    options.onExecutionEvent?.({ registration, stage: 'after-merge' });
    await options.yieldAfterAnalyzer();
  }
}
