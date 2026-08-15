













import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import { ARMS, type ScenarioGroup } from './report-schema';
import { projectArm, type RepoFact } from './projection-model';
import { validateWin } from './win-validator';

function dir(): string { return path.join(os.homedir(), '.klauro', 'gauntlet'); }
function userScenariosFile(): string { return path.join(dir(), 'user-scenarios.json'); }
function projectBuildsFile(): string { return path.join(dir(), 'project-builds.json'); }





export interface UserScenario {
  id: string;
  label: string;
  group: ScenarioGroup;
  task: string;
  klauroEdge: string;
  arms?: string[];
  created_at: string;
  source: 'user';
}

const GROUPS: ScenarioGroup[] = ['single-repo', 'workspace', 'cross-repo', 'incremental', 'analysis'];

export async function listUserScenarios(): Promise<UserScenario[]> {
  try { return await fs.readJson(userScenariosFile()); } catch { return []; }
}

export async function addUserScenario(input: Partial<UserScenario>, now: string): Promise<{ ok: boolean; scenario?: UserScenario; error?: string }> {
  const label = String(input.label || '').trim();
  const task = String(input.task || '').trim();
  if (!label) return { ok: false, error: 'label is required' };
  if (!task) return { ok: false, error: 'task is required' };
  const group = (GROUPS.includes(input.group as ScenarioGroup) ? input.group : 'single-repo') as ScenarioGroup;
  const id = (input.id || label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || `scenario-${now.slice(0, 10)}`;

  const existing = await listUserScenarios();
  if (existing.some(s => s.id === id)) return { ok: false, error: `scenario id '${id}' already exists` };

  const scenario: UserScenario = {
    id, label, group, task,
    klauroEdge: String(input.klauroEdge || 'Klauro precomputed analysis answers this without re-reading the tree.').trim(),
    arms: Array.isArray(input.arms) && input.arms.length ? input.arms.filter(a => ARMS.some(x => x.id === a)) : undefined,
    created_at: now, source: 'user',
  };
  existing.push(scenario);
  await fs.ensureDir(dir());
  await fs.writeJson(userScenariosFile(), existing, { spaces: 2 });
  return { ok: true, scenario };
}





export type ProjectSize = 'tiny' | 'small' | 'medium' | 'large';



const SIZE_NODES: Record<ProjectSize, number> = { tiny: 120, small: 600, medium: 2500, large: 9000 };

export interface ProjectBuildArm {
  arm_id: string;
  quality: number;
  success: boolean;
  time_ms: number;
  tokens: number;
}

export interface ProjectBuild {
  id: string;
  prompt: string;
  size: ProjectSize;
  created_at: string;
  mode: 'projected' | 'live';
  status: 'queued' | 'done' | 'error';
  arms: ProjectBuildArm[];
  win: boolean;
  note?: string;
}

export async function listProjectBuilds(): Promise<ProjectBuild[]> {
  try { return await fs.readJson(projectBuildsFile()); } catch { return []; }
}






function projectBuild(size: ProjectSize): { arms: ProjectBuildArm[]; win: boolean } {
  const repo: RepoFact = { name: 'new-project', nodes: SIZE_NODES[size], edges: Math.round(SIZE_NODES[size] * 0.6) };
  const arms: ProjectBuildArm[] = [];
  const armResults = ARMS.map(arm => {
    const m = projectArm('single-repo', arm.id, [repo]);
    return { arm, m };
  }).filter(x => x.m);
  for (const { arm, m } of armResults) {
    arms.push({
      arm_id: arm.id,
      quality: m!.quality ?? 0,
      success: (m!.quality ?? 0) >= 75,
      time_ms: m!.time_ms ?? 0,
      tokens: m!.tokens ?? 0,
    });
  }
  const verdict = validateWin(
    armResults.map(({ arm, m }) => ({ arm_id: arm.id, mode: 'projected' as const, attempted: true, metrics: m! })),
    'greenfield build',
  );
  return { arms, win: verdict.klauro_wins };
}

export async function requestProjectBuild(input: { prompt?: string; size?: ProjectSize }, now: string, rnd: string): Promise<ProjectBuild> {
  const size = (['tiny', 'small', 'medium', 'large'].includes(input.size as string) ? input.size : 'small') as ProjectSize;
  const { arms, win } = projectBuild(size);
  const build: ProjectBuild = {
    id: `build-${now.slice(0, 10)}-${rnd}`,
    prompt: String(input.prompt || `Build a ${size} project`).slice(0, 400),
    size, created_at: now, mode: 'projected', status: 'done',
    arms, win,
    note: 'Projected from the size model. Configure live agent commands to build for real and overlay measured quality/success/speed/tokens.',
  };
  const all = await listProjectBuilds();
  all.unshift(build);
  await fs.ensureDir(dir());
  await fs.writeJson(projectBuildsFile(), all.slice(0, 200), { spaces: 2 });
  return build;
}
