import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

const run = promisify(execFile);

function indexerPath(): string {
  return path.join(__dirname, 'native', 'repo-indexer');
}

export async function indexRepository(root: string): Promise<string> {
  const tracked = fs.existsSync(path.join(root, '.git'));
  const { stdout } = await run(indexerPath(), [root, tracked ? 'tracked' : 'plain']);
  return stdout;
}
