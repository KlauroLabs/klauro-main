import { lazy, Suspense, type ComponentType } from 'react';
import { createBrowserRouter, Outlet } from 'react-router-dom';
import { AppShell } from '@/shared/layout/AppShell';
import { RequireAuth } from '@/shared/auth/RequireAuth';
import { LoadingState } from '@/shared/layout/LoadingState';
import { Stub } from '@/app/Stub';
import { AuthPage } from '@/app/Auth/AuthPage';

function lazyPage(area: string, loader: () => Promise<{ [key: string]: ComponentType }>, exportName: string) {
  return lazy(() =>
    loader()
      .then(mod => ({ default: mod[exportName] }))
      .catch(() => ({ default: () => <Stub area={area} /> })),
  );
}

const DashboardPage = lazyPage('Dashboard', () => import('@/app/Dashboard/DashboardPage'), 'DashboardPage');
const WorkspacePage = lazyPage('Workspace', () => import('@/app/Workspace/WorkspacePage'), 'WorkspacePage');
const WorkspaceMapPage = lazyPage('Workspace system map', () => import('@/app/Workspace/WorkspaceMapPage'), 'WorkspaceMapPage');
const CodebasePage = lazyPage('Codebase overview', () => import('@/app/Codebase/CodebasePage'), 'CodebasePage');
const CodebaseOverview = lazyPage('Overview', () => import('@/app/Codebase/CodebaseOverview'), 'CodebaseOverview');
const CodebaseCapabilities = lazyPage('Capabilities', () => import('@/app/Codebase/CodebaseCapabilities'), 'CodebaseCapabilities');

const CodebaseFlows = lazyPage('Flows', () => import('@/app/Flows/FlowsListPage'), 'FlowsListPage');
const CodebaseEntities = lazyPage('Entities', () => import('@/app/Entities/EntitiesPage'), 'EntitiesPage');
const CodebaseArchitecture = lazyPage('Architecture', () => import('@/app/Codebase/CodebaseArchitecture'), 'CodebaseArchitecture');
const CodebaseDependencies = lazyPage('Dependencies', () => import('@/app/Codebase/CodebaseDependencies'), 'CodebaseDependencies');
const CodebaseEntryPoints = lazyPage('Entry points', () => import('@/app/EntryPoints/EntryPointsPage'), 'EntryPointsPage');
const CodebaseFunctions = lazyPage('Functions', () => import('@/app/Functions/FunctionsPage'), 'FunctionsPage');
const CodebaseIntegrations = lazyPage('Integrations', () => import('@/app/Integrations/IntegrationsPage'), 'IntegrationsPage');
const DeployableDetailPage = lazyPage('Deployable', () => import('@/app/Deployable/DeployableDetailPage'), 'DeployableDetailPage');
const EntryPointDetailPage = lazyPage('Entry point', () => import('@/app/EntryPoints/EntryPointDetailPage'), 'EntryPointDetailPage');
const FlowDetailPage = lazyPage('Flow', () => import('@/app/Flows/FlowDetailPage'), 'FlowDetailPage');
const EntityDetailPage = lazyPage('Entity', () => import('@/app/Entities/EntityDetailPage'), 'EntityDetailPage');
const FunctionDetailPage = lazyPage('Function', () => import('@/app/Functions/FunctionDetailPage'), 'FunctionDetailPage');
const FileNodesPage = lazyPage('File', () => import('@/app/Functions/FileNodesPage'), 'FileNodesPage');

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
