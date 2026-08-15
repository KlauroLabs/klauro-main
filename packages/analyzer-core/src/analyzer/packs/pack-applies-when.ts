





import * as fs from 'fs-extra';
import * as path from 'path';
import { cachedGlob as glob } from '../core/glob-cache';
import { AppliesWhen } from './pack-schema';

export interface AppliesWhenEvidence {
  applies: boolean;
  reason: string;
}

export async function evaluateAppliesWhen(
  projectPath: string,
  appliesWhen: AppliesWhen,
  candidateFiles: string[],
): Promise<AppliesWhenEvidence> {
  const hasAnyGate = !!(appliesWhen.dependency?.length || appliesWhen.file?.length || appliesWhen.import?.length);
  if (!hasAnyGate) {



    return { applies: true, reason: 'no applies_when gate declared' };
  }

  if (appliesWhen.dependency?.length) {
    const deps = await readManifestDependencyNames(projectPath);
    const hit = appliesWhen.dependency.find(d => deps.has(d));
    if (hit) return { applies: true, reason: `dependency "${hit}" found in manifest` };
  }

  if (appliesWhen.file?.length) {
    for (const pattern of appliesWhen.file) {
      const matches = await glob(pattern, { cwd: projectPath, nodir: true });
      if (matches.length > 0) return { applies: true, reason: `file glob "${pattern}" matched ${matches[0]}` };
    }
  }

  if (appliesWhen.import?.length) {
    const regexes = appliesWhen.import.map(source => new RegExp(source));
    for (const file of candidateFiles) {
      let content: string;
      try {
        content = await fs.readFile(path.join(projectPath, file), 'utf-8');
      } catch {
        continue;
      }
      const hitRegex = regexes.find(r => r.test(content));
      if (hitRegex) return { applies: true, reason: `import pattern "${hitRegex.source}" matched in ${file}` };
    }
  }

  return { applies: false, reason: 'no dependency/file/import evidence matched' };
}

async function readManifestDependencyNames(projectPath: string): Promise<Set<string>> {
  const names = new Set<string>();
  try {
    const pkgPath = path.join(projectPath, 'package.json');
    if (await fs.pathExists(pkgPath)) {
      const pkg = await fs.readJson(pkgPath);
      for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) names.add(name);
    }
  } catch {

  }
  return names;
}
