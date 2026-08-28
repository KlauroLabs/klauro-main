import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface TelemetrySdkReadinessOptions {
  candidateDir?: string;
  sourceSha?: string;
}

export interface TelemetrySdkReadiness {
  status: 'release_candidate' | 'installable';
  installable: boolean;
  reason: string;
  source_sha?: string;
  artifact_sha256?: string;
}

export function telemetrySdkReadiness(
  stack: 'node' | 'python',
  options: TelemetrySdkReadinessOptions = {},
): TelemetrySdkReadiness {
  const candidateDir = options.candidateDir || process.env.KLAURO_TELEMETRY_SDK_CANDIDATE_DIR;
  const sourceSha = options.sourceSha || process.env.KLAURO_BUILD_GIT_SHA;
  if (!candidateDir || !sourceSha) return candidate('source-bound release manifest is not configured');
  try {
    if (!/^[0-9a-f]{40}$/.test(sourceSha)) return candidate('release source SHA is not exact');
    const manifestBytes = fs.readFileSync(path.join(candidateDir, 'manifest.json'));
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    const receipt = JSON.parse(fs.readFileSync(path.join(candidateDir, 'release-proof.json'), 'utf8'));
    if (manifest.schema_version !== 1 || manifest.source_sha !== sourceSha || manifest.git_clean !== true
      || manifest.install_smoke !== true || receipt.source_sha !== sourceSha) {
      return candidate('release manifest identity or clean-install proof does not match this server');
    }
    const expectedManifestDigest = digest(manifestBytes);
    if (receipt.manifest_sha256 !== expectedManifestDigest) return candidate('release manifest digest does not match its receipt');
    const proof = {
      schema_version: receipt.schema_version,
      source_sha: receipt.source_sha,
      javascript_version: receipt.javascript_version,
      python_version: receipt.python_version,
      manifest_sha256: receipt.manifest_sha256,
      artifacts: receipt.artifacts,
      passed_gates: receipt.passed_gates,
    };
    if (receipt.proof_sha256 !== digest(JSON.stringify(proof))) return candidate('release receipt digest is invalid');
    const kind = stack === 'node' ? 'javascript' : 'python';
    const artifact = manifest.artifacts?.find((item: any) => item.kind === kind);
    const receiptArtifact = receipt.artifacts?.find((item: any) => item.kind === kind);
    if (!artifact || !receiptArtifact || artifact.filename !== receiptArtifact.filename
      || artifact.sha256 !== receiptArtifact.sha256 || !/^[0-9a-f]{64}$/.test(artifact.sha256)) {
      return candidate(`${kind} artifact is absent from the source-bound receipt`);
    }
    if (path.basename(artifact.filename) !== artifact.filename
      || digest(fs.readFileSync(path.join(candidateDir, artifact.filename))) !== artifact.sha256) {
      return candidate(`${kind} artifact digest does not match`);
    }
    return {
      status: 'installable',
      installable: true,
      reason: 'source-bound artifact and clean-install proof verified',
      source_sha: sourceSha,
      artifact_sha256: artifact.sha256,
    };
  } catch {
    return candidate('source-bound release manifest is unavailable or invalid');
  }
}

function candidate(reason: string): TelemetrySdkReadiness {
  return { status: 'release_candidate', installable: false, reason };
}

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
