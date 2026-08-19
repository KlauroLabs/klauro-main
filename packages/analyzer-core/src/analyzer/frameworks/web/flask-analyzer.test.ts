import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import { FlaskAnalyzer } from './flask-analyzer';

test('FlaskAnalyzer.canAnalyze detects a real Flask app (Flask(__name__) + @app.route)', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flask-analyzer-'));
  await fs.writeFile(
    path.join(root, 'app.py'),
    [
      'from flask import Flask, jsonify, request',
      '',
      'app = Flask(__name__)',
      '',
      "@app.route('/users', methods=['GET'])",
      'def list_users():',
      '    return jsonify([])',
    ].join('\n')
  );
  const analyzer = new FlaskAnalyzer();
  assert.equal(await analyzer.canAnalyze(root), true);
  await fs.remove(root);
});

test('FlaskAnalyzer.canAnalyze rejects a pyproject.toml [project.optional-dependencies] extras group named "flask" (self-detection defect: Klauro\'s own packages/klauro-sdk-py/pyproject.toml lists flask as an instrumentation-target extra with an empty real dependencies array)', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flask-analyzer-extras-'));
  await fs.writeFile(
    path.join(root, 'pyproject.toml'),
    [
      '[project]',
      'name = "klauro-telemetry"',
      'dependencies = []',
      '',
      '[project.optional-dependencies]',
      'flask = ["flask>=2.0"]',
    ].join('\n')
  );
  const analyzer = new FlaskAnalyzer();
  assert.equal(await analyzer.canAnalyze(root), false);
  await fs.remove(root);
});

test('FlaskAnalyzer.canAnalyze rejects a bare, function-scoped "from flask import" mention with no application construction (duck-typed integration-helper shape, live defect: packages/klauro-sdk-py/src/klauro_telemetry/middleware.py\'s `from flask import g, request  # local import; requires the flask extra` inside a framework-agnostic telemetry middleware that never constructs a Flask app)', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flask-analyzer-bare-import-'));
  await fs.writeFile(
    path.join(root, 'middleware.py'),
    [
      'def init_flask(app, client=None):',
      '    from flask import g, request  # local import; requires the flask extra',
      '',
      '    @app.before_request',
      '    def _before():',
      '        g._klauro_started_at = 0',
      '    return app',
    ].join('\n')
  );
  const analyzer = new FlaskAnalyzer();
  assert.equal(await analyzer.canAnalyze(root), false);
  await fs.remove(root);
});

test('FlaskAnalyzer.canAnalyze rejects a project without flask', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flask-analyzer-neg-'));
  await fs.writeFile(path.join(root, 'requirements.txt'), 'django==5.0.0\n');
  const analyzer = new FlaskAnalyzer();
  assert.equal(await analyzer.canAnalyze(root), false);
  await fs.remove(root);
});

test('FlaskAnalyzer resolves nested templates and represents missing templates without dangling edges', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flask-analyzer-templates-'));
  await fs.ensureDir(path.join(root, 'templates', 'admin'));
  await fs.writeFile(path.join(root, 'templates', 'admin', 'index.html'), '<h1>Admin</h1>');
  await fs.writeFile(path.join(root, 'app.py'), [
    'from flask import Flask, render_template',
    'app = Flask(__name__)',
    '@app.get("/admin")',
    'def admin():',
    '    return render_template("admin/index.html")',
    '@app.get("/missing")',
    'def missing():',
    '    return render_template("missing.html")',
  ].join('\n'));

  const contribution = await new FlaskAnalyzer().analyze({ projectPath: root } as any);
  const nodeIds = new Set((contribution.nodes || []).map(node => node.id));
  const renderEdges = (contribution.edges || []).filter(edge => edge.type === 'renders');

  assert.equal(renderEdges.length, 2);
  assert.equal(renderEdges.every(edge => nodeIds.has(edge.source) && nodeIds.has(edge.target)), true);
  assert.equal((contribution.nodes || []).some(node => node.name === 'admin/index.html' && node.source?.file === 'templates/admin/index.html'), true);
  assert.equal((contribution.nodes || []).some(node => node.name === 'missing.html' && node.metadata?.attributes?.resolution === 'unresolved-reference'), true);
  await fs.remove(root);
});
