import type { CASEntryPoint, DeployableEvidence } from '../../types/cas.types';
import {
  attachDeployable,
  buildDeployableRoots,
  ensureEntryPointDescription,
  extractEntryPointFilePath,
  matchDeployableRoot,
  synthesizeEntryPointDescription,
  type CASEntryPointWithDeployable,
} from '../../analyzer/core/entry-point-deployable';

function ep(overrides: Partial<CASEntryPoint>): CASEntryPoint {
  return {
    id: 'entry:test:default',
    source_node: 'node:test:default',
    type: 'http',
    name: 'default',
    ...overrides,
  };
}

const deployableEvidence: DeployableEvidence[] = [
  // Tier-1 container: root at apps/api
  {
    root_path: 'apps/api',
    name: 'api',
    tier: 1,
    kind: 'container',
    evidence: ['Dockerfile: apps/api/Dockerfile'],
  },
  // Tier-1 container: nested app inside a package (deeper root than apps/api,
  // used to prove longest-prefix wins over a shallower sibling match).
  {
    root_path: 'apps/api/admin-app',
    name: 'admin-app',
    tier: 1,
    kind: 'container',
    evidence: ['Dockerfile: apps/api/admin-app/Dockerfile'],
  },
  // Tier-2 bin target in a completely separate package root.
  {
    root_path: 'packages/worker',
    name: 'worker',
    tier: 2,
    kind: 'bin',
    evidence: ['Cargo.toml [[bin]] worker'],
  },
];

describe('buildDeployableRoots', () => {
  it('produces one deterministic root per evidence entry with stable ids', () => {
    const roots = buildDeployableRoots(deployableEvidence);
    expect(roots).toHaveLength(3);
    expect(roots.map(r => r.rootPath)).toEqual(['apps/api', 'apps/api/admin-app', 'packages/worker']);
    // deterministic: re-running on the same input yields identical ids
    const rootsAgain = buildDeployableRoots(deployableEvidence);
    expect(rootsAgain).toEqual(roots);
  });

  it('returns an empty list when there is no evidence', () => {
    expect(buildDeployableRoots(undefined)).toEqual([]);
    expect(buildDeployableRoots([])).toEqual([]);
  });
});

describe('extractEntryPointFilePath', () => {
  it('prefers handler.file when present', () => {
    const e = ep({ handler: { node_id: 'n', method_name: 'm', file: 'apps/api/src/routes/users.ts' } });
    expect(extractEntryPointFilePath(e)).toBe('apps/api/src/routes/users.ts');
  });

  it('falls back to parsing a real path out of source_node', () => {
    const e = ep({
      id: 'entry:main:packages/worker/src/main.rs',
      source_node: 'function:packages/worker/src/main.rs:main',
    });
    expect(extractEntryPointFilePath(e)).toBe('packages/worker/src/main.rs');
  });

  it('returns undefined when no real path is recoverable (mangled id)', () => {
    const e = ep({
      id: 'entry_apps_api_admin_app_helm_Service_80_f4b66bac',
      source_node: 'helm_template_resource_apps_api_admin_app_Service_2_5c142bf5',
    });
    expect(extractEntryPointFilePath(e)).toBeUndefined();
  });
});

describe('matchDeployableRoot / attachDeployable', () => {
  const roots = buildDeployableRoots(deployableEvidence);

  it('picks the longest matching prefix when roots are nested', () => {
    const match = matchDeployableRoot('apps/api/admin-app/src/routes/users.ts', roots);
    expect(match?.deployable_name).toBe('admin-app');
  });

  it('matches the shallower root when the file is outside the nested one', () => {
    const match = matchDeployableRoot('apps/api/src/routes/orders.ts', roots);
    expect(match?.deployable_name).toBe('api');
  });

  it('matches an unrelated sibling root correctly', () => {
    const match = matchDeployableRoot('packages/worker/src/queue.ts', roots);
    expect(match?.deployable_name).toBe('worker');
  });

  it('returns undefined for a file under no known root', () => {
    const match = matchDeployableRoot('legacy/scripts/one-off.ts', roots);
    expect(match).toBeUndefined();
  });

  it('attaches deployable_id/name to entry points that resolve, leaves others unset', () => {
    const entryPoints: CASEntryPoint[] = [
      ep({
        id: 'entry_http_apps_api_admin_app_users',
        name: 'usersRoute',
        handler: { node_id: 'n1', method_name: 'usersRoute', file: 'apps/api/admin-app/src/routes/users.ts' },
      }),
      ep({
        id: 'entry_http_apps_api_orders',
        name: 'ordersRoute',
        handler: { node_id: 'n2', method_name: 'ordersRoute', file: 'apps/api/src/routes/orders.ts' },
      }),
      ep({
        id: 'entry:main:packages/worker/src/main.rs',
        source_node: 'function:packages/worker/src/main.rs:main',
        name: 'main',
        type: 'cli',
      }),
      ep({
        id: 'entry_http_legacy_one_off',
        name: 'oneOff',
        handler: { node_id: 'n3', method_name: 'oneOff', file: 'legacy/scripts/one-off.ts' },
      }),
    ];

    const result = attachDeployable(entryPoints, deployableEvidence);

    expect(result[0].deployable_name).toBe('admin-app');
    expect(result[0].deployable_id).toBeDefined();
    expect(result[1].deployable_name).toBe('api');
    expect(result[2].deployable_name).toBe('worker');

    // no match -> left unset, not guessed
    expect(result[3].deployable_id).toBeUndefined();
    expect(result[3].deployable_name).toBeUndefined();

    // distinct roots get distinct ids
    expect(result[0].deployable_id).not.toBe(result[1].deployable_id);
    expect(result[1].deployable_id).not.toBe(result[2].deployable_id);

    // does not mutate the input array's objects
    expect((entryPoints[0] as CASEntryPointWithDeployable).deployable_id).toBeUndefined();
  });

  it('returns entry points unchanged (deep-copied) when there is no evidence at all', () => {
    const entryPoints: CASEntryPoint[] = [ep({ id: 'e1', name: 'e1' })];
    const result = attachDeployable(entryPoints, undefined);
    expect(result).toEqual(entryPoints);
    expect(result[0]).not.toBe(entryPoints[0]);
  });
});

describe('synthesizeEntryPointDescription', () => {
  it('builds an HTTP description from method + path + name', () => {
    const e = ep({ type: 'http', name: 'getUsers', trigger: { method: 'GET', path: '/api/users' } });
    expect(synthesizeEntryPointDescription(e)).toBe('GET /api/users endpoint — getUsers');
  });

  it('builds a schedule description from the cron expression', () => {
    const e = ep({ type: 'schedule', name: 'scheduledScan', trigger: { schedule: 'EVERY_HOUR' } });
    expect(synthesizeEntryPointDescription(e)).toBe('Scheduled job (EVERY_HOUR) — scheduledScan');
  });

  it('builds a message description from the entry point name alone', () => {
    const e = ep({ type: 'message', name: 'analyze_codebase' });
    expect(synthesizeEntryPointDescription(e)).toBe('Handles the analyze_codebase message');
  });

  it('builds a CLI description from the command name', () => {
    const e = ep({ type: 'cli', name: 'main' });
    expect(synthesizeEntryPointDescription(e)).toBe('CLI command main');
  });
});

describe('ensureEntryPointDescription', () => {
  it('preserves an existing description and tags it deterministic when untagged', () => {
    const e = ep({ description: 'Program entry point' });
    const [result] = ensureEntryPointDescription([e]);
    expect(result.description).toBe('Program entry point');
    expect(result.description_source).toBe('deterministic');
  });

  it('leaves an already-tagged description source untouched', () => {
    const e = ep({ description: 'Hand-written summary', description_source: 'manual' });
    const [result] = ensureEntryPointDescription([e]);
    expect(result.description).toBe('Hand-written summary');
    expect(result.description_source).toBe('manual');
  });

  it('synthesizes a deterministic description when missing', () => {
    const e = ep({ type: 'http', name: 'getOrders', trigger: { method: 'GET', path: '/orders' } });
    const [result] = ensureEntryPointDescription([e]);
    expect(result.description).toBe('GET /orders endpoint — getOrders');
    expect(result.description_source).toBe('deterministic');
  });

  it('treats a blank/whitespace-only description as missing', () => {
    const e = ep({ type: 'cli', name: 'build', description: '   ' });
    const [result] = ensureEntryPointDescription([e]);
    expect(result.description).toBe('CLI command build');
    expect(result.description_source).toBe('deterministic');
  });

  it('does not mutate the input entry points', () => {
    const e = ep({ type: 'cli', name: 'build' });
    ensureEntryPointDescription([e]);
    expect(e.description).toBeUndefined();
  });
});
