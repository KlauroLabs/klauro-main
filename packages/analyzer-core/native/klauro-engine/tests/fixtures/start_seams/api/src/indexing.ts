import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';

const run = promisify(execFile);

function indexerPath(): string {
  return path.join(__dirname, 'native', 'repo-indexer');
}

export async function indexRepository(root: string): Promise<string> {
  const { stdout } = await run(indexerPath(), [root]);
  return stdout;
}
