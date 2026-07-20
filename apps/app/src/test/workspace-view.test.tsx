import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { WorkspaceView } from '../main';
import type { AppStateData, Workspace } from '../api';

const workspace: Workspace = { id: 'ws1', name: 'Acme', role: 'owner', project_count: 2, user_count: 1 };

const data: AppStateData = {
  user: { id: 'u1', email: 'a@b.com' },
  workspaces: [
    workspace,
    { id: 'ws2', name: 'Other', role: 'member', project_count: 1, user_count: 1 },
  ],
  projectsByWorkspace: {
    ws1: [
      { id: 'p1', name: 'core', workspace_id: 'ws1' },
      { id: 'p2', name: 'billing', workspace_id: 'ws1' },
    ],
    ws2: [{ id: 'p3', name: 'legacy', workspace_id: 'ws2' }],
  },
  membersByWorkspace: {},
  revisionsByProject: {},
};

function baseProps(overrides: Partial<React.ComponentProps<typeof WorkspaceView>> = {}) {
  return {
    token: 'tok',
    workspace,
    data,
    projects: data.projectsByWorkspace.ws1,
    members: [],
    revisionsByProject: {},
    onProject: vi.fn(),
    onAddProject: vi.fn(),
    onAddMember: vi.fn(),
    onRefresh: vi.fn(async () => {}),
    ...overrides,
  };
}

/** Path-keyed fetch mock. Each route holds a queue of response bodies: every
 *  call shifts the next one off the front, except the last item, which
 *  repeats forever once reached — lets a test express "then it advances"
 *  without having to predict exactly how many times a route is polled. */
function mockFetch(routes: Record<string, unknown[]>) {
  const stub = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const queue = routes[path];
    if (!queue || !queue.length) throw new Error(`Unhandled fetch in test: ${path}`);
    const body = queue.length > 1 ? queue.shift() : queue[0];
    return { ok: true, json: async () => body } as Response;
  });
  vi.stubGlobal('fetch', stub);
  return stub;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WorkspaceView envelope + deployables', () => {
  it('reads applications from analysis.applications (never the response root) and excludes merged_into rows', async () => {
    mockFetch({
      '/api/workspaces/ws1/analysis': [
        {
          status: 'ready',
          workspace_id: 'ws1',
          generated_at: '2026-07-20T00:00:00.000Z',
          member_project_ids: ['p1', 'p2'],
          member_project_names: ['core', 'billing'],
          enrichment: { status: 'ai' },
          analysis: {
            workspace_narrative: { title: 'Acme system' },
            health: {},
            codebases: [
              { id: 'cb1', name: 'core' },
              { id: 'cb2', name: 'billing' },
            ],
            applications: [
              { id: 'app1', codebase_id: 'cb1', name: 'Core API', kind: 'service', ports: ['8080'], also_declared_by: ['cb2'] },
              { id: 'app2', codebase_id: 'cb2', name: 'Billing worker', kind: 'worker', merged_into: 'app1' },
            ],
            runtime_components: [],
            runtime_links: [],
            application_links: [],
            summary: {},
          },
          // Regression bait: a probe-bug class where a caller reads
          // top-level fields instead of destructuring the `analysis` envelope.
          // This must NEVER be rendered.
          applications: [{ id: 'bogus', name: 'ROOT-LEVEL-BOGUS-APP', codebase_id: 'x' }],
        },
      ],
    });

    render(<WorkspaceView {...baseProps()} />);

    await waitFor(() => expect(screen.getByText('Core API')).toBeInTheDocument());
    expect(screen.queryByText('ROOT-LEVEL-BOGUS-APP')).not.toBeInTheDocument();
    // merged_into row excluded from the list…
    expect(screen.queryByText('Billing worker')).not.toBeInTheDocument();
    // …its identity folded into the survivor's "also declared by" line instead.
    expect(screen.getByText(/also declared by billing/i)).toBeInTheDocument();
  });
});

describe('WorkspaceView enrichment state', () => {
  it('shows a degraded notice with a rebuild button, and rebuilding clears it once the poll advances', async () => {
    mockFetch({
      '/api/workspaces/ws1/analysis': [
        {
          status: 'ready',
          workspace_id: 'ws1',
          generated_at: '2026-07-20T00:00:00.000Z',
          enrichment: { status: 'degraded', reason: 'no AI provider configured' },
          analysis: { applications: [], runtime_components: [], runtime_links: [], codebases: [], summary: {} },
        },
        {
          status: 'ready',
          workspace_id: 'ws1',
          generated_at: '2026-07-20T01:00:00.000Z',
          enrichment: { status: 'ai' },
          analysis: { applications: [], runtime_components: [], runtime_links: [], codebases: [], summary: {} },
        },
      ],
      '/api/workspaces/ws1/reanalyze': [{ status: 'accepted', workspace_id: 'ws1' }],
    });

    render(<WorkspaceView {...baseProps()} />);

    const rebuildButton = await screen.findByRole('button', { name: /rebuild analysis/i });
    expect(screen.getByText(/no AI provider configured/i)).toBeInTheDocument();

    fireEvent.click(rebuildButton);

    await waitFor(() => expect(screen.queryByText(/no AI provider configured/i)).not.toBeInTheDocument());
  });
});

describe('WorkspaceView attach project', () => {
  it('attaches an existing project from another workspace and surfaces the move', async () => {
    mockFetch({
      '/api/workspaces/ws1/analysis': [
        { status: 'none', workspace_id: 'ws1' },
        { status: 'none', workspace_id: 'ws1' },
      ],
      '/api/workspaces/ws1/projects': [
        {
          attached: true,
          already_attached: false,
          project: { id: 'p3', name: 'legacy', workspace_id: 'ws1' },
          semantics: 'move',
          moved_from_workspace_id: 'ws2',
          was_rebuild: 'unchanged',
        },
      ],
    });

    const onRefresh = vi.fn(async () => {});
    render(<WorkspaceView {...baseProps({ onRefresh })} />);

    fireEvent.click(await screen.findByRole('button', { name: /attach existing project/i }));
    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'p3' } });
    fireEvent.click(screen.getByRole('button', { name: /^attach$/i }));

    await waitFor(() => expect(screen.getByText(/moved legacy into this workspace/i)).toBeInTheDocument());
    expect(onRefresh).toHaveBeenCalled();
  });
});
