interface Handler { handle(req: string): string; }
class BaseHandler implements Handler { handle(req: string) { return req; } }
export class LoggingDecorator implements Handler {
  constructor(private inner: Handler) {}
  handle(req: string) { return this.inner.handle(req); }
}
export class SaveCommand {
  constructor(private id: string) {}
  execute() { return `saved ${this.id}`; }
}
