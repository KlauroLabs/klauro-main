export interface TelemetrySdkReleaseIdentity {
  sourceSha: string;
  javascriptVersion: string;
  pythonVersion: string;
  authoritativeLicenseSha256: string;
}

export interface TelemetrySdkReleaseReceipt {
  schema_version: number;
  source_sha: string;
  javascript_version: string;
  python_version: string;
  manifest_sha256: string;
  artifacts: Array<{ kind: string; filename: string; sha256: string; inventory_sha256: string; install_proof: { artifact_sha256: string; isolated: boolean; command: string[]; smoke_command: string[] } }>;
  passed_gates: string[];
  proof_sha256: string;
}

export function sha256(bytes: string | Uint8Array): string;
export function readSdkArchiveInventory(kind: string, archivePath: string): string[];
export function resolveTelemetrySdkReleaseCandidateRoot(candidateDir: string): string;
export function assertSdkArchiveInventory(kind: string, entries: unknown[]): string[];
export function expectedTelemetrySdkIdentity(environment?: NodeJS.ProcessEnv): Omit<TelemetrySdkReleaseIdentity, 'authoritativeLicenseSha256'>;
export function writeTelemetrySdkReleaseReceipt(candidateDir: string, expected: TelemetrySdkReleaseIdentity): TelemetrySdkReleaseReceipt;
export function verifyTelemetrySdkReleaseReceipt(candidateDir: string, expected: TelemetrySdkReleaseIdentity): { manifest: Record<string, unknown>; receipt: TelemetrySdkReleaseReceipt };
export function installTelemetrySdkReleaseCandidate(stagedDir: string, destinationDir: string, expected: TelemetrySdkReleaseIdentity, options?: { injectFailureAfterBackup?: boolean; injectCrashBeforePublish?: boolean; injectFailureAfterDestinationParentSync?: boolean; beforeStaleRecovery?: (owner: unknown) => void }): void;
