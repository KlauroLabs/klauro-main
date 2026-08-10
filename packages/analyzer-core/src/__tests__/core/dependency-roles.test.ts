import { deriveDependencyRoles } from '../../analyzer/core/dependency-roles';
import { CASDependencyManifest, CASExitPoint } from '../../types/cas.types';

function manifest(names: string[]): CASDependencyManifest {
  return {
    manifests: ['package.json'],
    total: names.length,
    dependencies: names.map(name => ({ name, ecosystem: 'npm' as const, scopes: ['runtime' as const], declared_in: ['package.json'] })),
  };
}

describe('deriveDependencyRoles', () => {
  it('assigns http-client role from an outbound HTTP exit point (evidence-grounded)', () => {
    const exitPoints: CASExitPoint[] = [
      {
        id: 'exit_1', source_node: 'n1', type: 'api', name: 'GET /users',
        metadata: { library: 'axios' },
      } as CASExitPoint,
    ];
    const roles = deriveDependencyRoles(manifest(['axios']), exitPoints);
    expect(roles).toHaveLength(1);
    expect(roles[0].role).toBe('http-client');
    expect(roles[0].source).toBe('exit-point-evidence');
    expect(roles[0].evidence[0]).toContain('exit_1');
  });

  it('assigns message-broker role from a messaging exit point', () => {
    const exitPoints: CASExitPoint[] = [
      { id: 'exit_2', source_node: 'n2', type: 'message', name: 'publish', metadata: { system: 'kafka' } } as CASExitPoint,
    ];
    const roles = deriveDependencyRoles(manifest(['kafka-node']), exitPoints);
    expect(roles[0].role).toBe('message-broker');
    expect(roles[0].source).toBe('exit-point-evidence');
  });

  it('falls back to the small known-package registry when no exit-point evidence exists', () => {
    const roles = deriveDependencyRoles(manifest(['typeorm']), []);
    expect(roles[0].role).toBe('orm');
    expect(roles[0].source).toBe('known-package-list');
    expect(roles[0].confidence).toBeLessThan(0.9);
  });

  it('leaves an unrecognized dependency unclassified rather than guessing', () => {
    const roles = deriveDependencyRoles(manifest(['some-internal-utility-lib']), []);
    expect(roles).toHaveLength(0);
  });

  it('returns nothing when there is no dependency manifest', () => {
    expect(deriveDependencyRoles(undefined, [])).toEqual([]);
  });
});
