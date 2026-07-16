import { describe, it, expect } from '@jest/globals';
import { CSharpAnalyzer } from '../../analyzer/languages/csharp-analyzer';

// Rung-3 Lane D follow-up (real Hoggan C# CAS): the communication-seam layer can
// only classify a device_io seam if the C# analyzer first emits an exit point for
// the SerialPort call. isExternalLibraryCall recognized a hardcoded list
// (Console/File/HttpClient/...) but NOT System.IO.Ports.SerialPort, and a bare
// `SerialPort` receiver has no dotted prefix, so `SerialPort.GetPortNames()` /
// `new SerialPort(...)` were treated as internal calls — no exit, no seam. Hoggan
// (hoggan.DeviceConnection: ComportDetails.cs, MicroFET2/3/4.cs) does exactly this.
describe('C# device I/O recognition (System.IO.Ports.SerialPort)', () => {
  const analyzer = new CSharpAnalyzer() as any;

  it('treats a bare SerialPort receiver as an external library call (so an exit point is emitted)', () => {
    expect(analyzer.isExternalLibraryCall('SerialPort', 'GetPortNames', 'hoggan.DeviceConnection')).toBe(true);
    expect(analyzer.isExternalLibraryCall('SerialPort', 'Open', 'hoggan.DeviceConnection')).toBe(true);
  });

  it('labels the SerialPort library as System.IO.Ports', () => {
    expect(analyzer.identifyCSharpLibrary('SerialPort')).toBe('System.IO.Ports');
    expect(analyzer.identifyCSharpLibrary('System.IO.Ports.SerialPort')).toBe('System.IO.Ports');
  });

  it('does not misclassify a same-namespace local type as external (no over-matching)', () => {
    expect(analyzer.isExternalLibraryCall('LocalHelper', 'Compute', 'hoggan.DeviceConnection')).toBe(false);
  });
});
