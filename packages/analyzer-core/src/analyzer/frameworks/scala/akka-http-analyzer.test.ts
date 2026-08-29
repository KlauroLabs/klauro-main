import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import { AkkaHttpAnalyzer } from './akka-http-analyzer';

const BUILD_SBT = `name := "my-akka-app"

libraryDependencies += "com.typesafe.akka" %% "akka-http" % "10.5.0"
`;

const ROUTES_SCALA = `package com.example

import akka.http.scaladsl.server.Directives._

trait UserRoutes {

  val routes =
    pathPrefix("api") {
      path("users") {
        get {
          complete("list users")
        } ~
        post {
          complete("create user")
        }
      } ~
      path("users" / IntNumber) { id =>
        get {
          complete(s"user \${id}")
        } ~
        authenticateBasic("realm", myAuth) { user =>
          delete {
            complete("deleted")
          }
        }
      }
    }
}
`;

async function makeFixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'akka-http-analyzer-'));
  await fs.writeFile(path.join(dir, 'build.sbt'), BUILD_SBT);
  const src = path.join(dir, 'src', 'main', 'scala', 'com', 'example');
  await fs.ensureDir(src);
  await fs.writeFile(path.join(src, 'UserRoutes.scala'), ROUTES_SCALA);
  return dir;
}

test('canAnalyze: true for akka-http dependency in build.sbt', async () => {
  const dir = await makeFixture();
  try {
    assert.equal(await new AkkaHttpAnalyzer().canAnalyze(dir), true);
  } finally {
    await fs.remove(dir);
  }
});

test('canAnalyze: false for non-akka-http project', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'akka-http-neg-'));
  try {
    await fs.writeFile(path.join(dir, 'build.sbt'), 'name := "plain"');
    assert.equal(await new AkkaHttpAnalyzer().canAnalyze(dir), false);
  } finally {
    await fs.remove(dir);
  }
});

test('resolves nested pathPrefix/path DSL to full route paths, with auth scope', async () => {
  const dir = await makeFixture();
  try {
    const result = await new AkkaHttpAnalyzer().analyze({ projectPath: dir });

    const nodeIds = new Set(result.nodes.map(node => node.id));
    const fileNodeId = 'file_src_main_scala_com_example_UserRoutes_scala';
    assert.ok(nodeIds.has(fileNodeId), 'expected the framework contribution to own its route source file');
    for (const edge of result.edges) {
      assert.ok(nodeIds.has(edge.source), `edge ${edge.id} has unresolved source ${edge.source}`);
      assert.ok(nodeIds.has(edge.target), `edge ${edge.id} has unresolved target ${edge.target}`);
    }

    const routeNodes = result.nodes.filter(n => n.type === 'route');
    const labels = routeNodes.map(n => n.name).sort();
    assert.ok(labels.includes('GET /api/users'), `expected GET /api/users, got ${JSON.stringify(labels)}`);
    assert.ok(labels.includes('POST /api/users'), `expected POST /api/users, got ${JSON.stringify(labels)}`);
    assert.ok(labels.includes('GET /api/users/:param'), `expected GET /api/users/:param, got ${JSON.stringify(labels)}`);
    assert.ok(labels.includes('DELETE /api/users/:param'), `expected DELETE /api/users/:param, got ${JSON.stringify(labels)}`);

    const deleteEntry = result.entry_points.find(
      ep => ep.type === 'http' && ep.trigger?.method === 'DELETE'
    );
    assert.ok(deleteEntry, 'expected a DELETE entry point');
    assert.equal(deleteEntry?.security?.authenticated, true, 'expected the route nested in authenticateBasic to be marked authenticated');

    const getUsersEntry = result.entry_points.find(
      ep => ep.type === 'http' && ep.trigger?.method === 'GET' && ep.trigger?.path === '/api/users'
    );
    assert.equal(getUsersEntry?.security?.authenticated, false);
  } finally {
    await fs.remove(dir);
  }
});
