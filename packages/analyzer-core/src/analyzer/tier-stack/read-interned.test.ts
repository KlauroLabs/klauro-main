import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readInterned } from './read-interned';

function held(...parts: Array<number | string | Buffer>): Buffer {
  return Buffer.concat(
    parts.map(part => {
      if (typeof part === 'number') return Buffer.from([part]);
      if (typeof part === 'string') return Buffer.from(part, 'utf8');
      return part;
    })
  );
}

const TABLE = held(0x93, 0xa4, 'name', 0xa5, 'Order', 0xa6, 'fields');

test('a symbol is read as the word its table holds', () => {
  const index = readInterned(held(TABLE, 0x81, 0xff, 0xfe));
  assert.deepEqual(index, { name: 'Order' });
});

test('a count keeps its number and a symbol takes its word', () => {
  const index = readInterned(held(TABLE, 0x82, 0xff, 0xfe, 0xfd, 0xcd, 0x01, 0x2c));
  assert.deepEqual(index, { name: 'Order', fields: 300 });
});

test('a symbol beyond a fixed integer is read the same way', () => {
  const index = readInterned(held(TABLE, 0x81, 0xd2, 0xff, 0xff, 0xff, 0xff, 0xfe));
  assert.deepEqual(index, { name: 'Order' });
});

test('a list, a truth, an absence and a fraction each keep their kind', () => {
  const index = readInterned(
    held(TABLE, 0x81, 0xff, 0x94, 0xc3, 0xc2, 0xc0, 0xcb, Buffer.from([0x3f, 0xf0, 0, 0, 0, 0, 0, 0]))
  );
  assert.deepEqual(index, { name: [true, false, null, 1] });
});

test('a word the index did not intern is read as it stands', () => {
  const index = readInterned(held(TABLE, 0x81, 0xff, 0xd9, 0x03, 'raw'));
  assert.deepEqual(index, { name: 'raw' });
});

test('a symbol the table does not hold is refused, not guessed', () => {
  assert.throws(
    () => readInterned(held(TABLE, 0x81, 0xff, 0xe0)),
    /symbol at 31 that its table does not hold/
  );
});
