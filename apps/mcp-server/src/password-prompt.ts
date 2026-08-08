/**
 * Secret-input helpers for the CLI. Kept in a dedicated module so they can be
 * unit-tested without importing cli.ts (whose module side-effect runs main()).
 *
 * SECURITY CONTRACT for every function here:
 *  - Typed/pasted characters are NEVER echoed to stdout.
 *  - The captured secret is NEVER logged, written to disk, or returned in an
 *    error message. Callers store only the exchanged session token, never the
 *    password itself.
 */

/** Minimal surface of the stdin/stdout streams these helpers touch. */
export interface SecretStdin {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  setEncoding?: (encoding: BufferEncoding) => unknown;
  resume?: () => unknown;
  pause?: () => unknown;
  on: (event: 'data', listener: (chunk: string) => void) => unknown;
  removeListener: (event: 'data', listener: (chunk: string) => void) => unknown;
  readableEncoding?: BufferEncoding | null;
  [Symbol.asyncIterator]?: () => AsyncIterableIterator<string | Buffer>;
}

export interface SecretStdout {
  write: (chunk: string) => unknown;
}

/**
 * Read a full stdin stream to a string, trimming only a single trailing
 * newline a shell/pipe appends. Used for `--password-stdin`:
 *   printf '%s' "$PW" | klauro login --email x --password-stdin
 * Interior characters (a password may contain spaces) are preserved. The value
 * is never echoed.
 */
export async function readAllStdin(
  stdin: SecretStdin = process.stdin as unknown as SecretStdin,
): Promise<string> {
  const iterator = stdin[Symbol.asyncIterator];
  if (!iterator) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of iterator.call(stdin)) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

/**
 * Read one non-secret line from an interactive TTY (echo ON — used for the
 * `Email:` prompt, never for a password). Shared by cli.ts and
 * installed-cli.ts so the two entry points' `login` prompting can't drift the
 * way their `auth-status`/`whoami` implementations once did.
 *
 * Non-TTY stdin returns '' immediately so a caller can fall back to a flag
 * (`--email`) and fail with a clear message instead of hanging waiting for
 * input that will never come.
 */
export async function promptLine(
  label: string,
  stdin: NodeJS.ReadStream = process.stdin,
  stdout: NodeJS.WriteStream = process.stdout,
): Promise<string> {
  if (!stdin.isTTY) return '';
  // Lazy import: readline pulls in more than this module needs for the
  // common (non-interactive/scripted) path.
  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const answer = await new Promise<string>(resolve => rl.question(label, resolve));
  rl.close();
  return answer.trim();
}

/**
 * Read a secret from an interactive TTY with echo OFF. Prints `label`, puts the
 * terminal into raw mode so NOTHING typed or pasted is echoed, reads until
 * Enter, then emits one newline so the cursor advances. Ctrl-C aborts, Ctrl-D
 * finishes, Backspace/DEL edit. Raw mode + prior encoding are always restored.
 *
 * Non-TTY stdin (or a platform without setRawMode) returns '' so the caller can
 * fall back to --password / --password-stdin and fail with a clear message
 * rather than hang or echo.
 */
export async function promptPassword(
  label: string,
  stdin: SecretStdin = process.stdin as unknown as SecretStdin,
  stdout: SecretStdout = process.stdout as unknown as SecretStdout,
): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') return '';

  stdout.write(label);
  const wasRaw = Boolean(stdin.isRaw);
  stdin.setRawMode(true);
  stdin.resume?.();
  const prevEncoding = stdin.readableEncoding ?? undefined;
  stdin.setEncoding?.('utf8');

  return await new Promise<string>((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode?.(wasRaw);
      if (prevEncoding) stdin.setEncoding?.(prevEncoding);
      stdin.pause?.();
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        switch (char) {
          case '\n':
          case '\r':
          case '\u0004': // Ctrl-D / EOT — finish input
            stdout.write('\n');
            cleanup();
            resolve(value);
            return;
          case '\u0003': // Ctrl-C — abort
            stdout.write('\n');
            cleanup();
            reject(new Error('Password entry aborted'));
            return;
          case '\u007f': // DEL
          case '\b':     // Backspace
            value = value.slice(0, -1);
            break;
          default:
            // Never echo any input. Ignore control characters below space.
            if (char >= ' ') value += char;
        }
      }
    };
    stdin.on('data', onData);
  });
}
