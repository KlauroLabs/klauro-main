import type { RealRepoTarget } from './repo-discovery';

export function selectIdiomProofTargets(
  eligible: RealRepoTarget[],
  repoResults: any[],
  targetCount: number
): RealRepoTarget[] {
  const passingPaths = new Set(repoResults.filter(result =>
    result.proof_status === 'pass' &&
    result.readiness?.agent_context_ready === true &&
    Number(result.cas?.codebase_idioms || 0) > 0
  ).map(result => result.path));
  const idiomCounts = new Map(repoResults.map(result => [result.path, Number(result.cas?.codebase_idioms || 0)]));
  const passing = eligible.filter(repo => passingPaths.has(repo.path));
  return selectDiverseRepositories(
    passing.length > 0 ? passing : eligible,
    targetCount,
    repo => idiomCounts.get(repo.path) || 0
  );
}

export function selectGreenfieldReferencePaths(eligible: RealRepoTarget[], repoResults: any[]): string[] {
  const passing = new Set(repoResults
    .filter(result => result.proof_status === 'pass')
    .map(result => result.path));
  return selectDiverseRepositories(eligible.filter(repo => passing.has(repo.path)), 6).map(repo => repo.path);
}

function selectDiverseRepositories(
  repos: RealRepoTarget[],
  targetCount: number,
  evidenceScore: (repo: RealRepoTarget) => number = () => 0
): RealRepoTarget[] {
  const remaining = [...repos];
  const selected: RealRepoTarget[] = [];
  const coveredLanguages = new Set<string>();

  while (selected.length < targetCount && remaining.length > 0) {
    remaining.sort((left, right) => {
      const leftNovel = left.languages.filter(language => !coveredLanguages.has(language)).length;
      const rightNovel = right.languages.filter(language => !coveredLanguages.has(language)).length;
      return rightNovel - leftNovel
        || evidenceScore(right) - evidenceScore(left)
        || right.source_files - left.source_files
        || left.path.localeCompare(right.path);
    });
    const next = remaining.shift()!;
    selected.push(next);
    next.languages.forEach(language => coveredLanguages.add(language));
  }

  return selected;
}
