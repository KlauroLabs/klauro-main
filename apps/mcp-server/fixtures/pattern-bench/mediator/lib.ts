// A Mediator centralizing communication between colleagues.
export class ChatMediator {
  private participants: Participant[] = [];
  register(p: Participant): void { this.participants.push(p); }
  broadcast(from: string, msg: string): void {
    for (const p of this.participants) p.receive(from, msg);
  }
}

export class Participant {
  constructor(private name: string, private mediator: ChatMediator) {
    mediator.register(this);
  }
  send(msg: string): void { this.mediator.broadcast(this.name, msg); }
  receive(from: string, msg: string): void { /* show */ }
}
