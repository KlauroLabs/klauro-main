import type { LoadedKlauroConfig } from './klauro-config';

export function assertSourceTotalBytes(loaded: LoadedKlauroConfig, totalBytes: number): number {
  const configuredLimit = Number(loaded.config.source.maxTotalBytes);
  if (!Number.isFinite(configuredLimit) || configuredLimit <= 0) {
    throw new Error('Invalid .klaurorc source.maxTotalBytes: configure a positive total-byte upload limit.');
  }
  if (totalBytes > configuredLimit) {
    throw new Error('Source snapshot is ' + totalBytes + ' bytes, exceeding configured source.maxTotalBytes=' + configuredLimit + '; raise the explicit repository total-byte limit or narrow source roots.');
  }
  return totalBytes;
}
