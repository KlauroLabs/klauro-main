import { once } from 'node:events';
import { Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import disassembler from 'stream-json/disassembler.js';
import stringer from 'stream-json/stringer.js';

export async function writeJsonValue(value: unknown, destination: Writable = process.stdout): Promise<void> {
  await pipeline(
    Readable.from([value]),
    disassembler.asStream({ packValues: false, streamValues: true }),
    stringer.asStream(),
    destination,
    { end: false },
  );
  if (!destination.write('\n')) await once(destination, 'drain');
}
