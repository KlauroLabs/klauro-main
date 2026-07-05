import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import { VertxAnalyzer } from './vertx-analyzer';

const POM = `<?xml version="1.0"?>
<project>
  <groupId>com.example</groupId>
  <artifactId>vertx-app</artifactId>
  <dependencies>
    <dependency>
      <groupId>io.vertx</groupId>
      <artifactId>vertx-web</artifactId>
    </dependency>
  </dependencies>
</project>
`;

const MAIN_VERTICLE = `package com.example;

import io.vertx.core.AbstractVerticle;
import io.vertx.core.http.HttpMethod;
import io.vertx.ext.web.Router;
import io.vertx.ext.web.handler.JWTAuthHandler;

public class MainVerticle extends AbstractVerticle {

    @Override
    public void start() {
        Router router = Router.router(vertx);

        router.get("/users").handler(this::listUsers);
        router.post("/users").handler(this::createUser);

        router.route("/admin")
            .method(HttpMethod.GET)
            .handler(JWTAuthHandler.create(null))
            .handler(this::adminPanel);

        vertx.eventBus().consumer("user.created", this::onUserCreated);
        vertx.eventBus().send("audit.log", "user created");

        vertx.createHttpServer().requestHandler(router).listen(8080);
    }

    private void listUsers(io.vertx.ext.web.RoutingContext ctx) {}
    private void createUser(io.vertx.ext.web.RoutingContext ctx) {}
    private void adminPanel(io.vertx.ext.web.RoutingContext ctx) {}
    private void onUserCreated(io.vertx.core.eventbus.Message<Object> msg) {}
}
`;

async function makeFixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vertx-analyzer-'));
  await fs.writeFile(path.join(dir, 'pom.xml'), POM);
  const src = path.join(dir, 'src', 'main', 'java', 'com', 'example');
  await fs.ensureDir(src);
  await fs.writeFile(path.join(src, 'MainVerticle.java'), MAIN_VERTICLE);
  return dir;
}

test('canAnalyze: true for io.vertx dependency', async () => {
  const dir = await makeFixture();
  try {
    assert.equal(await new VertxAnalyzer().canAnalyze(dir), true);
  } finally {
    await fs.remove(dir);
  }
});

test('canAnalyze: false for non-vertx project', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vertx-neg-'));
  try {
    await fs.writeFile(path.join(dir, 'pom.xml'), '<project><artifactId>plain</artifactId></project>');
    assert.equal(await new VertxAnalyzer().canAnalyze(dir), false);
  } finally {
    await fs.remove(dir);
  }
});

test('extracts router, direct + generic routes, and event-bus consumer/publish', async () => {
  const dir = await makeFixture();
  try {
    const result = await new VertxAnalyzer().analyze({ projectPath: dir });

    const routerNode = result.nodes.find(n => n.type === 'router');
    assert.ok(routerNode, 'expected a Router node');

    const routeNodes = result.nodes.filter(n => n.type === 'route');
    const labels = routeNodes.map(n => n.name).sort();
    assert.ok(labels.includes('GET /users'), `expected GET /users, got ${JSON.stringify(labels)}`);
    assert.ok(labels.includes('POST /users'), `expected POST /users, got ${JSON.stringify(labels)}`);
    assert.ok(labels.includes('GET /admin'), `expected GET /admin, got ${JSON.stringify(labels)}`);

    const listUsersEntry = result.entry_points.find(
      ep => ep.type === 'http' && ep.trigger?.method === 'GET' && ep.trigger?.path === '/users'
    );
    assert.ok(listUsersEntry, 'expected an http entry point for GET /users');
    assert.equal(listUsersEntry?.handler?.method_name, 'this::listUsers');

    const adminEntry = result.entry_points.find(
      ep => ep.type === 'http' && ep.trigger?.path === '/admin'
    );
    assert.equal(adminEntry?.security?.authenticated, true, 'expected /admin to be marked authenticated via JWTAuthHandler');

    const consumerEntry = result.entry_points.find(ep => ep.metadata?.kind === 'eventbus-consumer');
    assert.ok(consumerEntry, 'expected an event-bus consumer entry point');
    assert.equal(consumerEntry?.metadata?.address, 'user.created');

    const publishExit = result.exit_points.find(ep => ep.metadata?.kind === 'send');
    assert.ok(publishExit, 'expected an event-bus send exit point');
    assert.equal(publishExit?.metadata?.address, 'audit.log');
  } finally {
    await fs.remove(dir);
  }
});
