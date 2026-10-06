import type { Frame } from '../packages/remote/client'

interface Peer {
  send(frame: Frame): void
}

export class Relay {
  constructor(private readonly desktop: Peer) {}

  handleDevice(frame: Frame): void {
    if (frame.t === 'data') {
      this.desktop.send({ t: 'data', b: frame.b })
      return
    }
    if (frame.t === 'device.list') {
      this.desktop.send({ t: 'devices' })
    }
  }
}
