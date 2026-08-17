import * as fs from 'fs-extra';

export function restrictProcessFileCreation(): void {
  if (process.platform !== 'win32') process.umask(0o077);
}

export function ensurePrivateDataRoot(dataDir: string): void {
  fs.ensureDirSync(dataDir);
  if (process.platform !== 'win32') fs.chmodSync(dataDir, 0o700);
}
