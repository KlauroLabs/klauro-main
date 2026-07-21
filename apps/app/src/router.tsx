// Full route tree (react-router-dom v7) per LANE-COMMON.md: every drilldown
// level is deep-linkable. Page components are lazy() imports so a page
// lane's module resolves the moment it lands on disk without touching this
// file; a route whose module doesn't exist yet falls back to `Stub` so the
// app always builds/runs while lanes are mid-flight (LANE-COMMON's fabric
// in-flight-reuse goal). AppShell (sidebar/topbar) wraps every authenticated
// route once via a layout route; /auth renders outside the shell.
import { lazy, Suspense, type ComponentType } from 'react';
import { createBrowserRouter, Outlet } from 'react-router-dom';
import { AppShell } from './layout/AppShell';
import { RequireAuth } from './auth/RequireAuth';
import { LoadingState } from './layout/LoadingState';
import { Stub } from './pages/Stub';
import { AuthPage } from './pages/auth/AuthPage';

/** Wrap a dynamic import so a missing module (page lane not landed yet)
 *  degrades to `Stub` instead of failing the whole route tree. */
function lazyPage(area: string, loader: () => Promise<{ [key: string]: ComponentType }>, exportName: string) {
  return lazy(() =>
    loader()
      .then(mod => ({ default: mod[exportName] }))
      .catch(() => ({ default: () => <Stub area={area} /> })),
  );
}

const DashboardPage = lazyPage('Dashboard', () => import('./pages/dashboard/DashboardPage'), 'DashboardPage');
const WorkspacePage = lazyPage('Workspace', () => import('./pages/workspace/WorkspacePage'), 'WorkspacePage');
const WorkspaceMapPage = lazyPage('Workspace system map', () => import('./pages/workspace/WorkspaceMapPage'), 'WorkspaceMapPage');
const CodebasePage = lazyPage('Codebase overview', () => import('./pages/codebase/CodebasePage'), 'CodebasePage');
const CodebaseOverview = lazyPage('Overview', () => import('./pages/codebase/CodebaseOverview'), 'CodebaseOverview');
const CodebaseCapabilities = lazyPage('Capabilities', () => import('./pages/codebase/CodebaseCapabilities'), 'CodebaseCapabilities');
// page-flows lane (claimed) supersedes page-codebase's interim fallback
// (pages/codebase/CodebaseFlows.tsx + FlowDetailPage.tsx, both left in place
// as dead code for page-codebase to remove in a follow-up — see
// apps/app/docs/DESIGN-NOTES.md, "page-flows lane").
const CodebaseFlows = lazyPage('Flows', () => import('./pages/flows/FlowsListPage'), 'FlowsListPage');
const CodebaseEntities = lazyPage('Entities', () => import('./pages/entities/EntitiesPage'), 'EntitiesPage');
const CodebaseArchitecture = lazyPage('Architecture', () => import('./pages/codebase/CodebaseArchitecture'), 'CodebaseArchitecture');
const CodebaseDependencies = lazyPage('Dependencies', () => import('./pages/codebase/CodebaseDependencies'), 'CodebaseDependencies');
const CodebaseEntryPoints = lazyPage('Entry points', () => import('./pages/entry-points/EntryPointsPage'), 'EntryPointsPage');
const CodebaseFunctions = lazyPage('Functions', () => import('./pages/functions/FunctionsPage'), 'FunctionsPage');
const CodebaseIntegrations = lazyPage('Integrations', () => import('./pages/integrations/IntegrationsPage'), 'IntegrationsPage');
const DeployableDetailPage = lazyPage('Deployable', () => import('./pages/deployable/DeployableDetailPage'), 'DeployableDetailPage');
const EntryPointDetailPage = lazyPage('Entry point', () => import('./pages/entry-points/EntryPointDetailPage'), 'EntryPointDetailPage');
const FlowDetailPage = lazyPage('Flow', () => import('./pages/flows/FlowDetailPage'), 'FlowDetailPage');
const EntityDetailPage = lazyPage('Entity', () => import('./pages/entities/EntityDetailPage'), 'EntityDetailPage');
const FunctionDetailPage = lazyPage('Function', () => import('./pages/functions/FunctionDetailPage'), 'FunctionDetailPage');
const FileNodesPage = lazyPage('File', () => import('./pages/functions/FileNodesPage'), 'FileNodesPage');

function AuthenticatedLayout() {
  return (
    <RequireAuth>
      <AppShell>
        <Suspense fallback={<LoadingState />}>
          <Outlet />
        </Suspense>
      </AppShell>
    </RequireAuth>
  );
}

export const router = createBrowserRouter([
  { path: '/auth', element: <AuthPage /> },
  {
    path: '/',
    element: <AuthenticatedLayout />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'workspaces/:workspaceId', element: <WorkspacePage /> },
      { path: 'workspaces/:workspaceId/map', element: <WorkspaceMapPage /> },
      {
        path: 'codebases/:projectId',
        element: <CodebasePage />,
        children: [
          { index: true, element: <CodebaseOverview /> },
          { path: 'overview', element: <CodebaseOverview /> },
          { path: 'capabilities', element: <CodebaseCapabilities /> },
          { path: 'flows', element: <CodebaseFlows /> },
          { path: 'flows/:flowId', element: <FlowDetailPage /> },
          { path: 'entities', element: <CodebaseEntities /> },
          { path: 'entities/:entityId', element: <EntityDetailPage /> },
          { path: 'architecture', element: <CodebaseArchitecture /> },
          { path: 'dependencies', element: <CodebaseDependencies /> },
          { path: 'entry-points', element: <CodebaseEntryPoints /> },
          { path: 'entry-points/:entryPointId', element: <EntryPointDetailPage /> },
          { path: 'functions', element: <CodebaseFunctions /> },
          { path: 'functions/file/*', element: <FileNodesPage /> },
          { path: 'functions/:nodeId', element: <FunctionDetailPage /> },
          { path: 'integrations', element: <CodebaseIntegrations /> },
          { path: 'deployables/:dasUnitId', element: <DeployableDetailPage /> },
        ],
      },
    ],
  },
]);

export default router;
