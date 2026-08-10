// Direct-import tests for system-type.ts (task #121 extraction from
// orchestrator.ts's private `determineSystemType`). These fixtures mirror
// the `determineSystemType` describe block in
// src/__tests__/ai/orchestrator-internals.test.ts exactly, so both suites
// passing is the parity evidence that the move changed nothing: the
// orchestrator suite still calls the method through the orchestrator
// instance (now a thin delegator), this suite calls the extracted function
// directly with no orchestrator involved at all.
import { determineSystemType } from '../../analyzer/core/system-type';
import { CASEntryPoint, DeployableEvidence } from '../../types/cas.types';

function entry(partial: Partial<CASEntryPoint>): CASEntryPoint {
  return {
    id: partial.id || 'ep_1',
    source_node: partial.source_node || 'node_1',
    type: partial.type || 'http',
    name: partial.name || 'GET /thing',
    ...partial,
  } as CASEntryPoint;
}

function deployable(partial: Partial<DeployableEvidence>): DeployableEvidence {
  return {
    root_path: partial.root_path || '.',
    name: partial.name || 'unit',
    tier: partial.tier ?? 1,
    kind: partial.kind || 'container',
    evidence: partial.evidence || ['evidence'],
    ...partial,
  } as DeployableEvidence;
}

describe('determineSystemType (extracted, tier-2 module)', () => {
  it('a Go HTTP server with package-organized source and container ship evidence is a service, not a library (the reproduced live defect)', () => {
    const entryPoints = [entry({ type: 'http', name: 'GET /feeds' })];
    const deployableEvidence = [
      deployable({ tier: 1, kind: 'container', name: 'app' }),
      deployable({ tier: 3, kind: 'package', name: 'feedreader' }),
    ];
    expect(determineSystemType(entryPoints, deployableEvidence)).toBe('service');
  });

  it('package manifest identity alone, with no entry points and no ship/runnable evidence, is a genuine library', () => {
    const entryPoints: CASEntryPoint[] = [];
    const deployableEvidence = [deployable({ tier: 3, kind: 'package', name: 'left-pad' })];
    expect(determineSystemType(entryPoints, deployableEvidence)).toBe('library');
  });

  it('a frontend app with page entry points and no network entry point is an application, not a service', () => {
    const entryPoints = [entry({ type: 'page', name: '/dashboard' })];
    const deployableEvidence: DeployableEvidence[] = [];
    expect(determineSystemType(entryPoints, deployableEvidence)).toBe('application');
  });

  it('a CLI tool with a bin target and no network entry point is an application', () => {
    const entryPoints = [entry({ type: 'cli', name: 'run' })];
    const deployableEvidence = [deployable({ tier: 2, kind: 'bin', name: 'mycli' })];
    expect(determineSystemType(entryPoints, deployableEvidence)).toBe('application');
  });

  it('more than one top-level ship unit is a monorepo, regardless of entry-point shape', () => {
    const entryPoints = [entry({ type: 'http' })];
    const deployableEvidence = [
      deployable({ tier: 1, kind: 'container', name: 'api' }),
      deployable({ tier: 1, kind: 'container', name: 'worker' }),
    ];
    expect(determineSystemType(entryPoints, deployableEvidence)).toBe('monorepo');
  });

  it('a ship unit bundled into a sibling does not count toward the monorepo threshold', () => {
    const entryPoints = [entry({ type: 'http' })];
    const deployableEvidence = [
      deployable({ tier: 1, kind: 'container', name: 'api' }),
      deployable({ tier: 1, kind: 'server-entry', name: 'client-service', bundled_into: 'api' } as Partial<DeployableEvidence>),
    ];
    expect(determineSystemType(entryPoints, deployableEvidence)).toBe('service');
  });

  it('a build-stage image tier-1 row does not count toward the monorepo threshold', () => {
    const entryPoints = [entry({ type: 'http' })];
    const deployableEvidence = [
      deployable({ tier: 1, kind: 'container', name: 'app' }),
      deployable({ tier: 1, kind: 'build-image', name: 'builder' }),
    ];
    expect(determineSystemType(entryPoints, deployableEvidence)).toBe('service');
  });

  it('a repo with no entry points and no deployable evidence at all falls back to application, matching prior default behavior', () => {
    expect(determineSystemType([], [])).toBe('application');
  });

  it('an RPC entry point is treated as network-facing, same as HTTP', () => {
    const entryPoints = [entry({ type: 'rpc', name: 'UserService.Get' })];
    const deployableEvidence = [deployable({ tier: 2, kind: 'server-entry', name: 'grpc-server' })];
    expect(determineSystemType(entryPoints, deployableEvidence)).toBe('service');
  });

  it('a "test" entry point alone does not count as a runtime entry surface', () => {
    const entryPoints = [entry({ type: 'test', name: 'it renders' })];
    const deployableEvidence: DeployableEvidence[] = [];
    expect(determineSystemType(entryPoints, deployableEvidence)).toBe('application');
  });
});
