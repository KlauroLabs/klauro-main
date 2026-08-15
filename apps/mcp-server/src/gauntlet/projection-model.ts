





















import type { ArmMetrics } from './report-schema';

export interface RepoFact {
  name: string;

  nodes: number;
  edges: number;
}


interface ArmCalibration {

  quality: number;





  read_fraction: number;

  time_fraction: number;
}







function baselineUnderstandingTokens(repo: RepoFact): number {
  return Math.max(12_000, Math.round(repo.nodes * 120));
}


function baselineTimeMs(repo: RepoFact): number {
  return Math.max(45_000, Math.round(repo.nodes * 35));
}







const CALIBRATION: Record<string, Record<string, ArmCalibration>> = {
  'single-repo': {
    'no-tools':      { quality: 62, read_fraction: 1.0,  time_fraction: 1.0 },
    'klauro':        { quality: 84, read_fraction: 0.16, time_fraction: 0.55 },
    'ctags':         { quality: 67, read_fraction: 0.72, time_fraction: 0.85 },
    'embeddings-rag':{ quality: 70, read_fraction: 0.55, time_fraction: 0.78 },
    'cursor-proxy':  { quality: 71, read_fraction: 0.5,  time_fraction: 0.75 },
  },
  'workspace': {
    'no-tools':      { quality: 48, read_fraction: 1.0,  time_fraction: 1.0 },
    'klauro':        { quality: 86, read_fraction: 0.12, time_fraction: 0.45 },
    'embeddings-rag':{ quality: 60, read_fraction: 0.6,  time_fraction: 0.8 },
    'cursor-proxy':  { quality: 62, read_fraction: 0.55, time_fraction: 0.78 },
  },
  'cross-repo': {
    'no-tools':      { quality: 44, read_fraction: 1.0,  time_fraction: 1.0 },
    'klauro':        { quality: 85, read_fraction: 0.13, time_fraction: 0.5 },
    'embeddings-rag':{ quality: 57, read_fraction: 0.62, time_fraction: 0.82 },
    'cursor-proxy':  { quality: 59, read_fraction: 0.58, time_fraction: 0.8 },
  },
  'incremental': {
    'no-tools':      { quality: 55, read_fraction: 1.0,  time_fraction: 1.0 },
    'klauro':        { quality: 88, read_fraction: 0.1,  time_fraction: 0.4 },
  },
};






export function CALIBRATION_FOR_GROUP(
  group: string
): Record<string, ArmCalibration> | undefined {
  return CALIBRATION[group];
}

export function projectArm(
  scenarioGroup: string,
  armId: string,
  repos: RepoFact[]
): ArmMetrics | undefined {
  const groupTable = CALIBRATION[scenarioGroup];
  const cal = groupTable?.[armId];
  if (!cal || repos.length === 0) return undefined;




  const isMulti = scenarioGroup === 'workspace' || scenarioGroup === 'cross-repo';
  const sizeBasis = isMulti
    ? repos.reduce((a, r) => a + r.nodes, 0)
    : repos.reduce((a, r) => a + r.nodes, 0) / repos.length;
  const basisRepo: RepoFact = { name: 'basis', nodes: sizeBasis, edges: 0 };

  const baseTokens = baselineUnderstandingTokens(basisRepo);
  const baseTime = baselineTimeMs(basisRepo);

  return {
    quality: cal.quality,
    tokens: Math.round(baseTokens * cal.read_fraction),
    token_source: 'estimated-work',
    time_ms: Math.round(baseTime * cal.time_fraction),
  };
}
