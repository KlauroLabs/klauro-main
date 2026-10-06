import { Visitor } from "./visitor";

export function walk() {
  let a = b.parent;
  let b = a.next;
  while (a) {
    a.visit();
    a = b;
  }
}

export function reach() {
  const visitor = new Visitor(null as unknown as Visitor);
  const held = visitor.child;
  held.visit();
}
