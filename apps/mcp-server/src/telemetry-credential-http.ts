import { AccountHttpError, type AccountStore } from './account-store';

interface TelemetryCredentialHttpResult {
  statusCode: number;
  body: unknown;
}

export async function handleTelemetryCredentialHttp(input: {
  accounts: AccountStore;
  userId: string;
  route: string;
  method?: string;
  sharedToken: boolean;
}): Promise<TelemetryCredentialHttpResult | null> {
  const collection = input.route.match(/^\/api\/projects\/([^/]+)\/telemetry-credentials$/);
  if (collection) {
    if (input.sharedToken) throw new AccountHttpError(403, 'A signed-in owner or admin is required');
    const projectId = decodeURIComponent(collection[1]);
    if (input.method === 'GET') return {
      statusCode: 200,
      body: { credentials: await input.accounts.listProjectTelemetryCredentials(input.userId, projectId) },
    };
    if (input.method === 'POST') {
      const credential = await input.accounts.issueProjectTelemetryCredential(input.userId, projectId);
      return { statusCode: 201, body: { credential } };
    }
    return null;
  }
  const item = input.route.match(/^\/api\/projects\/([^/]+)\/telemetry-credentials\/([^/]+)(?:\/(rotate))?$/);
  if (item) {
    if (input.sharedToken) throw new AccountHttpError(403, 'A signed-in owner or admin is required');
    const projectId = decodeURIComponent(item[1]);
    const credentialId = decodeURIComponent(item[2]);
    if (input.method === 'POST' && item[3] === 'rotate') {
      const credential = await input.accounts.rotateProjectTelemetryCredential(input.userId, projectId, credentialId);
      return { statusCode: 200, body: { credential } };
    }
    if (input.method === 'DELETE' && !item[3]) {
      await input.accounts.revokeProjectTelemetryCredential(input.userId, projectId, credentialId);
      return { statusCode: 204, body: null };
    }
    return null;
  }
  return null;
}
