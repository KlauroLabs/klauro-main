import { once } from 'node:events';
import { Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const OUTPUT_CHUNK_BYTES = 64 * 1024;

function encodedScalar(value: unknown): string | undefined {
  return JSON.stringify(value);
}

function hasLargeContainer(value: Record<string, unknown>): boolean {
  return Object.entries(value).some(([key, member]) =>
    Array.isArray(member) && (member.length >= 100 || key === 'nodes' || key === 'edges' || key === 'children'));
}

function jsonValue(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const toJSON = (value as { toJSON?: () => unknown }).toJSON;
  return typeof toJSON === 'function' ? toJSON.call(value) : value;
}

function* serializeJson(value: unknown, depth = 0): Generator<string> {
  const normalized = jsonValue(value);
  if (Array.isArray(normalized)) {
    yield '[';
    for (let index = 0; index < normalized.length; index += 1) {
      if (index > 0) yield ',';
      const member = jsonValue(normalized[index]);
      if (member && typeof member === 'object' && hasLargeContainer(member as Record<string, unknown>)) {
        yield* serializeJson(member, depth + 1);
      } else {
        yield encodedScalar(member) ?? 'null';
      }
    }
    yield ']';
    return;
  }
  if (!normalized || typeof normalized !== 'object') {
    const encoded = encodedScalar(normalized);
    if (encoded !== undefined) yield encoded;
    return;
  }
  const object = normalized as Record<string, unknown>;
  if (depth >= 2 && !hasLargeContainer(object)) {
    const encoded = encodedScalar(object);
    if (encoded !== undefined) yield encoded;
    return;
  }
  yield '{';
  let emitted = false;
  for (const [key, rawMember] of Object.entries(object)) {
    const member = jsonValue(rawMember);
    const partition = Array.isArray(member) ||
      Boolean(member && typeof member === 'object' && (depth < 2 || hasLargeContainer(member as Record<string, unknown>)));
    const encoded = partition ? undefined : encodedScalar(member);
    if (!partition && encoded === undefined) continue;
    if (emitted) yield ',';
    emitted = true;
    yield `${JSON.stringify(key)}:`;
    if (partition) {
      yield* serializeJson(member, depth + 1);
    } else {
      yield encoded!;
    }
  }
  yield '}';
}

function* bufferedJson(value: unknown): Generator<string> {
  let chunks: string[] = [];
  let bytes = 0;
  for (const chunk of serializeJson(value)) {
    chunks.push(chunk);
    bytes += Buffer.byteLength(chunk);
    if (bytes < OUTPUT_CHUNK_BYTES) continue;
    yield chunks.join('');
    chunks = [];
    bytes = 0;
  }
  if (chunks.length > 0) yield chunks.join('');
}

export async function writeJsonValue(value: unknown, destination: Writable = process.stdout): Promise<void> {
  await pipeline(
    Readable.from(bufferedJson(value)),
    destination,
    { end: false },
  );
  if (!destination.write('\n')) await once(destination, 'drain');
}
