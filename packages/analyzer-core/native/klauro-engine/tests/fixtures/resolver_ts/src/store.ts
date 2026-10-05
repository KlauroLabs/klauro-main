export class Store {
  get(id: string): number {
    return id.length;
  }

  save(value: number): void {
    void value;
  }
}

export class Cache {
  get(id: string): number {
    return id.length * 2;
  }

  save(value: number): void {
    void value;
  }
}

export class Row {
  total(): number {
    return 1;
  }
}

export class Ledger {
  total(): number {
    return 2;
  }
}
