import { binaryMatchesRuntime } from '../../analyzer/core/native-parse';

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
