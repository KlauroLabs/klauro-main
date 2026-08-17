import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DockerComposeAnalyzer, DockerfileAnalyzer, KubernetesManifestAnalyzer } from './container-topology-analyzer';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

test('KubernetesManifestAnalyzer extracts raw manifests and routes ingress to service to deployment', async () => {
  const dir = tempDir('kubernetes-test');
  try {
    fs.mkdirSync(path.join(dir, 'deploy'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'deploy', 'orders.yaml'), [
      'apiVersion: apps/v1',
      'kind: Deployment',
      'metadata:',
      '  name: orders',
      'spec:',
      '  replicas: 2',
      '  selector:',
      '    matchLabels:',
      '      app: orders',
      '  template:',
      '    metadata:',
      '      labels:',
      '        app: orders',
      '    spec:',
      '      containers:',
      '        - name: orders',
      '          image: ghcr.io/example/orders:1.0.0',
      '          ports:',
      '            - containerPort: 8080',
      '          env:',
      '            - name: DATABASE_URL',
      '              value: http://postgres:5432/db',
      '---',
      'apiVersion: v1',
      'kind: Service',
      'metadata:',
      '  name: orders',
      'spec:',
      '  selector:',
      '    app: orders',
      '  ports:',
      '    - port: 80',
      '      targetPort: 8080',
      '---',
      'apiVersion: networking.k8s.io/v1',
      'kind: Ingress',
      'metadata:',
      '  name: orders',
      'spec:',
      '  rules:',
      '    - host: orders.example.test',
      '      http:',
      '        paths:',
      '          - path: /',
      '            pathType: Prefix',
      '            backend:',
      '              service:',
      '                name: orders',
      '                port:',
      '                  number: 80',
      '',
    ].join('\n'));
    fs.mkdirSync(path.join(dir, 'chart', 'templates'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'chart', 'templates', 'deployment.yaml'), [
      'apiVersion: apps/v1',
      'kind: Deployment',
      'metadata:',
      '  name: templated',
      '',
    ].join('\n'));

    const analyzer = new KubernetesManifestAnalyzer();
    assert.deepEqual(await analyzer.getRelevantFiles(dir), ['deploy/orders.yaml']);
    const cas = await analyzer.analyze({ projectPath: dir });

    const deployment = cas.nodes.find(node => node.type === 'kubernetes_deployment' && node.name === 'Deployment: orders');
    const service = cas.nodes.find(node => node.type === 'kubernetes_service');
    const ingress = cas.nodes.find(node => node.type === 'kubernetes_ingress');
    assert.ok(deployment, 'deployment node exists');
    assert.ok(service, 'service node exists');
    assert.ok(ingress, 'ingress node exists');
    assert.deepEqual(deployment?.metadata?.images, ['ghcr.io/example/orders:1.0.0']);
    assert.equal(deployment?.metadata?.replicas, 2);
    assert.deepEqual(service?.metadata?.service_ports, [{ port: '80', targetPort: '8080', name: undefined }]);

    assert.ok(cas.edges.find(edge => edge.type === 'ROUTES_TO' && edge.source === ingress!.id && edge.target === service!.id));
    assert.ok(cas.edges.find(edge => edge.type === 'ROUTES_TO' && edge.source === service!.id && edge.target === deployment!.id));
    assert.equal(cas.nodes.some(node => node.name.includes('templated')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('KubernetesManifestAnalyzer does not claim Docker Compose files', async () => {
  const dir = tempDir('kubernetes-compose-exclusion');
  try {
    fs.writeFileSync(path.join(dir, 'docker-compose.yml'), [
      'services:',
      '  api:',
      '    image: example/api:latest',
    ].join('\n'));

    const analyzer = new KubernetesManifestAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), false);
    assert.deepEqual(await analyzer.getRelevantFiles(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('DockerComposeAnalyzer extracts service build, ports, dependencies, env, volumes, and networks', async () => {
  const dir = tempDir('compose-test');
  try {
    fs.writeFileSync(path.join(dir, 'compose.yaml'), [
      'services:',
      '  api:',
      '    build:',
      '      context: ./services/api',
      '    ports:',
      '      - "8080:3000"',
      '    depends_on:',
      '      db:',
      '        condition: service_started',
      '    environment:',
      '      DATABASE_URL: http://db:5432/orders',
      '    volumes:',
      '      - ./services/api:/app',
      '    networks:',
      '      - backend',
      '  db:',
      '    image: postgres:16',
      'networks:',
      '  backend: {}',
      '',
    ].join('\n'));

    const analyzer = new DockerComposeAnalyzer();
    const cas = await analyzer.analyze({ projectPath: dir });
    const api = cas.nodes.find(node => node.type === 'compose_service' && node.metadata?.deployment_service_name === 'api');
    const db = cas.nodes.find(node => node.type === 'compose_service' && node.metadata?.deployment_service_name === 'db');
    assert.ok(api, 'api service node exists');
    assert.ok(db, 'db service node exists');
    assert.equal(api?.metadata?.build, './services/api');
    assert.deepEqual(api?.metadata?.ports, [{ host: '8080', container: '3000' }]);
    assert.deepEqual(api?.metadata?.depends_on, ['db']);
    assert.deepEqual(api?.metadata?.volumes, ['./services/api:/app']);
    assert.deepEqual(api?.metadata?.networks, ['backend']);
    assert.ok(cas.edges.find(edge => edge.type === 'DEPENDS_ON' && edge.source === api!.id && edge.target === db!.id));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('DockerfileAnalyzer extracts stages, workdir, entrypoint, cmd, and copy/add sources', async () => {
  const dir = tempDir('dockerfile-test');
  try {
    fs.writeFileSync(path.join(dir, 'Dockerfile'), [
      'FROM node:22-alpine AS build',
      'WORKDIR /app',
      'COPY package.json package-lock.json ./',
      'ADD ["src", "./src"]',
      'FROM node:22-alpine',
      'WORKDIR /srv',
      'COPY --from=build /app/dist ./dist',
      'EXPOSE 3000 9090/tcp',
      'ENTRYPOINT ["node"]',
      'CMD ["dist/server.js"]',
      '',
    ].join('\n'));

    const analyzer = new DockerfileAnalyzer();
    const cas = await analyzer.analyze({ projectPath: dir });
    const image = cas.nodes.find(node => node.type === 'container_image_definition');
    assert.ok(image, 'container image node exists');
    assert.deepEqual(image?.metadata?.base_images, ['node:22-alpine', 'node:22-alpine']);
    assert.deepEqual(image?.metadata?.stages, [{ image: 'node:22-alpine', alias: 'build', line: 1 }, { image: 'node:22-alpine', alias: undefined, line: 5 }]);
    assert.deepEqual(image?.metadata?.exposed_ports, ['3000', '9090/tcp']);
    assert.equal(image?.metadata?.workdir, '/srv');
    assert.equal(image?.metadata?.entrypoint, '["node"]');
    assert.equal(image?.metadata?.cmd, '["dist/server.js"]');
    assert.deepEqual(image?.metadata?.copy_sources, ['package.json', 'package-lock.json', '/app/dist']);
    assert.deepEqual(image?.metadata?.add_sources, ['src']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
