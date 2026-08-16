import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CaddyAnalyzer, NginxAnalyzer, ApacheAnalyzer, HAProxyAnalyzer, TraefikAnalyzer } from './reverse-proxy-analyzer';
import { linkInfraTopology } from '../core/infra-topology-linker';
import type { CASNode, DeployableEvidence } from '../../types/cas.types';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

test('CaddyAnalyzer extracts reverse_proxy routes and their upstream targets', async () => {
  const dir = tempDir('caddy-test');
  try {
    fs.writeFileSync(path.join(dir, 'Caddyfile'), [
      '{',
      '\temail admin@example.com',
      '}',
      '',
      'app.example.com {',
      '\tencode gzip zstd',
      '\troot * /srv/app',
      '\tfile_server',
      '}',
      '',
      'mcp.example.com {',
      '\treverse_proxy api:8787',
      '}',
      '',
    ].join('\n'));

    const analyzer = new CaddyAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), true);
    const result = await analyzer.analyze({ projectPath: dir } as any);

    const routes = result.nodes.filter(n => n.type === 'proxy_route');
    // Only the reverse_proxy site produces a routing edge; the file_server site
    // is a static route with no upstream.
    const proxied = routes.find(r => (r.metadata as any)?.proxied_service === 'api');
    assert.ok(proxied, 'expected a proxy_route fronting the api service');
    assert.equal((proxied!.metadata as any).public_host, 'mcp.example.com');
    assert.deepEqual((proxied!.metadata as any).ports, ['8787']);
    assert.equal((proxied!.metadata as any).deployment_service_name, 'api');

    const proxiesTo = result.edges.filter(e => e.type === 'PROXIES_TO');
    // api:8787 is a bare target, not a declared upstream pool, so no pool node —
    // but the route still records the proxied service + an exit point.
    assert.equal(proxiesTo.length, 0);
    const exits = (result.exit_points || []).filter(e => (e.target as any)?.service_id === 'api');
    assert.ok(exits.length >= 1, 'expected an api exit point from the proxy route');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CaddyAnalyzer resolves dynamic DNS upstream blocks', async () => {
  const dir = tempDir('caddy-dynamic-test');
  try {
    fs.writeFileSync(path.join(dir, 'Caddyfile'), [
      'mcp.example.com {',
      '  reverse_proxy {',
      '    dynamic a {',
      '      name api',
      '      port 8787',
      '      resolvers 127.0.0.11',
      '    }',
      '  }',
      '}',
    ].join('\n'));

    const result = await new CaddyAnalyzer().analyze({ projectPath: dir } as any);
    const route = result.nodes.find(node => node.type === 'proxy_route');

    assert.ok(route);
    assert.equal(route.metadata?.proxied_service, 'api');
    assert.deepEqual(route.metadata?.ports, ['8787']);
    assert.ok(result.exit_points?.some(exit => exit.target?.service_id === 'api'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('NginxAnalyzer resolves proxy_pass to declared upstream pools', async () => {
  const dir = tempDir('nginx-test');
  try {
    fs.writeFileSync(path.join(dir, 'nginx.conf'), [
      'http {',
      '    upstream backend {',
      '        server host.docker.internal:3001;',
      '        keepalive 32;',
      '    }',
      '    upstream ui {',
      '        server host.docker.internal:3000;',
      '    }',
      '    server {',
      '        listen 443 ssl;',
      '        server_name contractors.example.local;',
      '        location / {',
      '            proxy_pass http://ui;',
      '        }',
      '        location /api/ {',
      '            proxy_pass http://backend;',
      '        }',
      '    }',
      '}',
      '',
    ].join('\n'));

    const analyzer = new NginxAnalyzer();
    const result = await analyzer.analyze({ projectPath: dir } as any);

    const upstreams = result.nodes.filter(n => n.type === 'proxy_upstream');
    assert.equal(upstreams.length, 2, 'expected backend + ui upstream pools');
    const backend = upstreams.find(u => (u.metadata as any).deployment_service_name === 'backend');
    assert.deepEqual((backend!.metadata as any).servers, ['host.docker.internal:3001']);
    assert.deepEqual((backend!.metadata as any).ports, ['3001']);

    const routes = result.nodes.filter(n => n.type === 'proxy_route');
    const apiRoute = routes.find(r => (r.metadata as any).match_path === '/api/');
    assert.ok(apiRoute, 'expected a /api/ route');
    assert.equal((apiRoute!.metadata as any).public_host, 'contractors.example.local');
    assert.deepEqual((apiRoute!.metadata as any).listen_ports, ['443']);

    // Each proxy_pass to a declared pool draws a PROXIES_TO edge to that pool node.
    const proxiesTo = result.edges.filter(e => e.type === 'PROXIES_TO');
    assert.equal(proxiesTo.length, 2, 'both routes resolve to upstream pools');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('NginxAnalyzer represents static server blocks without upstream proxies', async () => {
  const dir = tempDir('nginx-static-test');
  try {
    fs.writeFileSync(path.join(dir, 'nginx.conf'), [
      'server {',
      '    listen 8080;',
      '    server_name static.example.local;',
      '    root /usr/share/nginx/html;',
      '    location / {',
      '        try_files $uri $uri/ /index.html;',
      '    }',
      '}',
    ].join('\n'));

    const result = await new NginxAnalyzer().analyze({ projectPath: dir } as any);
    const route = result.nodes.find(node => node.type === 'proxy_route');

    assert.ok(route);
    assert.equal(route.metadata?.directive, 'serve_static');
    assert.equal(route.metadata?.public_host, 'static.example.local');
    assert.deepEqual(route.metadata?.listen_ports, ['8080']);
    assert.equal(result.exit_points?.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ApacheAnalyzer extracts ProxyPass from VirtualHost blocks', async () => {
  const dir = tempDir('apache-test');
  try {
    fs.writeFileSync(path.join(dir, 'httpd.conf'), [
      '<VirtualHost *:443>',
      '    ServerName www.example.com',
      '    ProxyPass /api http://backend:8080/',
      '    ProxyPassReverse /api http://backend:8080/',
      '    ProxyPass / http://frontend:3000/',
      '</VirtualHost>',
      '',
    ].join('\n'));

    const analyzer = new ApacheAnalyzer();
    const result = await analyzer.analyze({ projectPath: dir } as any);

    const routes = result.nodes.filter(n => n.type === 'proxy_route');
    assert.equal(routes.length, 2, 'two ProxyPass directives (ProxyPassReverse ignored)');
    const apiRoute = routes.find(r => (r.metadata as any).match_path === '/api');
    assert.equal((apiRoute!.metadata as any).public_host, 'www.example.com');
    assert.equal((apiRoute!.metadata as any).proxied_service, 'backend');
    assert.deepEqual((apiRoute!.metadata as any).ports, ['8080']);
    assert.deepEqual((apiRoute!.metadata as any).listen_ports, ['443']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HAProxyAnalyzer joins frontend use_backend to backend server pools', async () => {
  const dir = tempDir('haproxy-test');
  try {
    fs.writeFileSync(path.join(dir, 'haproxy.cfg'), [
      'frontend http_in',
      '    bind *:80',
      '    acl is_api hdr(host) -i api.example.com',
      '    use_backend api_servers if is_api',
      '    default_backend web_servers',
      '',
      'backend api_servers',
      '    server api1 10.0.0.1:8080',
      '    server api2 10.0.0.2:8080',
      '',
      'backend web_servers',
      '    server web1 10.0.0.3:3000',
      '',
    ].join('\n'));

    const analyzer = new HAProxyAnalyzer();
    const result = await analyzer.analyze({ projectPath: dir } as any);

    const upstreams = result.nodes.filter(n => n.type === 'proxy_upstream');
    assert.equal(upstreams.length, 2);
    const apiPool = upstreams.find(u => (u.metadata as any).deployment_service_name === 'api_servers');
    assert.deepEqual((apiPool!.metadata as any).servers, ['10.0.0.1:8080', '10.0.0.2:8080']);

    const routes = result.nodes.filter(n => n.type === 'proxy_route');
    assert.equal(routes.length, 2, 'use_backend + default_backend');
    const apiRoute = routes.find(r => (r.metadata as any).upstream_target === 'api_servers');
    assert.equal((apiRoute!.metadata as any).public_host, 'api.example.com');
    assert.deepEqual((apiRoute!.metadata as any).listen_ports, ['80']);

    const proxiesTo = result.edges.filter(e => e.type === 'PROXIES_TO');
    assert.equal(proxiesTo.length, 2, 'both frontend routes resolve to backend pools');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TraefikAnalyzer extracts routers, rules, and loadBalancer services', async () => {
  const dir = tempDir('traefik-test');
  try {
    fs.writeFileSync(path.join(dir, 'traefik.yml'), [
      'entryPoints:',
      '  web:',
      '    address: ":80"',
      '  websecure:',
      '    address: ":443"',
      'http:',
      '  routers:',
      '    api-router:',
      '      rule: "Host(`api.example.com`) && PathPrefix(`/v1`)"',
      '      entryPoints:',
      '        - websecure',
      '      service: api-service',
      '  services:',
      '    api-service:',
      '      loadBalancer:',
      '        servers:',
      '          - url: "http://api:8000"',
      '',
    ].join('\n'));

    const analyzer = new TraefikAnalyzer();
    const result = await analyzer.analyze({ projectPath: dir } as any);

    const upstreams = result.nodes.filter(n => n.type === 'proxy_upstream');
    assert.equal(upstreams.length, 1);
    assert.deepEqual((upstreams[0].metadata as any).servers, ['http://api:8000']);

    const routes = result.nodes.filter(n => n.type === 'proxy_route');
    assert.equal(routes.length, 1);
    const route = routes[0];
    assert.equal((route.metadata as any).public_host, 'api.example.com');
    assert.equal((route.metadata as any).match_path, '/v1');
    assert.deepEqual((route.metadata as any).listen_ports, ['443']);
    assert.equal((route.metadata as any).proxied_service, 'api');
    assert.deepEqual((route.metadata as any).ports, ['8000']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('infra linker joins a proxy route to a deployable by upstream port (public URL -> proxy -> service)', async () => {
  const dir = tempDir('caddy-link-test');
  try {
    // A Caddy route fronting api:8787, plus a deployable that owns port 8787.
    fs.writeFileSync(path.join(dir, 'Caddyfile'), [
      'mcp.example.com {',
      '\treverse_proxy api:8787',
      '}',
      '',
    ].join('\n'));
    const analyzer = new CaddyAnalyzer();
    const contribution = await analyzer.analyze({ projectPath: dir } as any);

    const deployables: DeployableEvidence[] = [
      { name: 'api', root_path: 'apps/api', ports: [8787] } as DeployableEvidence,
    ];
    // A code node under the deployable root so the anchor binds to a real node.
    const codeNode: CASNode = {
      id: 'code_api_server',
      name: 'api server',
      type: 'module',
      level: 1,
      source: { file: 'apps/api/server.ts' },
    } as CASNode;

    const links = linkInfraTopology({
      nodes: [...contribution.nodes, codeNode],
      entry_points: [],
      exit_points: [],
      external_services: [],
      entities: [],
      deployable_evidence: deployables,
    });

    const exposes = links.edges.filter(e => e.type === 'EXPOSES' && (e.metadata as any)?.attributes?.via === 'reverse-proxy');
    assert.ok(exposes.length >= 1, 'expected the proxy route to EXPOSES the api deployable');
    assert.equal(exposes[0].target, 'deployable:api');
    assert.ok(links.nodes.some(node => node.id === 'deployable:api'));
    assert.equal((exposes[0].metadata as any).attributes.join_key, 'port:8787');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('infra linker uses a stable synthetic anchor for container deployables', () => {
  const links = linkInfraTopology({
    nodes: [
      {
        id: 'docker_api',
        name: 'api',
        type: 'container_image_definition',
        metadata: { topology_surface: 'dockerfile', attributes: { name: 'api' } },
      } as CASNode,
      { id: 'code_z', name: 'z', type: 'module', level: 1, source: { file: 'apps/api/z.ts' } } as CASNode,
      { id: 'code_a', name: 'a', type: 'module', level: 1, source: { file: 'apps/api/a.ts' } } as CASNode,
    ],
    entry_points: [],
    exit_points: [],
    external_services: [],
    entities: [],
    deployable_evidence: [{ name: 'api', root_path: 'apps/api', kind: 'container' } as DeployableEvidence],
  });

  const deployment = links.edges.find(edge => edge.type === 'DEPLOYS');
  assert.equal(deployment?.target, 'deployable:api');
  assert.ok(links.nodes.some(node => node.id === 'deployable:api'));
});
