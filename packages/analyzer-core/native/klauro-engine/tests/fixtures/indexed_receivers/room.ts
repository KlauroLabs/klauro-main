import { ExpoSender, FcmSender, type Sender } from './senders'

export class Room {
  senders: Record<'expo' | 'fcm', Sender | null>
  byName = new Map<string, Sender>()

  constructor() {
    this.senders = { expo: new ExpoSender(), fcm: new FcmSender() }
  }

  async pushThroughRecord(provider: 'expo' | 'fcm'): Promise<void> {
    const sender = this.senders[provider]
    if (sender) await sender.send('hello')
  }

  async pushThroughMap(name: string): Promise<void> {
    await this.byName.get(name)?.send('hello')
  }
}
