import * as fs from 'fs-extra';
import * as path from 'path';
import type { DeployableEvidence } from '../../../../types/cas.types';
import type { EvidenceCollectionContext, EvidenceProvider } from '../types';
import { IGNORE_GLOBS, safeGlobSync } from '../util';


function collect(ctx: EvidenceCollectionContext): DeployableEvidence[] {
  const { projectPath } = ctx;
  const out: DeployableEvidence[] = [];
  let files: string[] = [];
  try {
    files = safeGlobSync(['.github/workflows/*.yml', '.github/workflows/*.yaml'], {
      cwd: projectPath,
      ignore: IGNORE_GLOBS,
      nodir: true,
      absolute: false,
    });
  } catch {
    return out;
  }
















  const deployMarker = /\b(helm upgrade|kubectl apply|serverless deploy|sam deploy|cdk deploy|terraform apply|actions\/deploy-pages)\b/i;

  for (const relativeFile of files) {
    let content = '';
    try {
      content = fs.readFileSync(path.join(projectPath, relativeFile), 'utf8');
    } catch {
      continue;
    }
    if (!deployMarker.test(content)) continue;

    const jobNames = /^jobs:\s*$/m.test(content)
      ? [...content.matchAll(/^\s{2}([A-Za-z0-9_-]+):\s*$/gm)].map(m => m[1])
      : [];
    const matchedLine = content.split(/\r?\n/).findIndex(line => deployMarker.test(line));

    out.push({
      root_path: path.dirname(relativeFile),
      name: path.basename(relativeFile, path.extname(relativeFile)),
      tier: 1,
      kind: 'ci-deploy',
      evidence: [
        `CI workflow: ${relativeFile}`,
        ...(jobNames.length ? [`jobs: ${jobNames.slice(0, 10).join(', ')}`] : []),
        `deploy marker at line ${matchedLine >= 0 ? matchedLine + 1 : '?'}`,
      ],
    });
  }

  return out;
}

export const ciDeployProvider: EvidenceProvider = {
  id: 'ci-deploy',
  tier: 1,
  collect,
};
