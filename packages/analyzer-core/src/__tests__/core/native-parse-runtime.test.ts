import fs = require('fs');
import * as os from 'os';
import * as path from 'path';
import { binaryMatchesRuntime, hasCompatibleNativeParserBinary, resolveNativeParserBinary } from '../../analyzer/core/native-parse';

function executableHeader(): Buffer {
  const header = Buffer.alloc(32);
  if (process.platform === 'linux') {
    header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
    header.writeUInt16LE(process.arch === 'arm64' ? 183 : 62, 18);
  } else if (process.platform === 'darwin') {
    header.set([0xcf, 0xfa, 0xed, 0xfe]);
    header.writeUInt32LE(process.arch === 'arm64' ? 0x0100000c : 0x01000007, 4);
  } else {
    header.set([0x4d, 0x5a]);
  }
  return header;
}

describe('native parser artifact resolution', () => {
  let directory: string;
  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-native-path-')); });
  afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

  it('reads only the 32-byte executable header, not the whole parser binary', () => {
    const file = path.join(directory, 'parser');
    fs.writeFileSync(file, executableHeader(), { mode: 0o755 });
    fs.truncateSync(file, 64 * 1024 * 1024);
    const reads = jest.spyOn(fs, 'readSync');
    try {
      expect(hasCompatibleNativeParserBinary(file)).toBe(true);
      expect(reads).toHaveBeenCalledTimes(1);
      expect((reads.mock.calls[0] as unknown[]).slice(2)).toEqual([0, 32, 0]);
    } finally {
      reads.mockRestore();
    }
  });

  it('rejects absent, truncated, non-executable and incompatible artifacts', () => {
    const file = path.join(directory, 'parser');
    expect(hasCompatibleNativeParserBinary(file)).toBe(false);
    expect(hasCompatibleNativeParserBinary(directory)).toBe(false);
    fs.writeFileSync(file, executableHeader().subarray(0, 8), { mode: 0o755 });
    expect(hasCompatibleNativeParserBinary(file)).toBe(false);
    fs.writeFileSync(file, Buffer.alloc(32));
    expect(hasCompatibleNativeParserBinary(file)).toBe(false);
    fs.writeFileSync(file, executableHeader());
    if (process.platform !== 'win32') {
      fs.chmodSync(file, 0o644);
      expect(hasCompatibleNativeParserBinary(file)).toBe(false);
    }
  });

  it('resolves a compatible bundled artifact before the source-tree fallback', () => {
    const moduleDirectory = path.join(directory, 'source', 'analyzer', 'core');
    const bundled = path.join(moduleDirectory, 'native', 'klauro-parse');
    const source = path.join(directory, 'native', 'klauro-parse', 'target', 'release', 'klauro-parse');
    for (const file of [bundled, source]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, executableHeader(), { mode: 0o755 });
    }
    expect(resolveNativeParserBinary(moduleDirectory)).toBe(bundled);
    fs.writeFileSync(bundled, Buffer.alloc(32));
    expect(resolveNativeParserBinary(moduleDirectory)).toBe(source);
    fs.unlinkSync(bundled);
    fs.unlinkSync(source);
    expect(resolveNativeParserBinary(moduleDirectory)).toBeNull();
  });
});

describe('native parser runtime compatibility', () => {
  it('rejects executable formats built for another operating system', () => {
    const elf = Buffer.alloc(32);
    elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
    elf.writeUInt16LE(process.arch === 'arm64' ? 183 : 62, 18);

    const macho = Buffer.alloc(32);
    macho.set([0xcf, 0xfa, 0xed, 0xfe]);
    macho.writeUInt32LE(process.arch === 'arm64' ? 0x0100000c : 0x01000007, 4);

    if (process.platform === 'linux') {
      expect(binaryMatchesRuntime(elf)).toBe(true);
      expect(binaryMatchesRuntime(macho)).toBe(false);
    } else if (process.platform === 'darwin') {
      expect(binaryMatchesRuntime(macho)).toBe(true);
      expect(binaryMatchesRuntime(elf)).toBe(false);
    }
  });

  it('rejects an executable for another architecture', () => {
    if (process.platform !== 'linux') return;
    const elf = Buffer.alloc(32);
    elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
    elf.writeUInt16LE(process.arch === 'arm64' ? 62 : 183, 18);
    expect(binaryMatchesRuntime(elf)).toBe(false);
  });
});
