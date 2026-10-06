interface Wire {
  send(frame: { t: string; text?: string }): void
}

export class Client {
  constructor(private readonly wire: Wire) {}

  saveNote(text: string): void {
    this.wire.send({ t: 'save', text })
  }

  listNotes(): void {
    this.wire.send({ t: 'list' })
  }

  onFrame(frame: { t: string }): void {
    if (frame.t === 'listed') {
      console.log('notes shown')
    }
    if (frame.t === 'failed') {
      console.log('request failed')
    }
  }
}
