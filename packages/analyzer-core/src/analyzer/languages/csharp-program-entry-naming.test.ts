/**
 * A multi-project .NET solution has one `Main` per project. The C# analyzer
 * named every one of them ".NET Main entry point", so a measured 10k-node WPF
 * solution shipped 5 `cli` entry points collapsing to ONE unique name — the
 * product could not tell the Windows service host from the desktop shell.
 * The name must identify WHICH program, from real path evidence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { CSharpAnalyzer } from './csharp-analyzer';

const MAIN = [
  'namespace Demo',
  '{',
  '    public static class MainClass',
  '    {',
  '        public static void Main(string[] args)',
  '        {',
  '        }',
  '    }',
  '}',
  ''
].join('\n');

test('each project’s Main entry point gets a distinct, project-qualified name', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'csharp-program-naming-'));
  for (const project of ['HogganScientific', 'hoggan.windowservice', 'hoggan.presentation']) {
    await fs.ensureDir(path.join(dir, project));
    await fs.writeFile(path.join(dir, project, `${project}.csproj`), '<Project Sdk="Microsoft.NET.Sdk"></Project>\n');
    await fs.writeFile(path.join(dir, project, 'Main.cs'), MAIN);
  }

  const result = await new CSharpAnalyzer().analyze({ projectPath: dir } as any);
  const programs = (result.entry_points || []).filter((ep: any) => /^entry_dotnet_program_/.test(ep.id));

  assert.equal(programs.length, 3, 'one program entry point per project');
  assert.equal(new Set(programs.map((ep: any) => ep.name)).size, 3, 'names must be distinguishable');
  assert.deepEqual(
    programs.map((ep: any) => ep.name).sort(),
    [
      '.NET Main entry point: HogganScientific',
      '.NET Main entry point: hoggan.presentation',
      '.NET Main entry point: hoggan.windowservice',
    ]
  );
  // Location evidence must survive — it is what the orchestrator dedups on.
  for (const ep of programs) {
    assert.ok(ep.handler?.file, 'every program entry point carries its file');
    assert.equal(typeof ep.handler?.line, 'number');
    assert.equal(ep.handler?.method_name, 'Main');
  }

  await fs.remove(dir);
});
