class User { constructor(public name: string) {} }
class Report {}
export class UserFactory { create(name: string): User { return new User(name); } }
export class ReportBuilder {
  private title = '';
  setTitle(t: string) { this.title = t; return this; }
  build(): Report { return new Report(); }
}
