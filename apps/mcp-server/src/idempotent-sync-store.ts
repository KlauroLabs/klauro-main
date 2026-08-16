export interface SyncResponseWithCas<TCas> {
  cas: TCas;
}

type StoredResponse<TResponse extends SyncResponseWithCas<unknown>> = Omit<TResponse, 'cas'>;

interface PendingEntry<TResponse> {
  state: 'pending';
  promise: Promise<TResponse>;
  expiresAt: number;
}

interface CompletedEntry<TResponse extends SyncResponseWithCas<unknown>> {
  state: 'completed';
  response: StoredResponse<TResponse>;
  expiresAt: number;
}

type Entry<TResponse extends SyncResponseWithCas<unknown>> = PendingEntry<TResponse> | CompletedEntry<TResponse>;

export class IdempotentSyncStore<TResponse extends SyncResponseWithCas<TCas>, TCas> {
  private readonly entries = new Map<string, Entry<TResponse>>();
  private readonly latestRequestByScope = new Map<string, string>();

  constructor(private readonly retentionMs = 5 * 60_000) {}

  async run(
    scope: string,
    requestId: string | undefined,
    execute: () => Promise<TResponse>,
    hydrateCas: () => Promise<TCas>,
  ): Promise<{ value: TResponse; replayed: boolean }> {
    if (!requestId) return { value: await execute(), replayed: false };
    this.removeExpired();
    const key = `${scope}:${requestId}`;
    const existing = this.entries.get(key);
    if (existing?.state === 'pending') return { value: await existing.promise, replayed: true };
    if (existing?.state === 'completed') {
      if (this.latestRequestByScope.get(scope) !== key) {
        throw new Error(`Sync request ${requestId} was superseded by a newer request for ${scope}`);
      }
      return { value: { ...existing.response, cas: await hydrateCas() } as TResponse, replayed: true };
    }

    this.latestRequestByScope.set(scope, key);
    const promise = execute();
    this.entries.set(key, { state: 'pending', promise, expiresAt: Date.now() + this.retentionMs });
    try {
      const result = await promise;
      const { cas: _cas, ...response } = result;
      this.entries.set(key, {
        state: 'completed',
        response: response as StoredResponse<TResponse>,
        expiresAt: Date.now() + this.retentionMs,
      });
      return { value: result, replayed: false };
    } catch (error) {
      this.entries.delete(key);
      if (this.latestRequestByScope.get(scope) === key) this.latestRequestByScope.delete(scope);
      throw error;
    }
  }

  private removeExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt > now) continue;
      this.entries.delete(key);
      for (const [scope, latest] of this.latestRequestByScope) {
        if (latest === key) this.latestRequestByScope.delete(scope);
      }
    }
  }
}

export class IdempotentRequestStore<T> {
  private readonly entries = new Map<string, { promise: Promise<T>; expiresAt: number }>();

  constructor(private readonly retentionMs = 5 * 60_000) {}

  async run(scope: string, requestId: string | undefined, execute: () => Promise<T>): Promise<{ value: T; replayed: boolean }> {
    if (!requestId) return { value: await execute(), replayed: false };
    const now = Date.now();
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(key);
    const key = `${scope}:${requestId}`;
    const existing = this.entries.get(key);
    if (existing) return { value: await existing.promise, replayed: true };
    const promise = execute();
    this.entries.set(key, { promise, expiresAt: now + this.retentionMs });
    try {
      return { value: await promise, replayed: false };
    } catch (error) {
      this.entries.delete(key);
      throw error;
    }
  }
}
