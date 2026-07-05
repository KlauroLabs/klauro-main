import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import { PlayAnalyzer } from './play-analyzer';

const BUILD_SBT = `name := "my-play-app"
enablePlugins(PlayScala)

libraryDependencies += guice
`;

const ROUTES = `# Routes
# This file defines all application routes (Higher priority routes first)

GET     /                            controllers.HomeController.index()
GET     /users                       controllers.UserController.list()
GET     /users/:id                   controllers.UserController.show(id: Long)
POST    /users                       controllers.UserController.create()

# Sub-router include
->      /api                         api.Routes
`;

const USER_CONTROLLER = `package controllers

import javax.inject._
import play.api.mvc._

@Singleton
class UserController @Inject()(cc: ControllerComponents) extends AbstractController(cc) {

  def list() = Action {
    Ok("list")
  }

  def show(id: Long) = Action {
    Ok(s"show \$id")
  }

  def create() = Action {
    Ok("create")
  }
}
`;

const HOME_CONTROLLER = `package controllers

import javax.inject._
import play.api.mvc._

@Singleton
class HomeController @Inject()(cc: ControllerComponents) extends AbstractController(cc) {
  def index() = Action {
    Ok("index")
  }
}
`;

async function makeFixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'play-analyzer-'));
  await fs.writeFile(path.join(dir, 'build.sbt'), BUILD_SBT);
  await fs.ensureDir(path.join(dir, 'conf'));
  await fs.writeFile(path.join(dir, 'conf', 'routes'), ROUTES);
  const controllers = path.join(dir, 'app', 'controllers');
  await fs.ensureDir(controllers);
  await fs.writeFile(path.join(controllers, 'UserController.scala'), USER_CONTROLLER);
  await fs.writeFile(path.join(controllers, 'HomeController.scala'), HOME_CONTROLLER);
  return dir;
}

test('canAnalyze: true for conf/routes + PlayScala plugin', async () => {
  const dir = await makeFixture();
  try {
    assert.equal(await new PlayAnalyzer().canAnalyze(dir), true);
  } finally {
    await fs.remove(dir);
  }
});

test('canAnalyze: false for a routes-shaped file without Play signal', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'play-neg-'));
  try {
    // A routes file exists but there's no build.sbt Play plugin AND no controllers/ dir.
    await fs.ensureDir(path.join(dir, 'conf'));
    await fs.writeFile(path.join(dir, 'conf', 'routes'), 'GET /x foo.Bar(baz)');
    assert.equal(await new PlayAnalyzer().canAnalyze(dir), false);
  } finally {
    await fs.remove(dir);
  }
});

test('canAnalyze: false when no routes file at all', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'play-none-'));
  try {
    await fs.writeFile(path.join(dir, 'build.sbt'), BUILD_SBT);
    assert.equal(await new PlayAnalyzer().canAnalyze(dir), false);
  } finally {
    await fs.remove(dir);
  }
});

test('parses conf/routes as the router and resolves handlers to controller methods', async () => {
  const dir = await makeFixture();
  try {
    const result = await new PlayAnalyzer().analyze({ projectPath: dir });

    const routerFileNode = result.nodes.find(n => n.type === 'router' && n.name === 'conf/routes');
    assert.ok(routerFileNode, 'expected a router node for conf/routes itself');

    const routeNodes = result.nodes.filter(n => n.type === 'route');
    const labels = routeNodes.map(n => n.name).sort();
    assert.ok(labels.includes('GET /'), `expected GET /, got ${JSON.stringify(labels)}`);
    assert.ok(labels.includes('GET /users'));
    assert.ok(labels.includes('GET /users/:id'));
    assert.ok(labels.includes('POST /users'));

    const showEntry = result.entry_points.find(
      ep => ep.type === 'http' && ep.trigger?.method === 'GET' && ep.trigger?.path === '/users/:id'
    );
    assert.ok(showEntry, 'expected an http entry point for GET /users/:id');
    assert.equal(showEntry?.handler?.method_name, 'show');
    assert.equal(showEntry?.handler?.file, path.join('app', 'controllers', 'UserController.scala'));
    assert.ok((showEntry?.handler?.line ?? 0) > 0, 'expected the resolved handler to have a real line number');

    // The `->` sub-router include becomes a mounts edge, not a fabricated route.
    const mountsEdge = result.edges.find(e => e.type === 'mounts');
    assert.ok(mountsEdge, 'expected a mounts edge for the -> /api api.Routes include');
  } finally {
    await fs.remove(dir);
  }
});

test('marks handler as unresolved (never fabricated) when controller method cannot be found', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'play-unresolved-'));
  try {
    await fs.writeFile(path.join(dir, 'build.sbt'), BUILD_SBT);
    await fs.ensureDir(path.join(dir, 'conf'));
    await fs.writeFile(path.join(dir, 'conf', 'routes'), 'GET   /ghost   controllers.GhostController.phantom()\n');
    // No GhostController.scala file exists anywhere in the project.
    await fs.ensureDir(path.join(dir, 'app', 'controllers'));

    const result = await new PlayAnalyzer().analyze({ projectPath: dir });
    const routeNode = result.nodes.find(n => n.type === 'route');
    assert.ok(routeNode?.tags?.includes('unresolved-handler'));
    assert.equal(routeNode?.metadata?.attributes?.resolved, false);
  } finally {
    await fs.remove(dir);
  }
});
