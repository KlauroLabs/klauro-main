declare module 'stream-json/filters/ignore.js' {
  import type { Duplex } from 'node:stream';

  export interface IgnoreFilterOptions {
    filter: (stack: ReadonlyArray<string | number | null>, token: unknown) => boolean;
    streamValues?: boolean;
    packValues?: boolean;
  }

  export const ignore: {
    withParserAsStream(options: IgnoreFilterOptions): Duplex;
  };
}
