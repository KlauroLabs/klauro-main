jest.unmock('fs-extra');
jest.unmock('fs');
jest.unmock('glob');

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ExpressAnalyzer } from '../../analyzer/frameworks/web/express-analyzer';
import { FlaskAnalyzer } from '../../analyzer/frameworks/web/flask-analyzer';
import { FastAPIAnalyzer } from '../../analyzer/frameworks/web/fastapi-analyzer';
import { ReactAnalyzer } from '../../analyzer/frameworks/web/react-analyzer';
import { VueAnalyzer } from '../../analyzer/frameworks/web/vue-analyzer';
import { RailsAnalyzer } from '../../analyzer/frameworks/web/rails-analyzer';
import { LaravelAnalyzer } from '../../analyzer/frameworks/web/laravel-analyzer';
import { DjangoAnalyzer } from '../../analyzer/frameworks/web/django-analyzer';
import { JestAnalyzer } from '../../analyzer/frameworks/testing/jest-analyzer';
import { CypressAnalyzer } from '../../analyzer/frameworks/testing/cypress-analyzer';

/**
 * Task #115: analyzers built `fullPath = path.join(projectPath, file)` to READ
 * a file and then also stored that absolute path in `source.file`, instead of
 * the repo-relative `file` already in scope at the same call site. The stored
 * path then leaks the analysis sandbox's local filesystem layout (temp dir,
 * username) into customer-visible output, and resolves for no consumer.
 *
 * The end-of-pipeline `relativizeProjectPaths` sweep hides this in the standard
 * orchestrator run, so the defect is only observable when an analyzer is driven
 * directly — which is exactly what these tests do. Each analyzer runs standalone
 * against a small on-disk fixture, and every `source.file` it emits must be
 * repo-relative.
 */
describe('framework analyzers record repo-relative source.file, never absolute', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'klauro-repo-relative-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const write = (relative: string, body: string) => {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  };

  const writeJson = (relative: string, value: unknown) =>
    write(relative, JSON.stringify(value, null, 2));

  /**
   * Every leaked source.file an analyzer emitted, with the node id for context.
   *
   * Gated on "absolute AND resolves under the project root", matching
   * checkSourcePathIntegrity: that is precisely the sandbox-layout leak. An
   * absolute-looking value that does NOT sit under the root is a different
   * thing (a genuinely external dependency, or — for Express/Flask route nodes
   * — an HTTP route path like "/orders" that POSIX considers absolute), and
   * flagging it here would conflate two separate defects.
   */
  const leakedSourceFiles = (nodes: Array<any>) =>
    nodes
      .filter(node => {
        const file = node?.source?.file;
        if (!file || !path.isAbsolute(file)) return false;
        const relative = path.relative(root, file);
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
      })
      .map(node => `${node.id} -> ${node.source.file}`);

  const runAnalyzer = async (analyzer: any) => {
    const contribution = await analyzer.analyze({
      projectPath: root,
      config: {},
      metadata: {},
    });
    return contribution?.nodes ?? [];
  };

  it('Express: router and route nodes stay repo-relative', async () => {
    writeJson('package.json', { name: 'fx', dependencies: { express: '^4.18.0' } });
    write(
      'src/routes/orders.js',
      [
        "const express = require('express');",
        'const router = express.Router();',
        "router.get('/orders', (req, res) => res.json([]));",
        "router.post('/orders', (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n')
    );
    write(
      'src/server.js',
      [
        "const express = require('express');",
        'const app = express();',
        "app.get('/health', (req, res) => res.send('ok'));",
        'app.listen(3000);',
      ].join('\n')
    );

    const nodes = await runAnalyzer(new ExpressAnalyzer());
    expect(nodes.length).toBeGreaterThan(0);
    expect(leakedSourceFiles(nodes)).toEqual([]);
  });

  it('Flask: app, blueprint and route nodes stay repo-relative', async () => {
    write('requirements.txt', 'flask==3.0.0\n');
    write(
      'app.py',
      [
        'from flask import Flask',
        'app = Flask(__name__)',
        '',
        "@app.route('/health')",
        'def health():',
        "    return 'ok'",
      ].join('\n')
    );

    const nodes = await runAnalyzer(new FlaskAnalyzer());
    expect(leakedSourceFiles(nodes)).toEqual([]);
  });

  it('FastAPI: app and route nodes stay repo-relative', async () => {
    write('requirements.txt', 'fastapi==0.110.0\n');
    write(
      'main.py',
      [
        'from fastapi import FastAPI',
        'app = FastAPI()',
        '',
        "@app.get('/items')",
        'async def list_items():',
        '    return []',
      ].join('\n')
    );

    const nodes = await runAnalyzer(new FastAPIAnalyzer());
    expect(leakedSourceFiles(nodes)).toEqual([]);
  });

  it('React: component nodes stay repo-relative', async () => {
    writeJson('package.json', { name: 'fx', dependencies: { react: '^18.0.0' } });
    write(
      'src/App.jsx',
      [
        "import React, { useState } from 'react';",
        'export default function App() {',
        '  const [count, setCount] = useState(0);',
        '  return <button onClick={() => setCount(count + 1)}>{count}</button>;',
        '}',
      ].join('\n')
    );

    const nodes = await runAnalyzer(new ReactAnalyzer());
    expect(leakedSourceFiles(nodes)).toEqual([]);
  });

  it('Vue: component nodes stay repo-relative', async () => {
    writeJson('package.json', { name: 'fx', dependencies: { vue: '^3.4.0' } });
    write(
      'src/HelloWorld.vue',
      [
        '<template><div>{{ msg }}</div></template>',
        '<script>',
        "export default { name: 'HelloWorld', props: { msg: String } };",
        '</script>',
      ].join('\n')
    );

    const nodes = await runAnalyzer(new VueAnalyzer());
    expect(leakedSourceFiles(nodes)).toEqual([]);
  });

  it('Rails: route and model nodes stay repo-relative', async () => {
    write('Gemfile', "source 'https://rubygems.org'\ngem 'rails'\n");
    write(
      'config/routes.rb',
      ['Rails.application.routes.draw do', '  resources :orders', 'end'].join('\n')
    );
    write('app/models/order.rb', 'class Order < ApplicationRecord\nend\n');
    write(
      'app/controllers/orders_controller.rb',
      'class OrdersController < ApplicationController\n  def index\n  end\nend\n'
    );
    write(
      'db/schema.rb',
      [
        'ActiveRecord::Schema.define(version: 1) do',
        '  create_table "orders", force: :cascade do |t|',
        '    t.string "name"',
        '  end',
        'end',
      ].join('\n')
    );

    const nodes = await runAnalyzer(new RailsAnalyzer());
    expect(leakedSourceFiles(nodes)).toEqual([]);
  });

  it('Laravel: route and controller nodes stay repo-relative', async () => {
    writeJson('composer.json', { require: { 'laravel/framework': '^10.0' } });
    write(
      'routes/web.php',
      ['<?php', "Route::get('/orders', [OrderController::class, 'index']);"].join('\n')
    );
    write(
      'app/Http/Controllers/OrderController.php',
      ['<?php', 'class OrderController extends Controller {', '  public function index() {}', '}'].join('\n')
    );

    const nodes = await runAnalyzer(new LaravelAnalyzer());
    expect(leakedSourceFiles(nodes)).toEqual([]);
  });

  it('Django: project/settings nodes stay repo-relative', async () => {
    write('requirements.txt', 'django==5.0\n');
    write('manage.py', 'import django\n');
    write(
      'mysite/settings.py',
      ['INSTALLED_APPS = [', "    'django.contrib.admin',", ']', "ROOT_URLCONF = 'mysite.urls'"].join('\n')
    );
    write(
      'mysite/urls.py',
      ['from django.urls import path', 'urlpatterns = [', ']'].join('\n')
    );

    const nodes = await runAnalyzer(new DjangoAnalyzer());
    expect(leakedSourceFiles(nodes)).toEqual([]);
  });

  it('Jest: config and test-suite nodes stay repo-relative', async () => {
    writeJson('package.json', { name: 'fx', devDependencies: { jest: '^29.0.0' } });
    write('jest.config.js', "module.exports = { testEnvironment: 'node' };\n");
    write(
      'src/__tests__/sample.test.js',
      ["describe('sample', () => {", "  it('works', () => { expect(1).toBe(1); });", '});'].join('\n')
    );

    const nodes = await runAnalyzer(new JestAnalyzer());
    expect(leakedSourceFiles(nodes)).toEqual([]);
  });

  it('Cypress: config, spec and fixture nodes stay repo-relative', async () => {
    writeJson('package.json', { name: 'fx', devDependencies: { cypress: '^13.0.0' } });
    write('cypress.config.js', "module.exports = { e2e: { baseUrl: 'http://localhost:3000' } };\n");
    write(
      'cypress/e2e/orders.cy.js',
      ["describe('orders', () => {", "  it('loads', () => { cy.visit('/orders'); });", '});'].join('\n')
    );
    writeJson('cypress/fixtures/orders.json', { orders: [] });

    const nodes = await runAnalyzer(new CypressAnalyzer());
    expect(leakedSourceFiles(nodes)).toEqual([]);
  });
});
