import { Row, Store } from './store';

export function sumEach(rows: Row[]): number {
  let sum = 0;
  rows.forEach(row => {
    sum += row.total();
  });
  return sum;
}

export function sumLoop(rows: Row[]): number {
  let sum = 0;
  for (const row of rows) {
    sum += row.total();
  }
  return sum;
}

export function captured(store: Store, ids: string[]): void {
  ids.forEach(id => {
    store.save(store.get(id));
  });
}

export function shadowed(store: Store, rows: Row[]): number {
  return rows.map(store => store.total()).length;
}

export function literals(name: string): boolean {
  return /^a+$/.test(name) && ['x', 'y'].includes(name);
}
