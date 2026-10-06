import { RelayClient } from '../packages/remote'

interface Connection {
  request(message: { type: string; text?: string }): void
}

export function sendAsk(conn: Connection, text: string): void {
  conn.request({ type: 'prompt', text })
}

export function cancel(conn: Connection): void {
  conn.request({ type: 'cancel' })
}

export function pair(client: RelayClient): void {
  client.listDevices()
}
