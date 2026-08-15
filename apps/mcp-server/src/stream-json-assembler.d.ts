declare module 'stream-json/assembler.js' {
  export default class Assembler<T = unknown> {
    current: T | null;
    done: boolean;
    consume(token: unknown): this;
  }
}
