import { AccountHttpError, type AccountStore } from './account-store';
import { MAX_TELEMETRY_BATCH_SIZE, migrateIngestedTelemetryProject } from './telemetry-ingestion';

export interface AuthorizedTelemetryProject {
  kind: 'hosted_project' | 'explicit_workspace';
  requested_id: string;
  storage_id: string;
}

export async function resolveAuthorizedTelemetryProject(
  accounts: AccountStore,
  clientId: string | undefined,
  requestedId: string,
): Promise<AuthorizedTelemetryProject | null> {
  if (clientId !== 'shared-token' && !clientId?.startsWith('user:')) {
    return { kind: 'explicit_workspace', requested_id: requestedId, storage_id: requestedId };
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
    return { kind: 'hosted_project', requested_id: requestedId, storage_id: storageId };
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

export interface AuthorizedHostedTelemetryStorage {
  requested_id: string;
  analysis_id: string;
  storage_key: string;
}

export async function resolveAuthorizedHostedTelemetryStorage(
  accounts: AccountStore,
  clientId: string | undefined,
  requestedId: string,
  workspaceForAnalysisId: (analysisId: string) => string,
): Promise<AuthorizedHostedTelemetryStorage | null> {
  const project = await resolveAuthorizedTelemetryProject(accounts, clientId, requestedId);
  if (!project) return null;
  const storageKey = project.kind === 'hosted_project'
    ? workspaceForAnalysisId(project.storage_id)
    : project.storage_id;
  if (project.kind === 'hosted_project') {
    const requestedStorageKey = workspaceForAnalysisId(project.requested_id);
    if (requestedStorageKey !== storageKey) {
      await migrateIngestedTelemetryProject(requestedStorageKey, storageKey);
    }
  }
  if (storageKey !== project.storage_id) {
    await migrateIngestedTelemetryProject(project.storage_id, storageKey);
  }
  return { requested_id: project.requested_id, analysis_id: project.storage_id, storage_key: storageKey };
}

export async function requireAuthorizedHostedTelemetryStorage(
  accounts: AccountStore,
  clientId: string | undefined,
  requestedId: string,
  workspaceForAnalysisId: (analysisId: string) => string,
): Promise<AuthorizedHostedTelemetryStorage> {
  const storage = await resolveAuthorizedHostedTelemetryStorage(accounts, clientId, requestedId, workspaceForAnalysisId);
  if (storage) return storage;
  throw new AccountHttpError(404, 'Project not found, or your account is not a member of its workspace.');
}
