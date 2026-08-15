import * as fs from 'fs-extra';
import * as path from 'path';
import type { DeployableEvidence } from '../../../../types/cas.types';
import type { EvidenceCollectionContext, EvidenceProvider } from '../types';
import { IGNORE_GLOBS, safeDeployableName, safeGlobSync } from '../util';
























































interface HelmChart {
  file: string;
  dir: string;
  name?: string;
  version?: string;
}

function findHelmCharts(projectPath: string): HelmChart[] {
  let files: string[] = [];
  try {
    files = safeGlobSync('**/Chart.yaml', { cwd: projectPath, ignore: IGNORE_GLOBS, nodir: true, absolute: false });
  } catch {
    return [];
  }

  const charts: HelmChart[] = [];
  for (const file of files) {
    const dir = path.dirname(file);



    if (!fs.existsSync(path.join(projectPath, dir, 'templates'))) continue;

    let name: string | undefined;
    let version: string | undefined;
    try {
      const content = fs.readFileSync(path.join(projectPath, file), 'utf8');
      name = content.match(/^\s*name\s*:\s*(.+?)\s*$/m)?.[1]?.replace(/^["']|["']$/g, '');
      version = content.match(/^\s*version\s*:\s*(.+?)\s*$/m)?.[1]?.replace(/^["']|["']$/g, '');
    } catch {

    }

    charts.push({ file, dir, name, version });
  }
  return charts;
}

function collectHelm(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const { projectPath } = ctx;
  const out: DeployableEvidence[] = [];

  for (const chart of findHelmCharts(projectPath)) {
    const evidence: string[] = [`Helm Chart.yaml: ${chart.file}`, `templates/: ${path.join(chart.dir, 'templates')}`];
    if (chart.version) evidence.push(`chart version: ${chart.version}`);


    const shipsPaths: string[] = [];
    const valuesPath = path.join(projectPath, chart.dir, 'values.yaml');
    if (fs.existsSync(valuesPath)) {
      try {
        const values = fs.readFileSync(valuesPath, 'utf8');
        const repoMatches = [...values.matchAll(/^\s*repository\s*:\s*(.+?)\s*$/gm)];
        const tagMatches = [...values.matchAll(/^\s*tag\s*:\s*(.+?)\s*$/gm)];
        const repos = repoMatches.map(m => m[1].replace(/^["']|["']$/g, ''));
        const tags = tagMatches.map(m => m[1].replace(/^["']|["']$/g, ''));
        repos.forEach((repo, i) => {
          const tag = tags[i];
          shipsPaths.push(tag ? `${repo}:${tag}` : repo);
        });
        if (shipsPaths.length) evidence.push(`values.yaml image(s): ${shipsPaths.join(', ')}`);
      } catch {

      }
    }

    out.push({
      root_path: chart.dir,
      name: chart.name || path.basename(chart.dir),
      tier: 1,
      kind: 'k8s',
      evidence,
      ships_paths: shipsPaths.length ? shipsPaths : undefined,
    });
  }

  return out;
}

function collectServerless(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const { projectPath, displayName } = ctx;
  const out: DeployableEvidence[] = [];

  let files: string[] = [];
  try {
    files = safeGlobSync(['**/serverless.yml', '**/serverless.yaml', '**/serverless.ts'], {
      cwd: projectPath,
      ignore: IGNORE_GLOBS,
      nodir: true,
      absolute: false,
    });
  } catch {
    files = [];
  }

  for (const file of files) {
    let content = '';
    try {
      content = fs.readFileSync(path.join(projectPath, file), 'utf8');
    } catch {
      continue;
    }

    const serviceName = content.match(/^\s*service\s*:\s*(.+?)\s*$/m)?.[1]?.replace(/^["']|["']$/g, '');


    const functionNames = new Set<string>();
    const yamlBlock = content.match(/^functions:\s*\n((?:[ \t]+.+\n?)*)/m)?.[1];
    if (yamlBlock) {
      for (const m of yamlBlock.matchAll(/^  ([A-Za-z0-9_-]+):\s*$/gm)) functionNames.add(m[1]);
    }
    if (!functionNames.size) {
      const tsBlock = content.match(/functions\s*:\s*\{([\s\S]*?)\n\s*\}/)?.[1];
      if (tsBlock) {
        for (const m of tsBlock.matchAll(/^\s*([A-Za-z0-9_-]+)\s*:\s*\{/gm)) functionNames.add(m[1]);
      }
    }

    const dir = path.dirname(file);
    const evidence: string[] = [`serverless config: ${file}`];
    if (serviceName) evidence.push(`service: ${serviceName}`);
    if (functionNames.size) evidence.push(`functions: ${[...functionNames].join(', ')}`);

    out.push({
      root_path: dir,
      name: serviceName || path.basename(dir),
      tier: 1,
      kind: 'serverless',
      evidence,
      ships_paths: functionNames.size ? [...functionNames] : undefined,


      entrypoint_member: functionNames.size === 1 ? [...functionNames][0] : undefined,
    });
  }


  let samFiles: string[] = [];
  try {
    samFiles = safeGlobSync(['**/template.yaml', '**/template.yml'], {
      cwd: projectPath,
      ignore: IGNORE_GLOBS,
      nodir: true,
      absolute: false,
    });
  } catch {
    samFiles = [];
  }
  for (const file of samFiles) {
    let content = '';
    try {
      content = fs.readFileSync(path.join(projectPath, file), 'utf8');
    } catch {
      continue;
    }
    if (!/Transform:\s*AWS::Serverless-2016-10-31/.test(content)) continue;

    const fnNames = [...content.matchAll(/^\s{2}([A-Za-z0-9_-]+):\s*\n(?:[^\n]*\n)*?\s*Type:\s*AWS::Serverless::Function/gm)].map(m => m[1]);
    const dir = path.dirname(file);
    out.push({
      root_path: dir,
      name: path.basename(dir) === '.' ? safeDeployableName(displayName || path.basename(projectPath)) : path.basename(dir),
      tier: 1,
      kind: 'serverless',
      evidence: [`AWS SAM template: ${file}`, ...(fnNames.length ? [`AWS::Serverless::Function: ${fnNames.join(', ')}`] : [])],
      ships_paths: fnNames.length ? fnNames : undefined,
      entrypoint_member: fnNames.length === 1 ? fnNames[0] : undefined,
    });
  }


  let sstFiles: string[] = [];
  try {
    sstFiles = safeGlobSync(['**/sst.config.ts', '**/.sst/**/config.json'], {
      cwd: projectPath,
      ignore: IGNORE_GLOBS,
      nodir: true,
      absolute: false,
    });
  } catch {
    sstFiles = [];
  }
  for (const file of sstFiles) {
    const dir = path.dirname(file) === '.sst' ? '.' : path.dirname(file);
    out.push({
      root_path: dir,
      name: safeDeployableName(displayName || path.basename(projectPath)),
      tier: 1,
      kind: 'serverless',
      evidence: [`SST config: ${file}`],
    });
  }

  return out;
}

function collectProcfile(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const { projectPath, displayName } = ctx;
  const out: DeployableEvidence[] = [];

  let files: string[] = [];
  try {
    files = safeGlobSync(['**/Procfile'], { cwd: projectPath, ignore: IGNORE_GLOBS, nodir: true, absolute: false });
  } catch {
    files = [];
  }

  for (const file of files) {
    let content = '';
    try {
      content = fs.readFileSync(path.join(projectPath, file), 'utf8');
    } catch {
      continue;
    }

    const processes = new Map<string, string>();
    for (const m of content.matchAll(/^([A-Za-z0-9_-]+):\s*(.+)$/gm)) processes.set(m[1], m[2].trim());
    if (!processes.size) continue;

    const dir = path.dirname(file);
    const evidence: string[] = [`Procfile: ${file}`, `process types: ${[...processes.keys()].join(', ')}`];
    for (const [type, command] of processes) evidence.push(`${type}: ${command}`);

    out.push({
      root_path: dir,
      name: path.basename(dir) === '.' ? safeDeployableName(displayName || path.basename(projectPath)) : path.basename(dir),
      tier: 1,
      kind: 'installer',
      evidence,
      ships_paths: [...processes.keys()],



      entrypoint_member: processes.has('web') ? 'web' : undefined,
    });
  }

  return out;
}

interface SimplePaasManifest {
  glob: string;
  label: string;
}

const SIMPLE_PAAS_MANIFESTS: SimplePaasManifest[] = [
  { glob: '**/fly.toml', label: 'Fly.io' },
  { glob: '**/vercel.json', label: 'Vercel' },
  { glob: '**/netlify.toml', label: 'Netlify' },
  { glob: '**/app.yaml', label: 'GAE/App Platform' },
  { glob: '**/railway.json', label: 'Railway' },
  { glob: '**/render.yaml', label: 'Render' },
];



function collectSimplePaasManifests(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const { projectPath, displayName } = ctx;
  const out: DeployableEvidence[] = [];

  for (const { glob, label } of SIMPLE_PAAS_MANIFESTS) {
    let files: string[] = [];
    try {
      files = safeGlobSync(glob, { cwd: projectPath, ignore: IGNORE_GLOBS, nodir: true, absolute: false });
    } catch {
      continue;
    }

    for (const file of files) {
      let content = '';
      try {
        content = fs.readFileSync(path.join(projectPath, file), 'utf8');
      } catch {
        continue;
      }

      const dir = path.dirname(file);
      const evidence: string[] = [`${label} manifest: ${file}`];
      let name: string | undefined;

      if (file.endsWith('fly.toml')) {
        name = content.match(/^\s*app\s*=\s*"([^"]+)"/m)?.[1];
        if (name) evidence.push(`app: ${name}`);
      } else if (file.endsWith('vercel.json') || file.endsWith('railway.json')) {
        try {
          const json = JSON.parse(content);
          name = json.name;
          if (name) evidence.push(`name: ${name}`);
        } catch {

        }
      } else if (file.endsWith('app.yaml')) {
        name = content.match(/^\s*service\s*:\s*(.+?)\s*$/m)?.[1]?.replace(/^["']|["']$/g, '');
        if (name) evidence.push(`service: ${name}`);
      }

      out.push({
        root_path: dir,
        name: name || (path.basename(dir) === '.' ? safeDeployableName(displayName || path.basename(projectPath)) : path.basename(dir)),
        tier: 1,
        kind: 'installer',
        evidence,
      });
    }
  }

  return out;
}

function collect(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  return [
    ...collectHelm(ctx),
    ...collectServerless(ctx),
    ...collectProcfile(ctx),
    ...collectSimplePaasManifests(ctx),
  ];
}

export const deployManifestsProvider: EvidenceProvider = {
  id: 'deploy-manifests',
  tier: 1,
  collect,
};
