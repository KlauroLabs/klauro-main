import type * as http from 'http';

export const AUTHOR_RELAY_ROUTE = '/api/author/api/chat';

const MOST_ASKED_BYTES = 4 * 1024 * 1024;
const MOST_AT_ONCE_PER_ACCOUNT = 24;
const LONGEST_ANSWER_MS = 10 * 60 * 1000;

const asking = new Map<string, number>();

export function authorUpstream(): string | undefined {
  return process.env.KLAURO_AUTHOR_ENDPOINT?.trim() || undefined;
}

function answer(response: http.ServerResponse, status: number, body: Record<string, unknown>): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function asked(request: http.IncomingMessage): Promise<Buffer | null> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of request) {
    size += (part as Buffer).length;
    if (size > MOST_ASKED_BYTES) return null;
    parts.push(part as Buffer);
  }
  return Buffer.concat(parts);
}

export async function relayAuthorAsk(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  account: string,
  upstream = authorUpstream(),
): Promise<void> {
  if (!upstream) {
    answer(response, 503, { status: 'error', error: 'AI authoring is not configured on this server.' });
    return;
  }
  const already = asking.get(account) ?? 0;
  if (already >= MOST_AT_ONCE_PER_ACCOUNT) {
    answer(response, 429, { status: 'error', error: 'Too many AI requests in flight for this account.' });
    return;
  }
  asking.set(account, already + 1);
  try {
    const body = await asked(request);
    if (!body) {
      answer(response, 413, { status: 'error', error: 'The AI request is too large.' });
      return;
    }
    const answered = await fetch(upstream, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(LONGEST_ANSWER_MS),
    });
    const text = await answered.text();
    response.writeHead(answered.status, { 'Content-Type': answered.headers.get('content-type') || 'application/json' });
    response.end(text);
  } catch (error) {
    if (!response.headersSent) {
      answer(response, 502, { status: 'error', error: `The AI backend did not answer: ${error instanceof Error ? error.message : String(error)}` });
    }
  } finally {
    const left = (asking.get(account) ?? 1) - 1;
    if (left > 0) asking.set(account, left);
    else asking.delete(account);
  }
}
