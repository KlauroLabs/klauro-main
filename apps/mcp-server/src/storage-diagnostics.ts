export function storageDiagnosticsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.KLAURO_STORAGE_DIAGNOSTICS === '1' || env.KLAURO_STORAGE_DIAGNOSTICS === 'true';
}

export function writeStorageDiagnostic(record: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): void {
  if (!storageDiagnosticsEnabled(env)) return;
  process.stderr.write(`${JSON.stringify(record)}\n`);
}
