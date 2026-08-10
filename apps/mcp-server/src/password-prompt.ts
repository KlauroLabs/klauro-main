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
/**
 * First-run `login`/`login --register` error text, shared so cli.ts and
 * installed-cli.ts cannot re-diverge the way their auth-status/whoami
 * implementations once did (and the way this exact message drifted before:
 * "login requires --email and --password or --password-stdin" was the
 * FIRST sentence a brand-new user ever read from this product, on the
 * command that is supposed to be the most forgiving one in it — see
 * SPEC/defect notes for the 2026-08-09 first-run incident).
 *
 * Rules that shaped the wording:
 *  - Say what to type next, not what was missing. "requires --email" reads
 *    like a validator complaining; "run klauro login --email ..." is an
 *    instruction a non-technical reader can act on immediately.
 *  - The interactive and non-interactive cases need DIFFERENT advice: a
 *    real TTY that reached this message means the person pressed
 *    Enter/Ctrl-D without typing anything, so "try again" is the honest
 *    fix. A non-TTY (CI, a pipe, an agent shelling out) can never satisfy
 *    an interactive prompt no matter how long it waits, so the only
 *    actionable fix is the flag-based path — and it must be named
 *    explicitly (--password-stdin), not implied.
 *  - --register threads through so the printed example matches the command
 *    that was actually run; telling a --register caller to run `klauro
 *    login --email ...` (dropping --register) would silently downgrade
 *    "create an account" to "sign in to one that doesn't exist yet".
 */
export function firstRunLoginCommandExample(register: boolean): string {
  return register ? 'klauro login --register --email you@example.com --password-stdin' : 'klauro login --email you@example.com --password-stdin';
}

export function missingEmailMessage(options: { interactive: boolean; register: boolean }): string {
  const example = firstRunLoginCommandExample(options.register);
  if (options.interactive) {
    return `An email address is needed to ${options.register ? 'create your Klauro account' : 'sign in'}. Enter one at the prompt, or run: ${example}`;
  }
  return `${options.register ? 'Creating a Klauro account' : 'Signing in'} needs an email address, and this terminal can't prompt for one (it isn't interactive). Run: ${example}`;
}

export function missingPasswordMessage(options: { interactive: boolean; register: boolean }): string {
  const example = firstRunLoginCommandExample(options.register);
  if (options.interactive) {
    return `A password is needed to ${options.register ? 'create your Klauro account' : 'sign in'}. Enter one at the prompt (it will not be shown), or provide it non-interactively with --password-stdin: ${example}`;
  }
  return `${options.register ? 'Creating a Klauro account' : 'Signing in'} needs a password, and this terminal can't prompt for one (it isn't interactive). Pipe it in instead — never put a password directly on the command line: echo -n 'your-password' | ${example}`;
}

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
