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

  it('package manifest identity does NOT make a library when something can still invoke the code', () => {
    const entryPoints = [entry({ type: 'cli', name: 'build' })];
    const deployableEvidence = [deployable({ tier: 3, kind: 'package', name: 'toolkit' })];
    expect(determineSystemType(entryPoints, deployableEvidence)).toBe('application');
  });

  it('package manifest identity does NOT make a library when the repo also ships or runs something', () => {
    const deployableEvidence = [
      deployable({ tier: 3, kind: 'package', name: 'toolkit' }),
      deployable({ tier: 2, kind: 'bin', name: 'toolkit-cli' }),
    ];
    expect(determineSystemType([], deployableEvidence)).toBe('application');
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

  it('a package whose ONLY entry points are lifecycle hooks is a library, not an application', () => {
    // Measured live 2026-08-11 on a real npm library (`main`, no `bin`, 300 nodes):
    // entry_points_by_type was exactly {lifecycle: 2} — module-init hooks — and
    // those tipped hasRuntimeEntryPoint, so it typed as 'application' and the
    // tier-3 library branch became unreachable.
    //
    // The consequence was customer-visible and not local: the AI was asked to
    // describe an "application" with no way to invoke it, reached for compound
    // modifiers to cover the gap ("interacts-local"), and the grounding gate
    // correctly rejected the fabrication — publishing a BLANK system description
    // and domain: null. A lifecycle hook is something the runtime calls at load,
    // not a way a user invokes the system.
    const entryPoints = [
      entry({ type: 'lifecycle', name: 'onModuleInit' }),
      entry({ type: 'lifecycle', name: 'onModuleDestroy' }),
    ];
    const deployableEvidence = [deployable({ tier: 3, kind: 'package', name: 'wired-up' })];
    expect(determineSystemType(entryPoints, deployableEvidence)).toBe('library');
  });

  it('a lifecycle hook does not suppress a REAL entry surface that sits beside it', () => {
    // The exclusion must not swing the other way: a service that happens to
    // declare lifecycle hooks is still a service.
    const entryPoints = [
      entry({ type: 'lifecycle', name: 'onModuleInit' }),
      entry({ type: 'http', name: 'GET /health' }),
    ];
    expect(determineSystemType(entryPoints, [])).toBe('service');
  });

  it('lifecycle hooks with ship evidence but no package identity stay an application', () => {
    // Without tier-3 package identity there is nothing to justify 'library', and
    // tier-1/2 ship evidence means it demonstrably runs — so 'application' remains
    // the honest answer rather than defaulting everything to library.
    const entryPoints = [entry({ type: 'lifecycle', name: 'onBoot' })];
    const deployableEvidence = [deployable({ tier: 1, kind: 'container', name: 'worker' })];
    expect(determineSystemType(entryPoints, deployableEvidence)).toBe('application');
  });
});
