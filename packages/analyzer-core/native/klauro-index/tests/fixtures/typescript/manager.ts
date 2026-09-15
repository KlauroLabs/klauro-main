export interface Session {
  id: string;
  startedAt: Date;
  transcript?: string;
}

export abstract class Base implements Disposable {
  abstract dispose(): void;
}

export class AppError extends Error {}

export class Store {
  write(id: string): void {}
  purge(): void {}
}

export function run(store: Store, id: string): void {
  store.write(id);
}

export class CallManager extends Base implements Session {
  private store: Store = new Store();
  #provider: VoiceProvider;
  readonly storePath: string;
  static instances = 0;
  private pending;
  private active = new Map<string, Session>();

  constructor(provider: VoiceProvider) {
    super();
    this.#provider = provider;
    this.storePath = '';
  }

  async endCall(id: string, force = false): Promise<boolean> {
    try {
      for (const key of this.active.keys()) {
        if (key === id) await this.#provider.close(key);
      }
    } catch (error) {
      return false;
    }
    const scratch = this.active.size;
    return this.active.delete(id) && scratch > 0;
  }

  save(id: string): void {
    this.store.write(id);
  }

  dispose(): void {}
}
