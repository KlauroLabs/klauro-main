export interface Notifier {
  send(message: string): void;
}

export class EmailNotifier implements Notifier {
  send(message: string): void {}
}

export class SmsNotifier implements Notifier {
  send(message: string): void {}
}

export class LoggingNotifier implements Notifier {
  private readonly inner: Notifier;
  constructor(inner: Notifier) {
    this.inner = inner;
  }
  send(message: string): void {
    this.inner.send(message);
  }
}

export class BroadcastNotifier implements Notifier {
  private readonly all: Notifier[];
  constructor(all: Notifier[]) {
    this.all = all;
  }
  send(message: string): void {
    for (const one of this.all) one.send(message);
  }
}

export class NotifierFactory {
  create(kind: string): Notifier {
    if (kind === "sms") return new SmsNotifier();
    return new EmailNotifier();
  }
}

export class Alerts {
  private readonly notifier: Notifier;
  constructor(notifier: Notifier) {
    this.notifier = notifier;
  }
  raise(message: string) {
    this.notifier.send(message);
  }
}

export class Settings {
  private static instance: Settings;
  private constructor() {}
  static getInstance(): Settings {
    if (!Settings.instance) Settings.instance = new Settings();
    return Settings.instance;
  }
}

export class QueryBuilder {
  private parts: string[] = [];
  where(clause: string): QueryBuilder {
    this.parts.push(clause);
    return this;
  }
  orderBy(field: string): QueryBuilder {
    this.parts.push(field);
    return this;
  }
  build(): string {
    return this.parts.join(" ");
  }
}
