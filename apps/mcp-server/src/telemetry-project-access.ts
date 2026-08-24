import { AccountHttpError, type AccountStore } from './account-store';
import { MAX_TELEMETRY_BATCH_SIZE, migrateIngestedTelemetryProject } from './telemetry-ingestion';

export interface AuthorizedTelemetryProject {
  requested_id: string;
  storage_id: string;
}

export async function resolveAuthorizedTelemetryProject(
  accounts: AccountStore,
  clientId: string | undefined,
  requestedId: string,
): Promise<AuthorizedTelemetryProject | null> {
  if (clientId !== 'shared-token' && !clientId?.startsWith('user:')) {
    return { requested_id: requestedId, storage_id: requestedId };
  }
  if (!requestedId.startsWith('prj_')) return null;
  try {
    const project = clientId === 'shared-token'
      ? await accounts.getProjectById(requestedId)
      : await accounts.getProjectForUser(clientId.slice('user:'.length), requestedId);
    if (!project) return null;
    const storageId = project.analysis_id || project.id;
    if (storageId !== project.id) {
      await migrateIngestedTelemetryProject(project.id, storageId);
    }
    return { requested_id: requestedId, storage_id: storageId };
  } catch (error) {
    if (error instanceof AccountHttpError && error.statusCode === 404) return null;
    throw error;
  }
}

export async function requireAuthorizedTelemetryProject(
  accounts: AccountStore,
  clientId: string | undefined,
  requestedId: string,
): Promise<AuthorizedTelemetryProject> {
  const project = await resolveAuthorizedTelemetryProject(accounts, clientId, requestedId);
  if (project) return project;
  throw new AccountHttpError(404, 'Project not found, or your account is not a member of its workspace.');
}

export function requireTelemetryBatchSize(count: number): void {
  if (count <= MAX_TELEMETRY_BATCH_SIZE) return;
  throw new AccountHttpError(413, `Telemetry batches are limited to ${MAX_TELEMETRY_BATCH_SIZE} events`);
}
