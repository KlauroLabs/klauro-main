import test from 'node:test';
import assert from 'node:assert/strict';

import { promptPassword, readAllStdin, type SecretStdin, type SecretStdout } from './password-prompt';

/**
 * Regression guard for a real credential-exposure bug: `klauro login` used to
 * read the password with an echoing readline prompt, printing it in plaintext
 * ("Password: hunter2") to the terminal. These tests pin the no-echo contract:
 * raw mode ON, typed characters NEVER written to stdout, and --password-stdin
 * reads the piped secret intact.
 */

function makeStdout() {
  const writes: string[] = [];
  const stdout: SecretStdout = { write: (chunk: string) => { writes.push(chunk); return true; } };
  return { stdout, writes };
}

/**
 * A fake interactive TTY stdin that records rawMode transitions and replays a
 * scripted sequence of data chunks on the next tick after a `data` listener
 * attaches.
 */
function makeTtyStdin(chunks: string[]) {
  let listener: ((chunk: string) => void) | undefined;
  const rawHistory: boolean[] = [];
  const stdin: SecretStdin = {
    isTTY: true,
    isRaw: false,
    readableEncoding: null,
    setRawMode(mode: boolean) { this.isRaw = mode; rawHistory.push(mode); return this; },
    setEncoding() { return this; },
    resume() { return this; },
    pause() { return this; },
    on(event, cb) {
      if (event === 'data') {
        listener = cb;
        setImmediate(() => { for (const c of chunks) listener?.(c); });
      }
      return this;
    },
    removeListener() { listener = undefined; return this; },
  };
  return { stdin, rawHistory };
}

test('promptPassword reads with echo OFF and enables raw mode', async () => {
  const { stdout, writes } = makeStdout();
  // "s3cret" typed, then Enter.
  const { stdin, rawHistory } = makeTtyStdin(['s', '3', 'c', 'r', 'e', 't', '\r']);

  const result = await promptPassword('Password: ', stdin, stdout);

  assert.equal(result, 's3cret');
  // Raw mode must have been turned on (no-echo), then restored to false.
  assert.deepEqual(rawHistory, [true, false]);
  // The ONLY things written to stdout are the label and a trailing newline —
  // never any of the typed characters.
  assert.deepEqual(writes, ['Password: ', '\n']);
  const echoed = writes.join('');
  assert.ok(!echoed.includes('s3cret'), 'password must never be echoed');
});

test('promptPassword preserves interior spaces and does not echo them', async () => {
  const { stdout, writes } = makeStdout();
  const { stdin } = makeTtyStdin(['a', ' ', 'b', '\n']);
  const result = await promptPassword('Password: ', stdin, stdout);
  assert.equal(result, 'a b');
  assert.ok(!writes.join('').includes('a b'));
});

test('promptPassword handles backspace/DEL without echo', async () => {
  const { stdout } = makeStdout();
  const { stdin } = makeTtyStdin(['a', 'b', '\u007f', 'c', '\r']); // ab<DEL>c -> "ac"
  const result = await promptPassword('Password: ', stdin, stdout);
  assert.equal(result, 'ac');
});

test('promptPassword aborts on Ctrl-C', async () => {
  const { stdout } = makeStdout();
  const { stdin } = makeTtyStdin(['a', '\u0003']);
  await assert.rejects(() => promptPassword('Password: ', stdin, stdout), /aborted/i);
});

test('promptPassword returns empty on non-TTY stdin (no hang, no echo)', async () => {
  const { stdout, writes } = makeStdout();
  const stdin: SecretStdin = {
    isTTY: false,
    on() { throw new Error('should not attach a data listener on non-TTY'); },
    removeListener() { return this; },
  };
  const result = await promptPassword('Password: ', stdin, stdout);
  assert.equal(result, '');
  assert.deepEqual(writes, []);
});

test('readAllStdin reads a piped secret and trims only the trailing newline', async () => {
  const chunks = ['sup3r', ' secret\n'];
  const stdin: SecretStdin = {
    on() { return this; },
    removeListener() { return this; },
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield Buffer.from(c); },
  };
  const result = await readAllStdin(stdin);
  assert.equal(result, 'sup3r secret');
});

test('readAllStdin preserves interior newlines, trims one trailing CRLF', async () => {
  const stdin: SecretStdin = {
    on() { return this; },
    removeListener() { return this; },
    async *[Symbol.asyncIterator]() { yield Buffer.from('line1\nline2\r\n'); },
  };
  assert.equal(await readAllStdin(stdin), 'line1\nline2');
});
