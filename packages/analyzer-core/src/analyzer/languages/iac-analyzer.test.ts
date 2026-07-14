import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AnsibleAnalyzer, PulumiAnalyzer, HelmAnalyzer } from './iac-analyzer';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

// ---------------------------------------------------------------------------
// Ansible
// ---------------------------------------------------------------------------

test('AnsibleAnalyzer.canAnalyze detects a playbook', async () => {
  const dir = tempDir('ansible-test');
  try {
    fs.writeFileSync(path.join(dir, 'playbook.yml'), [
      '- name: Configure web servers',
      '  hosts: webservers',
      '  roles:',
      '    - webserver',
      '',
    ].join('\n'));
    const analyzer = new AnsibleAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AnsibleAnalyzer.analyze extracts play, role reference, and tasks', async () => {
  const dir = tempDir('ansible-test');
  try {
    fs.writeFileSync(path.join(dir, 'playbook.yml'), [
      '- name: Configure web servers',
      '  hosts: webservers',
      '  roles:',
      '    - webserver',
      '',
    ].join('\n'));

    fs.mkdirSync(path.join(dir, 'roles', 'webserver', 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'roles', 'webserver', 'tasks', 'main.yml'), [
      '- name: install nginx',
      '  apt:',
      '    name: nginx',
      '    state: present',
      '',
      '- name: start nginx',
      '  service:',
      '    name: nginx',
      '    state: started',
      '',
    ].join('\n'));

    const analyzer = new AnsibleAnalyzer();
    const cas = await analyzer.analyze({ projectPath: dir });

    const play = cas.nodes.find(n => n.type === 'ansible_play');
    assert.ok(play, 'play node exists');
    assert.equal(play?.metadata?.attributes?.hosts, 'webservers');

    const roleRef = cas.nodes.find(n => n.type === 'ansible_role_reference' && n.name === 'webserver');
    assert.ok(roleRef, 'role reference node exists');

    const dependsOnEdge = cas.edges.find(e => e.type === 'depends_on' && e.source === play!.id && e.target === roleRef!.id);
    assert.ok(dependsOnEdge, 'play depends_on role reference edge exists');

    const role = cas.nodes.find(n => n.type === 'ansible_role' && n.name === 'webserver');
    assert.ok(role, 'role node exists from role tasks file');

    const tasks = cas.nodes.filter(n => n.type === 'ansible_task');
    assert.equal(tasks.length, 2, 'both tasks extracted');
    const aptTask = tasks.find(t => t.metadata?.attributes?.ansible_module === 'apt');
    assert.ok(aptTask, 'apt task extracted with module metadata');

    const entryPoint = cas.entry_points.find(e => e.type === 'cli');
    assert.ok(entryPoint, 'ansible-playbook cli entry point exists');

    const exitPoint = cas.exit_points.find(e => e.name.includes('apt'));
    assert.ok(exitPoint, 'apt module exit point exists');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Pulumi
// ---------------------------------------------------------------------------

test('PulumiAnalyzer.canAnalyze requires a Pulumi.yaml project file', async () => {
  const dir = tempDir('pulumi-test');
  try {
    const analyzer = new PulumiAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), false);

    fs.writeFileSync(path.join(dir, 'Pulumi.yaml'), 'name: my-infra\nruntime: nodejs\n');
    assert.equal(await analyzer.canAnalyze(dir), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PulumiAnalyzer.analyze extracts project + resources + a reference edge (TS)', async () => {
  const dir = tempDir('pulumi-test');
  try {
    fs.writeFileSync(path.join(dir, 'Pulumi.yaml'), 'name: my-infra\nruntime: nodejs\n');
    fs.writeFileSync(path.join(dir, 'index.ts'), [
      "import * as aws from '@pulumi/aws';",
      '',
      "const bucket = new aws.s3.Bucket('my-bucket');",
      "const bucketPolicy = new aws.s3.BucketPolicy('my-bucket-policy', {",
      '  bucket: bucket.id,',
      '});',
      '',
    ].join('\n'));

    const analyzer = new PulumiAnalyzer();
    const cas = await analyzer.analyze({ projectPath: dir });

    const project = cas.nodes.find(n => n.type === 'pulumi_project');
    assert.ok(project, 'pulumi project node exists');
    assert.equal(project?.name, 'my-infra');

    const resources = cas.nodes.filter(n => n.type === 'infrastructure_resource');
    assert.equal(resources.length, 2, 'two resources declared');

    const bucket = resources.find(r => r.qualified_name?.endsWith('#bucket'));
    const policy = resources.find(r => r.qualified_name?.endsWith('#bucketPolicy'));
    assert.ok(bucket && policy, 'both resource nodes found by variable name');

    const refEdge = cas.edges.find(e => e.type === 'depends_on' && e.source === policy!.id && e.target === bucket!.id);
    assert.ok(refEdge, 'bucketPolicy depends_on bucket via bucket.id reference');

    const exitPoints = cas.exit_points.filter(e => e.target?.sdk === 'Pulumi provider');
    assert.equal(exitPoints.length, 2, 'each resource provisions via a Pulumi provider exit point');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Helm
// ---------------------------------------------------------------------------

test('HelmAnalyzer.canAnalyze detects a chart', async () => {
  const dir = tempDir('helm-test');
  try {
    const analyzer = new HelmAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), false);

    fs.writeFileSync(path.join(dir, 'Chart.yaml'), 'apiVersion: v2\nname: orders\nversion: 0.1.0\nappVersion: "1.0.0"\n');
    assert.equal(await analyzer.canAnalyze(dir), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HelmAnalyzer.analyze extracts chart, values, and templated Deployment+Service', async () => {
  const dir = tempDir('helm-test');
  try {
    fs.writeFileSync(path.join(dir, 'Chart.yaml'), 'apiVersion: v2\nname: orders\nversion: 0.1.0\nappVersion: "1.0.0"\n');
    fs.writeFileSync(path.join(dir, 'values.yaml'), [
      'replicaCount: 2',
      '',
      'image:',
      '  repository: ghcr.io/example/orders',
      '  tag: "1.0.0"',
      '',
      'service:',
      '  type: ClusterIP',
      '  port: 8080',
      '',
    ].join('\n'));

    fs.mkdirSync(path.join(dir, 'templates'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'templates', 'deployment.yaml'), [
      'apiVersion: apps/v1',
      'kind: Deployment',
      'metadata:',
      '  name: {{ .Chart.Name }}',
      'spec:',
      '  replicas: {{ .Values.replicaCount }}',
      '  template:',
      '    spec:',
      '      containers:',
      '        - name: {{ .Chart.Name }}',
      '          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"',
      '          ports:',
      '            - containerPort: {{ .Values.service.port }}',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'templates', 'service.yaml'), [
      'apiVersion: v1',
      'kind: Service',
      'metadata:',
      '  name: {{ .Chart.Name }}',
      'spec:',
      '  type: {{ .Values.service.type }}',
      '  ports:',
      '    - port: {{ .Values.service.port }}',
      '',
    ].join('\n'));

    const analyzer = new HelmAnalyzer();
    const cas = await analyzer.analyze({ projectPath: dir });

    const chart = cas.nodes.find(n => n.type === 'helm_chart');
    assert.ok(chart, 'chart node exists');
    assert.equal(chart?.name, 'orders');

    const values = cas.nodes.find(n => n.type === 'helm_values');
    assert.ok(values, 'values node exists');

    const deployment = cas.nodes.find(n => n.type === 'kubernetes_deployment');
    const service = cas.nodes.find(n => n.type === 'kubernetes_service');
    assert.ok(deployment, 'templated Deployment resource extracted');
    assert.ok(service, 'templated Service resource extracted');

    const containsEdges = cas.edges.filter(e => e.type === 'contains' && e.source === chart!.id);
    const containsTargets = new Set(containsEdges.map(e => e.target));
    assert.ok(containsTargets.has(values!.id), 'chart contains values');
    assert.ok(containsTargets.has(deployment!.id), 'chart contains deployment');
    assert.ok(containsTargets.has(service!.id), 'chart contains service');

    const httpEntry = cas.entry_points.find(e => e.type === 'http');
    assert.ok(httpEntry, 'Service exposes an http entry point');

    const workloadExit = cas.exit_points.find(e => e.target?.resource === 'Deployment');
    assert.ok(workloadExit, 'Deployment produces a workload exit point');

    const installEntry = cas.entry_points.find(e => e.name.includes('helm install'));
    assert.ok(installEntry, 'helm install cli entry point exists');

    // Render-or-fallback: a `{{ .Chart.Name }}` metadata.name never survives
    // raw into a node's display name (the hash-shaped-tokens-leak-into-labels
    // class, Helm variant — see SPEC-DEPLOYABLE-DETECTION.md defect log).
    assert.ok(!deployment!.name.includes('{{'), `deployment name must not contain a raw template token, got: ${deployment!.name}`);
    assert.ok(!service!.name.includes('{{'), `service name must not contain a raw template token, got: ${service!.name}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HelmAnalyzer.analyze resolves unrenderable `{{ include ... }}` names to a stable chart+kind fallback, honoring fullnameOverride', async () => {
  const dir = tempDir('helm-test');
  try {
    fs.writeFileSync(dir + '/Chart.yaml', 'apiVersion: v2\nname: backend\nversion: 0.1.0\n');
    fs.writeFileSync(dir + '/values.yaml', 'fullnameOverride: truckspyapp-backend\n');

    fs.mkdirSync(path.join(dir, 'templates'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'templates', 'deployment.yaml'), [
      'apiVersion: apps/v1',
      'kind: Deployment',
      'metadata:',
      '  name: {{ include "backend.fullname" . }}',
      'spec:',
      '  template:',
      '    spec:',
      '      containers:',
      '        - name: app',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'templates', 'serviceaccount.yaml'), [
      'apiVersion: v1',
      'kind: ServiceAccount',
      'metadata:',
      '  name: {{ include "backend.serviceAccountName" . }}',
      '',
    ].join('\n'));

    const analyzer = new HelmAnalyzer();
    const cas = await analyzer.analyze({ projectPath: dir });

    const deployment = cas.nodes.find(n => n.type === 'kubernetes_deployment');
    const serviceAccount = cas.nodes.find(n => n.type === 'kubernetes_serviceaccount');
    assert.ok(deployment, 'templated Deployment resource extracted');
    assert.ok(serviceAccount, 'templated ServiceAccount resource extracted');

    // No raw `{{ }}` tokens anywhere in the resolved names.
    assert.ok(!deployment!.name.includes('{{'));
    assert.ok(!serviceAccount!.name.includes('{{'));
    // Fallback is stable and grounded in real evidence (fullnameOverride +
    // resource kind), not the unresolved template expression.
    assert.equal(deployment!.name, 'Deployment: truckspyapp-backend-deployment');
    assert.equal(serviceAccount!.name, 'ServiceAccount: truckspyapp-backend-serviceaccount');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
