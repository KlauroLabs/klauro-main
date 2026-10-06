import type * as http from 'http';

export const AUTHOR_RELAY_ROUTE = '/api/author/api/chat';

const MOST_ASKED_BYTES = 4 * 1024 * 1024;
const MOST_AT_ONCE_PER_ACCOUNT = 24;
const LONGEST_ANSWER_MS = 10 * 60 * 1000;
const LONGEST_WAIT_FOR_A_PLACE_MS = 20 * 60 * 1000;

class Places {
  private free: number;
  private readonly waiting: Array<() => void> = [];

  constructor(count: number) {
    this.free = count;
  }

  async take(withinMs: number): Promise<(() => void) | null> {
    if (this.free > 0) {
      this.free -= 1;
      return () => this.give();
    }
    return new Promise(resolve => {
      const turn = (): void => {
        clearTimeout(timer);
        resolve(() => this.give());
      };
      const timer = setTimeout(() => {
        const at = this.waiting.indexOf(turn);
        if (at >= 0) this.waiting.splice(at, 1);
        resolve(null);
      }, withinMs);
      this.waiting.push(turn);
    });
  }

  private give(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.free += 1;
  }
}

const places = new Map<string, Places>();

export function authorUpstream(): string | undefined {
  return process.env.KLAURO_AUTHOR_ENDPOINT?.trim() || undefined;
}

function answer(response: http.ServerResponse, status: number, body: Record<string, unknown>): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function asked(request: http.IncomingMessage): Promise<Buffer | null> {
  return new Promise(resolve => {
    const parts: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    request.on('data', (part: Buffer) => {
      size += part.length;
      if (size > MOST_ASKED_BYTES) {
        tooLarge = true;
        parts.length = 0;
      } else if (!tooLarge) {
        parts.push(part);
      }
    });
    request.on('end', () => resolve(tooLarge ? null : Buffer.concat(parts)));
    request.on('error', () => resolve(null));
  });
}

export async function relayAuthorAsk(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  account: string,
  upstream = authorUpstream(),
  placesPerAccount = MOST_AT_ONCE_PER_ACCOUNT,
  longestWaitMs = LONGEST_WAIT_FOR_A_PLACE_MS,
): Promise<void> {
  if (!upstream) {
    answer(response, 503, { status: 'error', error: 'AI authoring is not configured on this server.' });
    return;
  }
  const body = await asked(request);
  if (!body) {
    answer(response, 413, { status: 'error', error: 'The AI request is too large.' });
    return;
  }
  let held = places.get(account);
  if (!held) {
    held = new Places(placesPerAccount);
    places.set(account, held);
  }
  const release = await held.take(longestWaitMs);
  if (!release) {
    response.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '30' });
    response.end(JSON.stringify({ status: 'error', error: 'The AI backend is busy; try again shortly.' }));
    return;
  }
  try {
    const answered = await fetch(upstream, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: new Uint8Array(body),
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
    release();
  }
}
