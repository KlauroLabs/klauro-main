import { deriveFrameworkRole, deriveFrameworkIdentities } from '../../analyzer/core/framework-identity';
import { CASNode, CASEntryPoint, CASDependencyManifest } from '../../types/cas.types';

describe('deriveFrameworkRole', () => {
  it('assigns web role from http-shaped entry point types', () => {
    const result = deriveFrameworkRole('express', ['http', 'http'], [], []);
    expect(result.role).toBe('web');
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('assigns web role for a framework-less net/http style handler set', () => {
    // Simulates the Go net/http case: no decorators, entry points typed http.
    const result = deriveFrameworkRole('net/http', ['http', 'route'], [], []);
    expect(result.role).toBe('web');
  });

  it('assigns test role from test entry points', () => {
    const result = deriveFrameworkRole('pytest', ['test', 'test'], [], []);
    expect(result.role).toBe('test');
  });

  it('assigns di role from injection decorator category when no web signal fires', () => {
    const result = deriveFrameworkRole('inversify', [], [], ['injection']);
    expect(result.role).toBe('di');
  });

  it('assigns queue role from message exit points', () => {
    const result = deriveFrameworkRole('bullmq', [], ['message'], []);
    expect(result.role).toBe('queue');
  });

  it('falls back to other with low confidence when no evidence exists', () => {
    const result = deriveFrameworkRole('mystery-lib', [], [], []);
    expect(result.role).toBe('other');
    expect(result.confidence).toBeLessThan(0.5);
  });
});

describe('deriveFrameworkIdentities', () => {
  const baseNode = (id: string, framework: string): CASNode => ({
    id, name: id, type: 'function', category: 'code', metadata: { framework } as any,
  } as unknown as CASNode);

  it('joins a version from the dependency manifest by loose package-name match', () => {
    const nodes = [baseNode('n1', 'express')];
    const entryPoints: CASEntryPoint[] = [
      { id: 'e1', source_node: 'n1', type: 'http', name: 'GET /' } as CASEntryPoint,
    ];
    const manifest: CASDependencyManifest = {
      manifests: ['package.json'],
      total: 1,
      dependencies: [{ name: 'express', ecosystem: 'npm', version: '4.18.2', scopes: ['runtime'], declared_in: ['package.json'] }],
    };
    const identities = deriveFrameworkIdentities(['express'], nodes, entryPoints, [], [], manifest);
    expect(identities).toHaveLength(1);
    expect(identities[0].version).toBe('4.18.2');
    expect(identities[0].ecosystem).toBe('npm');
    expect(identities[0].role).toBe('web');
  });

  it('leaves version absent when no manifest is present (no guessing)', () => {
    const nodes = [baseNode('n1', 'net/http')];
    const entryPoints: CASEntryPoint[] = [
      { id: 'e1', source_node: 'n1', type: 'http', name: 'handleOrder' } as CASEntryPoint,
    ];
    const identities = deriveFrameworkIdentities(['net/http'], nodes, entryPoints, [], [], undefined);
    expect(identities[0].version).toBeUndefined();
    expect(identities[0].role).toBe('web');
  });
});
