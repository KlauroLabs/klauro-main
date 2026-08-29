import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveTelemetrySdkReleaseCandidateRoot, verifyTelemetrySdkReleaseReceipt } from './telemetry-sdk-release-integrity.mjs';

const TELEMETRY_SDK_LICENSE_SHA256 = 'fd008f2c6d2f25412ff1e1e7abfed6c028c534a2c504ca3d0ef377284a253808';

export interface TelemetrySdkReadinessOptions {
  candidateDir?: string;
  sourceSha?: string;
}

export interface TelemetrySdkReadiness {
  status: 'release_candidate';
  installable: boolean;
  locally_installable: boolean;
  distributable: false;
  publishable: false;
  blockers: string[];
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
    const activeCandidateDir = resolveTelemetrySdkReleaseCandidateRoot(candidateDir);
    const manifest = JSON.parse(fs.readFileSync(path.join(activeCandidateDir, 'manifest.json'), 'utf8'));
    const verified = verifyTelemetrySdkReleaseReceipt(activeCandidateDir, {
      sourceSha,
      javascriptVersion: manifest.javascript_version,
      pythonVersion: manifest.python_version,
      authoritativeLicenseSha256: TELEMETRY_SDK_LICENSE_SHA256,
    });
    const kind = stack === 'node' ? 'javascript' : 'python';
    const artifact = (verified.manifest.artifacts as any[])?.find(item => item.kind === kind);
    if (!artifact) return candidate(`${kind} artifact is absent from the source-bound receipt`);
    return {
      status: 'release_candidate',
      installable: true,
      locally_installable: true,
      distributable: false,
      publishable: false,
      blockers: [...(verified.manifest.blockers as string[])],
      reason: 'source-bound artifact is verified for local installation; private-beta distribution authorization remains required',
      source_sha: sourceSha,
      artifact_sha256: artifact.sha256,
    };
  } catch {
    return candidate('source-bound release manifest is unavailable or invalid');
  }
}

function candidate(reason: string): TelemetrySdkReadiness {
  return { status: 'release_candidate', installable: false, locally_installable: false, distributable: false, publishable: false, blockers: ['source_bound_artifact_proof_missing', 'private_beta_license_requires_distribution_authorization'], reason };
}
