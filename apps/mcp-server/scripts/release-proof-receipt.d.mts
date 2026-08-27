export interface ReleaseProofReceipt {
  schema_version: number;
  version: string;
  git_sha: string;
  tarball_sha256: string;
  manifest_sha256: string;
  passed_gates: string[];
  proof_sha256: string;
}

export function sha256(contents: string | NodeJS.ArrayBufferView): string;
export function writeReleaseProofReceipt(
  packageRoot?: string,
  environment?: Record<string, string | undefined>,
): ReleaseProofReceipt;
export function verifyReleaseProofReceipt(
  packageRoot?: string,
  environment?: Record<string, string | undefined>,
): {
  manifest: Record<string, unknown>;
  receipt: ReleaseProofReceipt;
};
