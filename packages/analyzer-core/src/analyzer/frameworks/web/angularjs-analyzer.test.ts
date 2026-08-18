import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { AngularJsAnalyzer } from './angularjs-analyzer';

test('AngularJsAnalyzer emits modules, registrations, routes, controllers, and HTTP exits', async () => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'angularjs-analyzer-'));
  try {
    await fs.writeFile(path.join(projectPath, 'module.js'), "angular.module('owners', ['ui.router']);\n");
    await fs.writeFile(path.join(projectPath, 'component.js'), [
      "angular.module('owners').component('ownerDetails', {",
      "  templateUrl: 'owner-details.html',",
      "  controller: 'OwnerDetailsController'",
      '});',
    ].join('\n'));
    await fs.writeFile(path.join(projectPath, 'controller.js'), [
      "angular.module('owners').controller('OwnerDetailsController', function ($http) {",
      "  $http.get('/api/owners');",
      '});',
    ].join('\n'));
    await fs.writeFile(path.join(projectPath, 'routes.js'), [
      "angular.module('owners').config(function ($stateProvider) {",
      "  $stateProvider.state('owners.detail', { url: '/owners/:id', component: 'ownerDetails' });",
      '});',
    ].join('\n'));

    const analyzer = new AngularJsAnalyzer();
    assert.equal(await analyzer.canAnalyze(projectPath), true);
    const result = await analyzer.analyze({ projectPath });
    const nodeIds = new Set(result.nodes.map(node => node.id));
    const moduleNode = result.nodes.find(node => node.type === 'angularjs_module' && node.name === 'owners');
    const componentNode = result.nodes.find(node => node.type === 'angularjs_component' && node.name === 'ownerDetails');
    const controllerNode = result.nodes.find(node => node.type === 'angularjs_controller' && node.name === 'OwnerDetailsController');

    assert.ok(moduleNode);
    assert.equal(moduleNode.source?.file, 'module.js');
    assert.ok(componentNode);
    assert.ok(controllerNode);
    assert.ok(result.edges.some(edge => edge.source === componentNode.id && edge.target === controllerNode.id));
    assert.ok(result.entry_points.some(entry => entry.type === 'route' && entry.trigger?.path === '/owners/:id'));
    assert.ok(result.exit_points.some(exit => exit.source_node === controllerNode.id && exit.name === 'GET /api/owners'));
    assert.ok(result.edges.every(edge => nodeIds.has(edge.source) && nodeIds.has(edge.target)));
    assert.ok(result.exit_points.every(exit => nodeIds.has(exit.source_node)));
  } finally {
    await fs.remove(projectPath);
  }
});
