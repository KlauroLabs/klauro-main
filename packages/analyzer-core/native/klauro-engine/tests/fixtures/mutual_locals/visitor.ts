export class Visitor {
  child: Visitor;

  constructor(child: Visitor) {
    this.child = child;
  }

  visit() {}
}
