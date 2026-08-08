jest.unmock('fs-extra');
jest.unmock('fs');
jest.unmock('glob');

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AngularRouteResolver, ResolvedAngularRoute } from '../../analyzer/frameworks/web/angular-route-resolver';
import { AngularAnalyzer } from '../../analyzer/frameworks/web/angular-analyzer';
import { CASEntryPoint, CASNode, CASEdge } from '../../types/cas.types';

describe('Angular route resolution', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'angular-routes-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const write = (relative: string, content: string) => {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };

  const listFiles = (): string[] => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) files.push(path.relative(root, full));
      }
    };
    walk(root);
    return files;
  };

  const resolveRoutes = async (): Promise<ResolvedAngularRoute[]> => {
    const resolver = new AngularRouteResolver(root);
    return (await resolver.resolve(listFiles())).routes;
  };

  const byPath = (routes: ResolvedAngularRoute[], fullPath: string) =>
    routes.find(route => route.fullPath === fullPath);

  const writeTsconfig = () => {
    write('tsconfig.json', JSON.stringify({
      compilerOptions: {
        baseUrl: './',
        paths: {
          '@defs/*': ['src/app/defs/*'],
          '@utils/*': ['src/app/utils/*'],
          '@core/*': ['src/app/core/*'],
        },
      },
    }));
  };

  const writePageKeyInfrastructure = () => {
    write('src/app/defs/routes.ts', `
export enum RouteData {
  PropAnyRights = 'anyRights',
  PropTitle = 'title',
}

export enum Path {
  SegVehicles = 'vehicles',
  SegDetails = 'details',
  SegSafety = 'safety',
  SegTable = 'table',
  SegAuth = 'auth',
  SegLogin = 'login',
}

export enum PageKeys {
  AuthLogin = 'AuthLogin',
  UserVehicle = 'Vehicle',
  UserVehicleSafety = 'VehicleSafety',
  UserVehiclesTable = 'VehiclesTable',
}
`);
    write('src/app/defs/user.ts', `
export enum AccessRights {
  VehiclesViewTable = 'vehicles-view-table',
  SafetyView = 'safety-view',
}
`);
    write('src/app/utils/routes.ts', `
import { PageKeys, Path } from '@defs/routes';

export enum LinkTypes {
  RouterLink,
  RoutePath,
  MenuPath,
}

export const idPlaceholder = ':id';
export const moduleVehiclesPath = Path.SegVehicles;
export const moduleAuthPath = Path.SegAuth;

type LinkOrPathGenerator = (type: LinkTypes, entityId?: string | null) => string | string[];

const pageLinkGenerators: Record<string, LinkOrPathGenerator> = {
  [PageKeys.AuthLogin]: (type) => build(type, [moduleAuthPath], [Path.SegLogin]),
  [PageKeys.UserVehicle]: (type, entityId) => build(
    type,
    [moduleVehiclesPath],
    [Path.SegDetails, entityId || idPlaceholder],
  ),
  [PageKeys.UserVehicleSafety]: (type, entityId) => build(
    type,
    [moduleVehiclesPath, Path.SegDetails, entityId || idPlaceholder],
    [Path.SegSafety],
  ),
  [PageKeys.UserVehiclesTable]: (type) => build(type, [moduleVehiclesPath], [Path.SegTable]),
};

function build(type: LinkTypes, parent: string[], path: string[]): string[] | string {
  if (type === LinkTypes.RoutePath) { return path.join('/'); }
  if (type === LinkTypes.RouterLink) { return ['/', ...parent, ...path]; }
  const link = [...parent, ...path].join('/');
  return \`/\${ link }\`;
}

function getGenerator(pageKey: PageKeys) {
  if (typeof (pageLinkGenerators[pageKey]) !== 'function') {
    throw new Error(\`No page link generator for page key "\${ pageKey }"\`);
  }
  return pageLinkGenerators[pageKey];
}

export function getRoutePath(pageKey: PageKeys): string {
  return getGenerator(pageKey)(LinkTypes.RoutePath) as string;
}

export function getPagePath(pageKey: PageKeys, entityId: string | null = null): string {
  return getGenerator(pageKey)(LinkTypes.MenuPath, entityId) as string;
}
`);
    write('src/app/core/guards/auth.guard.ts', `
import { CanMatchFn } from '@angular/router';

export const authGuard: CanMatchFn = () => true;
export const guestGuard: CanMatchFn = () => true;
`);
    write('src/app/core/guards/access-rights.guard.ts', `
import { CanMatchFn } from '@angular/router';

export const accessRightsGuard: CanMatchFn = () => true;
`);
  };

  const writeTruckspyShapedApp = () => {
    writeTsconfig();
    writePageKeyInfrastructure();
    write('src/app/app.config.ts', `
import { provideRouter } from '@angular/router';
import { routes } from './app.routes';

export const appConfig = {
  providers: [provideRouter(routes)],
};
`);
    write('src/app/app.routes.ts', `
import { Routes } from '@angular/router';
import { accessRightsGuard } from '@core/guards/access-rights.guard';
import { authGuard, guestGuard } from '@core/guards/auth.guard';
import { PageKeys, RouteData } from '@defs/routes';
import { AccessRights } from '@defs/user';
import { MainLayoutComponent } from './layout/main-layout.component';
import { getPagePath, getRoutePath, moduleAuthPath, moduleVehiclesPath } from '@utils/routes';

export const routes: Routes = [
  {
    path: '',
    component: MainLayoutComponent,
    canMatch: [authGuard],
    children: [
      {
        path: moduleVehiclesPath,
        loadChildren: () => import('./features/vehicles/vehicles.routing').then((m) => m.vehiclesRoutes),
        canMatch: [accessRightsGuard],
        data: {
          [RouteData.PropAnyRights]: [AccessRights.VehiclesViewTable],
        },
      },
    ],
  },
  {
    path: moduleAuthPath,
    loadChildren: () => import('./features/auth/auth.routing').then((m) => m.authRoutes),
    canMatch: [guestGuard],
  },
  { path: '**', redirectTo: getPagePath(PageKeys.UserVehiclesTable) },
];
`);
    write('src/app/layout/main-layout.component.ts', `
import { Component } from '@angular/core';

@Component({ selector: 'app-main-layout', template: '<router-outlet></router-outlet>', standalone: true })
export class MainLayoutComponent {}
`);
    write('src/app/features/vehicles/vehicles.routing.ts', `
import { Routes, RouterModule } from '@angular/router';
import { accessRightsGuard } from '@core/guards/access-rights.guard';
import { PageKeys, RouteData } from '@defs/routes';
import { AccessRights } from '@defs/user';
import { VehiclesListComponent } from './list/vehicles-list.component';
import { VehicleViewComponent } from './view/vehicle-view.component';
import { VehicleAlertsComponent } from './view/alerts/alerts.component';
import { getRoutePath } from '@utils/routes';

export const vehiclesRoutes: Routes = [
  {
    path: getRoutePath(PageKeys.UserVehicle),
    component: VehicleViewComponent,
    children: [
      {
        path: getRoutePath(PageKeys.UserVehicleSafety),
        component: VehicleAlertsComponent,
        canMatch: [accessRightsGuard],
        data: {
          [RouteData.PropTitle]: 'Safety Alerts',
          [RouteData.PropAnyRights]: [AccessRights.SafetyView],
        },
      },
    ],
  },
  {
    path: getRoutePath(PageKeys.UserVehiclesTable),
    component: VehiclesListComponent,
    canMatch: [accessRightsGuard],
  },
  {
    path: '**',
    redirectTo: getRoutePath(PageKeys.UserVehiclesTable),
  },
];

export const vehiclesRouting = RouterModule.forChild(vehiclesRoutes);
`);
    write('src/app/features/vehicles/list/vehicles-list.component.ts', `
import { Component } from '@angular/core';

@Component({ selector: 'app-vehicles-list', template: '<div></div>', standalone: true })
export class VehiclesListComponent {}
`);
    write('src/app/features/vehicles/view/vehicle-view.component.ts', `
import { Component } from '@angular/core';

@Component({ selector: 'app-vehicle-view', template: '<div></div>', standalone: true })
export class VehicleViewComponent {}
`);
    write('src/app/features/vehicles/view/alerts/alerts.component.ts', `
import { Component } from '@angular/core';

@Component({ selector: 'app-vehicle-alerts', template: '<div></div>', standalone: true })
export class VehicleAlertsComponent {}
`);
    write('src/app/features/auth/auth.routing.ts', `
import { Routes } from '@angular/router';
import { PageKeys } from '@defs/routes';
import { getRoutePath } from '@utils/routes';
import { LoginComponent } from './login/login.component';

const routePathLogin = getRoutePath(PageKeys.AuthLogin);

export const authRoutes: Routes = [
  {
    path: routePathLogin,
    component: LoginComponent,
  },
];
`);
    write('src/app/features/auth/login/login.component.ts', `
import { Component } from '@angular/core';

@Component({ selector: 'app-login', template: '<div></div>', standalone: true })
export class LoginComponent {}
`);
    write('package.json', JSON.stringify({
      name: 'angular-route-fixture',
      dependencies: { '@angular/core': '^17.0.0', '@angular/router': '^17.0.0' },
    }));
  };

  describe('AngularRouteResolver', () => {
    it('resolves getRoutePath page-key generators to real path segments across files', async () => {
      writeTruckspyShapedApp();
      const routes = await resolveRoutes();

      expect(byPath(routes, 'vehicles/details/:id')).toBeDefined();
      expect(byPath(routes, 'vehicles/details/:id/safety')).toBeDefined();
      expect(byPath(routes, 'vehicles/table')).toBeDefined();
      expect(byPath(routes, 'auth/login')).toBeDefined();
      expect(routes.every(route => route.pathResolved)).toBe(true);
    });

    it('resolves module path constants backed by cross-file enums', async () => {
      writeTruckspyShapedApp();
      const routes = await resolveRoutes();

      const vehiclesModule = byPath(routes, 'vehicles');
      expect(vehiclesModule).toBeDefined();
      expect(vehiclesModule!.lazyChildren).toBe(true);
      expect(vehiclesModule!.loadChildrenFile).toBe('src/app/features/vehicles/vehicles.routing.ts');
    });

    it('recurses into lazy loadChildren modules and prefixes child paths', async () => {
      writeTruckspyShapedApp();
      const routes = await resolveRoutes();

      const table = byPath(routes, 'vehicles/table');
      expect(table!.component).toBe('VehiclesListComponent');
      expect(table!.componentFile).toBe('src/app/features/vehicles/list/vehicles-list.component.ts');
      expect(table!.sourceFile).toBe('src/app/features/vehicles/vehicles.routing.ts');
    });

    it('captures canMatch guards and inherits ancestor guards across lazy boundaries', async () => {
      writeTruckspyShapedApp();
      const routes = await resolveRoutes();

      const safety = byPath(routes, 'vehicles/details/:id/safety');
      expect(safety!.guards).toEqual(['accessRightsGuard']);
      expect(safety!.inheritedGuards).toEqual(['authGuard', 'accessRightsGuard']);

      const login = byPath(routes, 'auth/login');
      expect(login!.inheritedGuards).toEqual(['guestGuard']);
    });

    it('evaluates route data objects with computed enum keys and enum value arrays', async () => {
      writeTruckspyShapedApp();
      const routes = await resolveRoutes();

      const safety = byPath(routes, 'vehicles/details/:id/safety');
      expect(safety!.data).toEqual({
        title: 'Safety Alerts',
        anyRights: ['safety-view'],
      });
    });

    it('resolves redirectTo expressions built from page paths', async () => {
      writeTruckspyShapedApp();
      const routes = await resolveRoutes();

      const wildcard = routes.find(route => route.segment === '**' && route.sourceFile === 'src/app/app.routes.ts');
      expect(wildcard).toBeDefined();
      expect(wildcard!.redirectTo).toBe('/vehicles/table');
    });

    it('extracts lazy loadComponent targets', async () => {
      writeTsconfig();
      write('src/app/app.routes.ts', `
import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: 'overwatch',
    loadComponent: () => import('./features/overwatch/overwatch.component').then((m) => m.OverwatchComponent),
  },
];
`);
      write('src/app/features/overwatch/overwatch.component.ts', `
import { Component } from '@angular/core';

@Component({ selector: 'app-overwatch', template: '<div></div>', standalone: true })
export class OverwatchComponent {}
`);
      const routes = await resolveRoutes();
      const overwatch = byPath(routes, 'overwatch');
      expect(overwatch!.component).toBe('OverwatchComponent');
      expect(overwatch!.componentFile).toBe('src/app/features/overwatch/overwatch.component.ts');
      expect(overwatch!.lazyComponent).toBe(true);
    });

    it('still extracts literal route paths without indirection', async () => {
      write('src/app/app.routes.ts', `
import { Routes } from '@angular/router';
import { HomeComponent } from './home.component';

export const routes: Routes = [
  { path: 'home/:id', component: HomeComponent, canActivate: [AuthGuard] },
];
`);
      const routes = await resolveRoutes();
      const home = byPath(routes, 'home/:id');
      expect(home).toBeDefined();
      expect(home!.component).toBe('HomeComponent');
      expect(home!.guards).toEqual(['AuthGuard']);
      expect(home!.guardKinds).toEqual({ canActivate: ['AuthGuard'] });
    });

    it('extracts inline route arrays passed directly to RouterModule.forRoot', async () => {
      write('src/app/app.module.ts', `
import { NgModule } from '@angular/core';
import { RouterModule } from '@angular/router';
import { DashboardComponent } from './dashboard.component';

@NgModule({
  imports: [
    RouterModule.forRoot([
      { path: 'dashboard', component: DashboardComponent },
      { path: '**', redirectTo: 'dashboard' },
    ]),
  ],
})
export class AppModule {}
`);
      const routes = await resolveRoutes();
      const dashboard = byPath(routes, 'dashboard');
      expect(dashboard).toBeDefined();
      expect(dashboard!.component).toBe('DashboardComponent');
    });

    it('keeps unresolvable paths flagged instead of dropping the route', async () => {
      write('src/app/app.routes.ts', `
import { Routes } from '@angular/router';
import { HomeComponent } from './home.component';

declare function somethingDynamic(): string;

export const routes: Routes = [
  { path: window.location.host, component: HomeComponent },
];
`);
      const routes = await resolveRoutes();
      expect(routes).toHaveLength(1);
      expect(routes[0].pathResolved).toBe(false);
      expect(routes[0].component).toBe('HomeComponent');
    });
  });

  describe('AngularAnalyzer route emission', () => {
    const runAnalyzer = async () => {
      const analyzer = new AngularAnalyzer();
      const contribution = await analyzer.analyze({ projectPath: root } as any);
      return {
        nodes: (contribution.nodes || []) as CASNode[],
        edges: (contribution.edges || []) as CASEdge[],
        entryPoints: (contribution.entry_points || []) as CASEntryPoint[],
      };
    };

    it('emits route entry points with real paths and guard-backed security', async () => {
      writeTruckspyShapedApp();
      const { entryPoints } = await runAnalyzer();
      const routeEntries = entryPoints.filter(ep => ep.type === 'route');

      const paths = routeEntries.map(ep => ep.trigger?.path);
      expect(paths).toContain('/vehicles/table');
      expect(paths).toContain('/vehicles/details/:id/safety');
      expect(paths).toContain('/auth/login');
      expect(paths).not.toContain('**');
      expect(paths).not.toContain('/**');

      const safety = routeEntries.find(ep => ep.trigger?.path === '/vehicles/details/:id/safety');
      expect(safety!.security?.authenticated).toBe(true);
      expect(safety!.security?.authorized_roles).toEqual(['authGuard', 'accessRightsGuard']);
      expect(safety!.metadata?.guards).toEqual(['authGuard', 'accessRightsGuard']);
      expect(safety!.metadata?.component).toBe('VehicleAlertsComponent');

      const login = routeEntries.find(ep => ep.trigger?.path === '/auth/login');
      expect(login!.security?.authorized_roles).toEqual(['guestGuard']);
    });

    it('does not emit wildcard entry points, but does emit lazy loadChildren module entry points', async () => {
      writeTruckspyShapedApp();
      const { entryPoints, nodes } = await runAnalyzer();
      const routeEntries = entryPoints.filter(ep => ep.type === 'route');

      // Every emitted entry point must render SOMETHING at its path: either
      // its own component, or (for a lazy feature-module boundary like
      // `path: 'vehicles', loadChildren: ...`) a load_children target. A
      // route with neither (a bare redirect, or the wildcard catch-all) must
      // never be counted.
      expect(routeEntries.every(ep => ep.metadata?.component || ep.metadata?.load_children)).toBe(true);

      // Real defect: a `loadChildren`-based lazy feature-module route (no
      // component of its own — the child module supplies its own routes) was
      // previously dropped from entry_points entirely because the gate
      // required `route.component`, even though the angular_route NODE was
      // always emitted for it. On a real Angular SPA leaning on loadChildren
      // for feature-module lazy loading, that undercounted entry points by
      // 89% (158 angular_route nodes, only 17 entry points) relative to what
      // the analyzer itself had already discovered. The 'vehicles' and
      // 'auth' routes below are exactly that shape in this fixture.
      const vehiclesModuleEntry = routeEntries.find(ep => ep.trigger?.path === '/vehicles');
      expect(vehiclesModuleEntry).toBeDefined();
      expect(vehiclesModuleEntry!.metadata?.component).toBeUndefined();
      expect(vehiclesModuleEntry!.metadata?.load_children).toBe('src/app/features/vehicles/vehicles.routing.ts');
      expect(vehiclesModuleEntry!.metadata?.lazy).toBe(true);

      const authModuleEntry = routeEntries.find(ep => ep.trigger?.path === '/auth');
      expect(authModuleEntry).toBeDefined();
      expect(authModuleEntry!.metadata?.component).toBeUndefined();
      expect(authModuleEntry!.metadata?.load_children).toBe('src/app/features/auth/auth.routing.ts');

      const paths = routeEntries.map(ep => ep.trigger?.path);
      expect(paths).not.toContain('**');
      expect(paths).not.toContain('/**');

      const routeNodes = nodes.filter(node => node.type === 'angular_route');
      const wildcardNodes = routeNodes.filter(node => String(node.metadata?.attributes?.segment) === '**');
      expect(wildcardNodes.length).toBeGreaterThan(0);
    });

    it('links route nodes to their rendered components and guards by stable node ids', async () => {
      writeTruckspyShapedApp();
      const { nodes, edges } = await runAnalyzer();

      const tableRoute = nodes.find(node => node.type === 'angular_route' && node.name === '/vehicles/table');
      expect(tableRoute).toBeDefined();
      const componentNode = nodes.find(node => node.type === 'angular_component' && node.name === 'VehiclesListComponent');
      expect(componentNode).toBeDefined();

      const renderEdge = edges.find(edge =>
        edge.source === tableRoute!.id && edge.target === componentNode!.id && edge.type === 'renders');
      expect(renderEdge).toBeDefined();
      const routesToEdge = edges.find(edge =>
        edge.source === tableRoute!.id && edge.target === componentNode!.id && edge.type === 'routes_to');
      expect(routesToEdge).toBeDefined();

      const guardNode = nodes.find(node => node.type === 'angular_guard' && node.name === 'accessRightsGuard');
      expect(guardNode).toBeDefined();
      const guardEdge = edges.find(edge =>
        edge.source === tableRoute!.id && edge.target === guardNode!.id && edge.type === 'guarded_by');
      expect(guardEdge).toBeDefined();
    });

    it('detects functional guards as individual guard nodes', async () => {
      writeTruckspyShapedApp();
      const { nodes } = await runAnalyzer();
      const guardNames = nodes.filter(node => node.type === 'angular_guard').map(node => node.name);
      expect(guardNames).toEqual(expect.arrayContaining(['authGuard', 'guestGuard', 'accessRightsGuard']));
    });
  });
});
