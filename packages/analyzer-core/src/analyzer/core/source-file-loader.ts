import * as path from 'node:path';
import * as fs from 'fs-extra';

export interface LoadedSourceFile {
  relativePath: string;
  fullPath: string;
  content: string;
}

export async function loadSourceFiles(
  files: readonly string[],
  projectPath: string,
  batchSize = 100,
): Promise<LoadedSourceFile[]> {
  const loaded: LoadedSourceFile[] = [];
  for (let index = 0; index < files.length; index += batchSize) {
    const batch = await Promise.all(files.slice(index, index + batchSize).map(async relativePath => {
      const fullPath = path.join(projectPath, relativePath);
      const content = await fs.readFile(fullPath, 'utf-8');
      return { relativePath, fullPath, content };
    }));
    loaded.push(...batch);
  }
  return loaded;
}
