export interface Frame {
  t: string
  b?: string
}

export class RelayClient {
  constructor(private readonly socket: { write(raw: string): void }) {}

  sendData(to: string, bytes: string): void {
    this.sendFrame({ t: 'data', to, b: bytes })
  }

  listDevices(): void {
    this.sendFrame({ t: 'device.list' })
  }

  private sendFrame(frame: Frame): void {
    this.socket.write(JSON.stringify(frame))
  }
}
