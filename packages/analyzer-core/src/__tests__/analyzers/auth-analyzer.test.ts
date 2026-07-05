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
