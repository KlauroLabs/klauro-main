











import { spawn } from 'node:child_process';

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

async function readUnixTerminalSecret(label: string, stdout: SecretStdout): Promise<string> {
  const child = spawn('/bin/sh', ['-c', "trap 'stty echo' EXIT HUP INT TERM; stty -echo; printf '%s' \"$1\" > /dev/tty; IFS= read -r secret; status=$?; stty echo; trap - EXIT HUP INT TERM; [ $status -eq 0 ] && printf '%s' \"$secret\"; exit $status", 'klauro-secret-prompt', label], {
    stdio: ['inherit', 'pipe', 'inherit'],
  });
  const chunks: Buffer[] = [];
  child.stdout.on('data', chunk => chunks.push(Buffer.from(chunk)));
  const status = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve(code ?? 1));
  });
  stdout.write('\n');
  if (status !== 0) throw new Error('Password entry aborted');
  return Buffer.concat(chunks).toString('utf8');
}








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











export async function promptLine(
  label: string,
  stdin: NodeJS.ReadStream = process.stdin,
  stdout: NodeJS.WriteStream = process.stdout,
): Promise<string> {
  if (!stdin.isTTY) return '';


  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const answer = await new Promise<string>(resolve => rl.question(label, resolve));
  rl.close();
  return answer.trim();
}




































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
  if (process.platform !== 'win32' && stdin === process.stdin && stdout === process.stdout) {
    return readUnixTerminalSecret(label, stdout);
  }

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
          case '\u0004':
            stdout.write('\n');
            cleanup();
            resolve(value);
            return;
          case '\u0003':
            stdout.write('\n');
            cleanup();
            reject(new Error('Password entry aborted'));
            return;
          case '\u007f':
          case '\b':
            value = value.slice(0, -1);
            break;
          default:

            if (char >= ' ') value += char;
        }
      }
    };
    stdin.on('data', onData);
  });
}
