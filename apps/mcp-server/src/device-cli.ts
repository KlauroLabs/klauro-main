export const CLI_CLIENT_ID = 'klauro-cli';

export interface DeviceSignIn {
  token: string;
  email: string;
  account_id?: string;
}

export interface DeviceSignInOptions {
  serverUrl: string;
  tell: (line: string) => void;
  wait?: (ms: number) => Promise<void>;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function posted(url: string, body: unknown, token?: string): Promise<{ ok: boolean; status: number; payload: any }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { ok: response.ok, status: response.status, payload: await response.json().catch(() => ({})) };
}

export async function signInWithDevice(options: DeviceSignInOptions): Promise<DeviceSignIn> {
  const wait = options.wait ?? pause;
  const issued = await posted(`${options.serverUrl}/api/auth/device/code`, { client_id: CLI_CLIENT_ID });
  if (!issued.ok) throw new Error(issued.payload.error || `Device sign-in could not start (HTTP ${issued.status})`);
  const { device_code: deviceCode, user_code: userCode, verification_uri: uri, verification_uri_complete: complete } = issued.payload;
  let interval = Math.max(1, Number(issued.payload.interval) || 5) * 1000;
  const deadline = Date.now() + Math.max(60, Number(issued.payload.expires_in) || 600) * 1000;
  options.tell(`To sign in, open ${complete || uri} and approve code ${userCode}`);
  options.tell(`(or, on a machine already signed in: klauro device approve ${userCode})`);
  while (Date.now() < deadline) {
    await wait(interval);
    const polled = await posted(`${options.serverUrl}/api/auth/device/token`, { device_code: deviceCode, client_id: CLI_CLIENT_ID });
    if (polled.ok && polled.payload.access_token) {
      return { token: polled.payload.access_token, email: polled.payload.email, account_id: polled.payload.account_id };
    }
    const reason = polled.payload.error;
    if (reason === 'authorization_pending') continue;
    if (reason === 'slow_down') { interval += 5000; continue; }
    if (reason === 'access_denied') throw new Error('The sign-in request was denied.');
    if (reason === 'expired_token') break;
    throw new Error(reason || `Device sign-in failed (HTTP ${polled.status})`);
  }
  throw new Error('The sign-in code expired before it was approved. Run `klauro login --device` again.');
}

export interface DeviceRequest {
  client_id: string;
  client_name?: string;
  requested_at: string;
}

export async function deviceRequest(serverUrl: string, userCode: string): Promise<DeviceRequest> {
  const response = await fetch(`${serverUrl}/api/auth/device/status?code=${encodeURIComponent(userCode)}`);
  const payload = await response.json().catch(() => ({})) as any;
  if (!response.ok) throw new Error(payload.error || `That code could not be looked up (HTTP ${response.status})`);
  return payload;
}

export async function decideDevice(serverUrl: string, token: string, userCode: string, decision: 'approve' | 'deny'): Promise<{ status: string; email?: string }> {
  const route = decision === 'approve' ? '/api/auth/device/approve' : '/api/auth/device/deny';
  const answered = await posted(`${serverUrl}${route}`, { user_code: userCode }, token);
  if (!answered.ok) throw new Error(answered.payload.error || `The code could not be ${decision === 'approve' ? 'approved' : 'denied'} (HTTP ${answered.status})`);
  return answered.payload;
}
