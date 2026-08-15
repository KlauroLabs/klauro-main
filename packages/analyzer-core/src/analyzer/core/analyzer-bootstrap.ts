



export async function bootstrapAnalyzers(): Promise<void> {
  console.log('bootstrapAnalyzers() is deprecated - use CAS analyzer service instead');
}

export async function getAnalyzerForProject(projectPath: string): Promise<any> {
  console.log('getAnalyzerForProject() is deprecated - use CAS analyzer service instead');
  return null;
}

export function getAnalyzerStatistics(): any {
  console.log('getAnalyzerStatistics() is deprecated - use CAS analyzer service instead');
  return { totalPlugins: 0 };
}

export async function loadCommunityAnalyzers(): Promise<void> {
  console.log('loadCommunityAnalyzers() is deprecated - use CAS analyzer service instead');
}

export async function initializeAnalyzerSystem(): Promise<void> {
  console.log('initializeAnalyzerSystem() is deprecated - use CAS analyzer service instead');
}
