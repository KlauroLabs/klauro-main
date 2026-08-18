declare module 'stream-json/disassembler.js' {
  import type { Duplex, DuplexOptions } from 'node:stream';

  interface DisassemblerOptions extends DuplexOptions {
    packValues?: boolean;
    streamValues?: boolean;
  }

  interface Disassembler {
    (options?: DisassemblerOptions): (value: unknown) => Generator<unknown, void, undefined>;
    asStream(options?: DisassemblerOptions): Duplex;
  }

  const disassembler: Disassembler;
  export default disassembler;
}

declare module 'stream-json/stringer.js' {
  import type { Duplex, DuplexOptions } from 'node:stream';

  interface StringerOptions extends DuplexOptions {
    useValues?: boolean;
  }

  interface Stringer {
    (options?: StringerOptions): (token: unknown) => unknown;
    asStream(options?: StringerOptions): Duplex;
  }

  const stringer: Stringer;
  export default stringer;
}
