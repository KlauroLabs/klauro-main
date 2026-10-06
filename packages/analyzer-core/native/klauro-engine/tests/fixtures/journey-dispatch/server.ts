import { writeFileSync } from 'node:fs'

interface Wire {
  send(frame: { t: string }): void
}

export class Server {
  constructor(private readonly wire: Wire) {}

  handle(frame: { t: string; text?: string }): void {
    switch (frame.t) {
      case 'save':
        writeFileSync('notes.txt', frame.text ?? '')
        break
      case 'list':
        this.wire.send({ t: 'listed' })
        break
      default:
        this.wire.send({ t: 'failed' })
    }
  }
}
