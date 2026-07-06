jest.unmock('fs');
jest.unmock('fs-extra');
jest.unmock('glob');

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { AuthAnalyzer } from '../../analyzer/libraries/auth';
import { CASContribution, CASNode } from '../../types/cas.types';

describe('AuthAnalyzer', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-auth-analyzer-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function analyzeProject(
    manifests: Record<string, unknown>,
    files: Record<string, string>
  ): Promise<CASContribution> {
    for (const [name, content] of Object.entries(manifests)) {
      const fullPath = path.join(tempDir, name);
      await fs.ensureDir(path.dirname(fullPath));
      if (typeof content === 'string') {
        await fs.writeFile(fullPath, content);
      } else {
        await fs.writeJson(fullPath, content);
      }
    }
    for (const [relativePath, content] of Object.entries(files)) {
      const fullPath = path.join(tempDir, relativePath);
      await fs.ensureDir(path.dirname(fullPath));
      await fs.writeFile(fullPath, content);
    }
    const analyzer = new AuthAnalyzer();
    return analyzer.analyze({ projectPath: tempDir } as any);
  }

  function nodesOfType(contribution: CASContribution, type: string): CASNode[] {
    return (contribution.nodes || []).filter(node => node.type === type);
  }

  it('links Passport authenticate middleware to the protected Express route', async () => {
    const contribution = await analyzeProject(
      { 'package.json': { dependencies: { express: '^4.18.3', passport: '^0.7.0' } } },
      {
        'src/routes.ts': [
          "import passport from 'passport';",
          "import { Router } from 'express';",
          '',
          'const router = Router();',
          "router.get('/admin', passport.authenticate('jwt', { session: false }), listAdminUsers);",
        ].join('\n'),
      }
    );

    expect(nodesOfType(contribution, 'auth_strategy').map(node => node.name)).toContain('Passport strategy: jwt');
    expect(contribution.edges?.some(edge => edge.type === 'guards' && edge.category === 'security')).toBe(true);
    const entry = contribution.entry_points?.find(ep => ep.trigger?.path === '/admin');
    expect(entry?.security?.authenticated).toBe(true);
    expect(entry?.security?.guards).toContain('Passport strategy: jwt');
  });

  it('links Spring Security authorization annotations to mapped handlers', async () => {
    const contribution = await analyzeProject(
      {
        'pom.xml': [
          '<project><dependencies>',
          '<dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-security</artifactId></dependency>',
          '</dependencies></project>',
        ].join('\n'),
      },
      {
        'src/main/java/com/acme/AdminController.java': [
          'import org.springframework.web.bind.annotation.GetMapping;',
          'import org.springframework.security.access.prepost.PreAuthorize;',
          '',
          'class AdminController {',
          '  @GetMapping("/admin")',
          '  @PreAuthorize("hasRole(\'ADMIN\')")',
          '  public String index() { return "ok"; }',
          '}',
        ].join('\n'),
      }
    );

    expect(nodesOfType(contribution, 'auth_policy').map(node => node.name)).toContain('Spring Security policy: PreAuthorize');
    expect(contribution.edges?.some(edge => edge.type === 'authorizes' && edge.category === 'security')).toBe(true);
    const entry = contribution.entry_points?.find(ep => ep.trigger?.path === '/admin');
    expect(entry?.security?.authorized_roles).toContain('Spring Security policy: PreAuthorize');
  });

  it('does not attribute bare jwt symbols to jsonwebtoken without an import source', async () => {
    const contribution = await analyzeProject(
      { 'package.json': { dependencies: { jsonwebtoken: '^9.0.2' } } },
      {
        'src/util.ts': [
          'export function decode(jwt: string) {',
          '  return jwt.split(".");',
          '}',
        ].join('\n'),
      }
    );

    expect(nodesOfType(contribution, 'auth_strategy')).toHaveLength(0);
    expect(contribution.edges || []).toHaveLength(0);
  });

  it('detects @auth0/auth0-react SPA guards (useAuth0, Auth0Provider, withAuthenticationRequired)', async () => {
    const contribution = await analyzeProject(
      { 'package.json': { dependencies: { '@auth0/auth0-react': '^2.2.4', react: '^18.0.0' } } },
      {
        'src/App.tsx': [
          "import { Auth0Provider, useAuth0, withAuthenticationRequired } from '@auth0/auth0-react';",
          '',
          'export const App = () => (',
          '  <Auth0Provider domain="tenant.auth0.com" clientId="abc">',
          '    <Dashboard />',
          '  </Auth0Provider>',
          ');',
          '',
          'export function Profile() {',
          '  const { user, isAuthenticated } = useAuth0();',
          '  return isAuthenticated ? <div>{user?.name}</div> : null;',
          '}',
          '',
          'export const GuardedDashboard = withAuthenticationRequired(Dashboard);',
        ].join('\n'),
      }
    );

    const strategies = nodesOfType(contribution, 'auth_strategy');
    expect(strategies.length).toBeGreaterThanOrEqual(1);
    expect(strategies.every(node => (node.metadata as any)?.library === 'Auth0 guard')).toBe(true);
  });

  it('detects @clerk/clerk-react SPA guards (ClerkProvider, SignedIn, useUser)', async () => {
    const contribution = await analyzeProject(
      { 'package.json': { dependencies: { '@clerk/clerk-react': '^4.30.7', react: '^18.0.0' } } },
      {
        'src/App.tsx': [
          "import { ClerkProvider, SignedIn, SignedOut, useUser } from '@clerk/clerk-react';",
          '',
          'export const App = () => (',
          '  <ClerkProvider publishableKey="pk_test">',
          '    <SignedIn><Dashboard /></SignedIn>',
          '    <SignedOut><Login /></SignedOut>',
          '  </ClerkProvider>',
          ');',
          '',
          'export function Profile() {',
          '  const { user } = useUser();',
          '  return <div>{user?.fullName}</div>;',
          '}',
        ].join('\n'),
      }
    );

    const strategies = nodesOfType(contribution, 'auth_strategy');
    expect(strategies.length).toBeGreaterThanOrEqual(1);
    expect(strategies.every(node => (node.metadata as any)?.library === 'Clerk guard')).toBe(true);
  });

  it('detects NestJS passport guards (@UseGuards(AuthGuard) and PassportStrategy subclasses)', async () => {
    const contribution = await analyzeProject(
      { 'package.json': { dependencies: { '@nestjs/passport': '^10.0.0', '@nestjs/jwt': '^10.0.0', 'passport-jwt': '^4.0.1' } } },
      {
        'src/jwt.strategy.ts': [
          "import { PassportStrategy } from '@nestjs/passport';",
          "import { Strategy, ExtractJwt } from 'passport-jwt';",
          '',
          'export class JwtStrategy extends PassportStrategy(Strategy) {',
          '  constructor() { super({ jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken() }); }',
          '}',
        ].join('\n'),
        'src/users.controller.ts': [
          "import { AuthGuard } from '@nestjs/passport';",
          "import { Controller, Get, UseGuards } from '@nestjs/common';",
          '',
          "@Controller('users')",
          'export class UsersController {',
          "  @UseGuards(AuthGuard('jwt'))",
          '  @Get()',
          '  findAll() { return []; }',
          '}',
        ].join('\n'),
      }
    );

    const strategies = nodesOfType(contribution, 'auth_strategy');
    expect(strategies.length).toBeGreaterThanOrEqual(2);
    expect(strategies.every(node => (node.metadata as any)?.library === 'Passport strategy')).toBe(true);
  });

  it('emits policy nodes for OPA/Rego policy files without requiring a package manifest', async () => {
    const contribution = await analyzeProject(
      {},
      {
        'policies/authz.rego': [
          'package http.authz',
          '',
          'default allow := false',
          'allow if input.user.role == "admin"',
        ].join('\n'),
      }
    );

    expect(nodesOfType(contribution, 'auth_policy').map(node => node.name)).toContain('OPA/Rego policy');
  });
});
