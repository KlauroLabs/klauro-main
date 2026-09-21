class Interned {
  private at = 0;

  private symbols: string[] = [];

  constructor(private readonly bytes: Buffer) {}

  index(): unknown {
    this.symbols = this.read() as string[];
    return this.read();
  }

  private read(): unknown {
    const tag = this.bytes.readUInt8(this.at);
    this.at += 1;
    if (tag <= 0x7f) return tag;
    if (tag >= 0xe0) return this.spoken(tag - 0x100);
    if ((tag & 0xf0) === 0x80) return this.fields(tag & 0x0f);
    if ((tag & 0xf0) === 0x90) return this.items(tag & 0x0f);
    if ((tag & 0xe0) === 0xa0) return this.text(tag & 0x1f);
    return this.tagged(tag);
  }

  private tagged(tag: number): unknown {
    switch (tag) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xca: return this.take(4, at => this.bytes.readFloatBE(at));
      case 0xcb: return this.take(8, at => this.bytes.readDoubleBE(at));
      case 0xcc: return this.unsigned(1);
      case 0xcd: return this.unsigned(2);
      case 0xce: return this.unsigned(4);
      case 0xcf: return this.take(8, at => Number(this.bytes.readBigUInt64BE(at)));
      case 0xd0: return this.spoken(this.take(1, at => this.bytes.readInt8(at)));
      case 0xd1: return this.spoken(this.take(2, at => this.bytes.readInt16BE(at)));
      case 0xd2: return this.spoken(this.take(4, at => this.bytes.readInt32BE(at)));
      case 0xd3: return this.spoken(this.take(8, at => Number(this.bytes.readBigInt64BE(at))));
      case 0xd9: return this.text(this.unsigned(1));
      case 0xda: return this.text(this.unsigned(2));
      case 0xdb: return this.text(this.unsigned(4));
      case 0xdc: return this.items(this.unsigned(2));
      case 0xdd: return this.items(this.unsigned(4));
      case 0xde: return this.fields(this.unsigned(2));
      case 0xdf: return this.fields(this.unsigned(4));
      default: throw new Error(`The index carries an unknown value at byte ${this.at - 1}.`);
    }
  }

  private spoken(number: number): unknown {
    if (number >= 0) return number;
    const symbol = this.symbols[-1 - number];
    if (symbol === undefined) {
      throw new Error(`The index names a symbol at ${-1 - number} that its table does not hold.`);
    }
    return symbol;
  }

  private take<T>(width: number, held: (at: number) => T): T {
    const found = held(this.at);
    this.at += width;
    return found;
  }

  private unsigned(width: number): number {
    return this.take(width, at => this.bytes.readUIntBE(at, width));
  }

  private text(length: number): string {
    return this.bytes.toString('utf8', this.at, (this.at += length));
  }

  private items(length: number): unknown[] {
    const found: unknown[] = new Array(length);
    for (let held = 0; held < length; held += 1) found[held] = this.read();
    return found;
  }

  private fields(length: number): Record<string, unknown> {
    const found: Record<string, unknown> = {};
    for (let held = 0; held < length; held += 1) found[String(this.read())] = this.read();
    return found;
  }
}

export function readInterned(bytes: Buffer): unknown {
  return new Interned(bytes).index();
}
