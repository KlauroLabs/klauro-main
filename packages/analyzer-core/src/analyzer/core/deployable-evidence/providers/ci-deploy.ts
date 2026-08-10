import * as fs from 'fs-extra';
import * as path from 'path';
import type { DeployableEvidence } from '../../../../types/cas.types';
import type { EvidenceCollectionContext, EvidenceProvider } from '../types';
import { IGNORE_GLOBS, safeGlobSync } from '../util';

/** CI workflow jobs whose steps deploy/publish/release (no existing analyzer covers this). */
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

  // Genuine deploy-TO-A-RUNTIME-TARGET actions only — a CI job that BUILDS
  // and PUBLISHES a distributable artifact (a docker push, an `npm publish`,
  // a "Publish Packages" job that uploads a .deb/.rpm) is a packaging
  // pipeline for a product some OTHER evidence row (a container/bin/
  // installer row) already represents; it is not itself a ship unit any
  // more than the Dockerfile it invokes is. The bare `deploy`/`publish`/
  // `release`/`docker/build-push-action`/`npm publish`/`cargo publish`/
  // `gh release` markers this list used to include matched exactly that
  // shape and nothing else on a real repo: three release-automation
  // workflows (build+push a Docker image, build+publish a .deb, build+
  // publish an .rpm — all three for the SAME single-binary product already
  // counted via its container/bin evidence) surfaced as three EXTRA
  // "deployable" ship units. Kept here: only actions that actually put a
  // workload on a running target (a cluster, a serverless platform, an IaC
  // apply) — evidence that this workflow is a deployment, not a release.
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
