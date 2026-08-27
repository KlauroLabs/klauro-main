export interface TelemetrySdkReleaseIdentity {
  sourceSha: string;
  javascriptVersion: string;
  pythonVersion: string;
}

export interface TelemetrySdkReleaseReceipt {
  schema_version: number;
  source_sha: string;
  javascript_version: string;
  python_version: string;
  manifest_sha256: string;
  artifacts: Array<{ kind: string; filename: string; sha256: string }>;
  passed_gates: string[];
  proof_sha256: string;
}

export function sha256(bytes: string | Uint8Array): string;
export function assertSdkArchiveInventory(kind: string, entries: unknown[]): string[];
export function expectedTelemetrySdkIdentity(environment?: NodeJS.ProcessEnv): TelemetrySdkReleaseIdentity;
export function writeTelemetrySdkReleaseReceipt(
  candidateDir: string,
  expected: TelemetrySdkReleaseIdentity,
): TelemetrySdkReleaseReceipt;
export function verifyTelemetrySdkReleaseReceipt(
  candidateDir: string,
  expected: TelemetrySdkReleaseIdentity,
): { manifest: Record<string, unknown>; receipt: TelemetrySdkReleaseReceipt };
