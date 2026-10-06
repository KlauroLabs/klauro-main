export interface Sender {
  send(message: string): Promise<void>
}

export class ExpoSender implements Sender {
  constructor(private readonly fetcher: (url: string) => Promise<unknown> = fetch) {}

  async send(message: string): Promise<void> {
    await this.fetcher('https://push.example/send')
  }
}

export class FcmSender implements Sender {
  async send(message: string): Promise<void> {
    await fetch('https://fcm.example/send')
  }
}
