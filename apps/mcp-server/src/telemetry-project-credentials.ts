import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const TELEMETRY_INGEST_SCOPE = 'telemetry:ingest' as const;

export interface ProjectTelemetryCredentialRecord {
  id: string;
  project_id: string;
  scope: typeof TELEMETRY_INGEST_SCOPE;
  token_hash: string;
  created_at: string;
  revoked_at?: string;
  rotated_from_id?: string;
}

export interface IssuedProjectTelemetryCredential {
  id: string;
  project_id: string;
  scope: typeof TELEMETRY_INGEST_SCOPE;
  token: string;
  created_at: string;
}

export function issueProjectTelemetryCredentialRecord(
  projectId: string,
  now = new Date(),
  rotatedFromId?: string,
): { record: ProjectTelemetryCredentialRecord; issued: IssuedProjectTelemetryCredential } {
  const id = `ptc_${randomBytes(12).toString('hex')}`;
  const token = `kt_${randomBytes(32).toString('base64url')}`;
  const createdAt = now.toISOString();
  return {
    record: {
      id,
      project_id: projectId,
      scope: TELEMETRY_INGEST_SCOPE,
      token_hash: hashProjectTelemetryToken(token),
      created_at: createdAt,
      ...(rotatedFromId ? { rotated_from_id: rotatedFromId } : {}),
    },
    issued: {
      id,
      project_id: projectId,
      scope: TELEMETRY_INGEST_SCOPE,
      token,
      created_at: createdAt,
    },
  };
}

export function projectTelemetryCredentialMatches(
  record: ProjectTelemetryCredentialRecord,
  token: string,
  projectId: string,
): boolean {
  if (record.revoked_at || record.scope !== TELEMETRY_INGEST_SCOPE || record.project_id !== projectId) return false;
  const expected = Buffer.from(record.token_hash, 'hex');
  const actual = Buffer.from(hashProjectTelemetryToken(token), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function hashProjectTelemetryToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
