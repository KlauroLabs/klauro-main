interface Config {
  endpoint: string;
  fetchImpl?: typeof fetch;
}

export class Reporter {
  constructor(private readonly config: Config) {}

  private statusUrl(): string {
    return `${this.config.endpoint}/version`;
  }

  async version(): Promise<Response> {
    const send = this.config.fetchImpl || globalThis.fetch;
    return send(this.statusUrl(), { method: 'GET' });
  }
}
