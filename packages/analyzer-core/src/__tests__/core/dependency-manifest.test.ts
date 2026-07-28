import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildDependencyManifest } from '../../analyzer/core/dependency-manifest';

/**
 * Camp-B fact: the FULL declared-dependency manifest. These tests assert the
 * extractor is repo-agnostic (raw names, no interpretation), recursive across
 * nested manifests, multi-ecosystem, and deterministic. The defining-dependency
 * regression (ccxt/web3 never surfaced because only recognized frameworks were)
 * is covered directly.
 */
describe('buildDependencyManifest', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-depmanifest-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function write(rel: string, content: string): void {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  it('returns undefined when no manifest files exist', () => {
    fs.writeFileSync(path.join(root, 'README.md'), '# nothing');
    expect(buildDependencyManifest(root)).toBeUndefined();
  });

  it('surfaces EVERY declared dependency name, not just recognized frameworks (ccxt/web3 regression)', () => {
    write('package.json', JSON.stringify({
      dependencies: { ccxt: '^4.2.26', '@nestjs/core': '^10.0.0' },
      devDependencies: { vitest: '^1.0.0' },
    }));
    write('blockchains/package.json', JSON.stringify({
      dependencies: { web3: '^4.2.0' },
    }));

    const manifest = buildDependencyManifest(root)!;
    const names = manifest.dependencies.map(d => d.name);
    expect(names).toContain('ccxt');
    expect(names).toContain('web3');
    expect(names).toContain('@nestjs/core');
    expect(names).toContain('vitest');
    expect(manifest.total).toBe(names.length);
  });

  it('records scope, version, ecosystem, and declaring manifest per dependency', () => {
    write('package.json', JSON.stringify({
      dependencies: { ccxt: '^4.2.26' },
      devDependencies: { vitest: '^1.0.0' },
      peerDependencies: { react: '^18.0.0' },
    }));
    const manifest = buildDependencyManifest(root)!;
    const ccxt = manifest.dependencies.find(d => d.name === 'ccxt')!;
    expect(ccxt.ecosystem).toBe('npm');
    expect(ccxt.version).toBe('^4.2.26');
    expect(ccxt.scopes).toEqual(['runtime']);
    expect(ccxt.declared_in).toEqual(['package.json']);
    expect(manifest.dependencies.find(d => d.name === 'vitest')!.scopes).toEqual(['dev']);
    expect(manifest.dependencies.find(d => d.name === 'react')!.scopes).toEqual(['peer']);
  });

  it('merges the same dependency declared in multiple manifests', () => {
    write('package.json', JSON.stringify({ dependencies: { ccxt: '^4.2.26' } }));
    write('apps/api/package.json', JSON.stringify({ dependencies: { ccxt: '^4.2.26' } }));
    const manifest = buildDependencyManifest(root)!;
    const ccxt = manifest.dependencies.filter(d => d.name === 'ccxt');
    expect(ccxt).toHaveLength(1);
    expect(ccxt[0].declared_in).toEqual(['apps/api/package.json', 'package.json']);
  });

  it('extracts Python requirements.txt names and version specifiers', () => {
    write('requirements.txt', ['requests==2.31.0', 'web3>=6.0.0', '# a comment', '', '-r other.txt'].join('\n'));
    const manifest = buildDependencyManifest(root)!;
    const names = manifest.dependencies.map(d => d.name);
    expect(names).toContain('requests');
    expect(names).toContain('web3');
    expect(names).not.toContain('other.txt');
    expect(manifest.dependencies.find(d => d.name === 'requests')!.version).toBe('==2.31.0');
  });

  it('extracts Cargo.toml dependencies and dev-dependencies', () => {
    write('Cargo.toml', [
      '[package]', 'name = "thing"',
      '[dependencies]', 'serde = "1.0"', 'tokio = { version = "1.35", features = ["full"] }',
      '[dev-dependencies]', 'criterion = "0.5"',
    ].join('\n'));
    const manifest = buildDependencyManifest(root)!;
    const serde = manifest.dependencies.find(d => d.name === 'serde')!;
    expect(serde.ecosystem).toBe('cargo');
    expect(serde.version).toBe('1.0');
    expect(manifest.dependencies.find(d => d.name === 'tokio')!.version).toBe('1.35');
    expect(manifest.dependencies.find(d => d.name === 'criterion')!.scopes).toEqual(['dev']);
  });

  it('extracts go.mod require blocks', () => {
    write('go.mod', [
      'module example.com/thing', 'go 1.21', '',
      'require (', '\tgithub.com/gin-gonic/gin v1.9.1', '\tgithub.com/stretchr/testify v1.8.4 // indirect', ')',
    ].join('\n'));
    const manifest = buildDependencyManifest(root)!;
    const gin = manifest.dependencies.find(d => d.name === 'github.com/gin-gonic/gin')!;
    expect(gin.ecosystem).toBe('go');
    expect(gin.version).toBe('v1.9.1');
    expect(gin.scopes).toEqual(['runtime']);
    expect(manifest.dependencies.find(d => d.name === 'github.com/stretchr/testify')!.scopes).toEqual(['build']);
  });

  it('extracts JVM, .NET, PHP, and Dart dependencies with provenance', () => {
    write('java/pom.xml', '<project><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId><version>3.4.0</version></dependency></dependencies></project>');
    write('kotlin/build.gradle.kts', 'dependencies {\n  implementation("io.ktor:ktor-server-core:3.0.0")\n  testImplementation("org.junit.jupiter:junit-jupiter:5.11.0")\n}');
    write('dotnet/App.csproj', '<Project><ItemGroup><PackageReference Include="MediatR" Version="12.4.1" /><PackageReference Include="xunit" Version="2.9.2"><PrivateAssets>all</PrivateAssets></PackageReference></ItemGroup></Project>');
    write('php/composer.json', JSON.stringify({ require: { php: '^8.3', 'laravel/framework': '^11.0' }, 'require-dev': { 'phpunit/phpunit': '^11.0' } }));
    write('dart/pubspec.yaml', ['name: app', 'dependencies:', '  flutter:', '    sdk: flutter', '  dio: ^5.7.0', 'dev_dependencies:', '  flutter_test:', '    sdk: flutter'].join('\n'));

    const manifest = buildDependencyManifest(root)!;
    const byName = new Map(manifest.dependencies.map(dependency => [dependency.name, dependency]));
    expect(byName.get('spring-boot-starter-web')).toMatchObject({ ecosystem: 'maven', version: '3.4.0', scopes: ['runtime'] });
    expect(byName.get('ktor-server-core')).toMatchObject({ ecosystem: 'gradle', version: '3.0.0', scopes: ['runtime'] });
    expect(byName.get('junit-jupiter')?.scopes).toEqual(['dev']);
    expect(byName.get('MediatR')).toMatchObject({ ecosystem: 'nuget', version: '12.4.1', scopes: ['runtime'] });
    expect(byName.get('xunit')?.scopes).toEqual(['build']);
    expect(byName.get('laravel/framework')).toMatchObject({ ecosystem: 'composer', version: '^11.0', scopes: ['runtime'] });
    expect(byName.get('phpunit/phpunit')?.scopes).toEqual(['dev']);
    expect(byName.get('flutter')).toMatchObject({ ecosystem: 'pub', scopes: ['runtime'] });
    expect(byName.get('dio')).toMatchObject({ ecosystem: 'pub', version: '^5.7.0' });
    expect(byName.get('flutter_test')?.scopes).toEqual(['dev']);
    expect(manifest.manifests).toEqual([
      'dart/pubspec.yaml', 'dotnet/App.csproj', 'java/pom.xml', 'kotlin/build.gradle.kts', 'php/composer.json',
    ]);
  });

  it('skips node_modules and dot-directories (no vendored/worktree leakage)', () => {
    write('package.json', JSON.stringify({ dependencies: { ccxt: '^4.2.26' } }));
    write('node_modules/evil/package.json', JSON.stringify({ dependencies: { malware: '1.0.0' } }));
    write('.claude/worktrees/x/package.json', JSON.stringify({ dependencies: { stale: '1.0.0' } }));
    const manifest = buildDependencyManifest(root)!;
    const names = manifest.dependencies.map(d => d.name);
    expect(names).toContain('ccxt');
    expect(names).not.toContain('malware');
    expect(names).not.toContain('stale');
    expect(manifest.manifests).toEqual(['package.json']);
  });

  it('is deterministic: same tree yields byte-identical output', () => {
    write('package.json', JSON.stringify({ dependencies: { ccxt: '^4.2.26', web3: '^4.2.0' } }));
    write('sub/package.json', JSON.stringify({ dependencies: { axios: '^1.0.0' } }));
    const a = JSON.stringify(buildDependencyManifest(root));
    const b = JSON.stringify(buildDependencyManifest(root));
    expect(a).toBe(b);
    // Names and manifests are sorted.
    const manifest = buildDependencyManifest(root)!;
    expect(manifest.dependencies.map(d => d.name)).toEqual(['axios', 'ccxt', 'web3']);
    expect(manifest.manifests).toEqual(['package.json', 'sub/package.json']);
  });
});
