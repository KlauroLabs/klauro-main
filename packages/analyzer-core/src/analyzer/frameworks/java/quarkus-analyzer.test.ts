import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import { QuarkusAnalyzer } from './quarkus-analyzer';

const POM = `<?xml version="1.0"?>
<project>
  <groupId>org.acme</groupId>
  <artifactId>getting-started</artifactId>
  <dependencies>
    <dependency>
      <groupId>io.quarkus</groupId>
      <artifactId>quarkus-resteasy-reactive</artifactId>
    </dependency>
    <dependency>
      <groupId>io.quarkus</groupId>
      <artifactId>quarkus-hibernate-orm-panache</artifactId>
    </dependency>
  </dependencies>
</project>
`;

const RESOURCE = `package org.acme;

import jakarta.ws.rs.GET;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.core.MediaType;
import jakarta.inject.Inject;
import jakarta.enterprise.context.ApplicationScoped;

@Path("/fruits")
@ApplicationScoped
public class FruitResource {

    @Inject
    FruitRepository fruitRepository;

    @GET
    @Produces(MediaType.APPLICATION_JSON)
    public java.util.List<Fruit> list() {
        return Fruit.listAll();
    }

    @POST
    @Path("/add")
    public Fruit add(Fruit fruit) {
        fruit.persist();
        return fruit;
    }
}
`;

const ENTITY = `package org.acme;

import jakarta.persistence.Entity;
import io.quarkus.hibernate.orm.panache.PanacheEntity;

@Entity
public class Fruit extends PanacheEntity {
    public String name;
    public String color;
}
`;

const REPOSITORY = `package org.acme;

import jakarta.enterprise.context.ApplicationScoped;
import io.quarkus.hibernate.orm.panache.PanacheRepository;

@ApplicationScoped
public class FruitRepository implements PanacheRepository<Fruit> {
}
`;

const SCHEDULED = `package org.acme;

import io.quarkus.scheduler.Scheduled;
import jakarta.enterprise.context.ApplicationScoped;

@ApplicationScoped
public class CounterBean {
    @Scheduled(every = "10s")
    void increment() {
    }
}
`;

async function makeFixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quarkus-analyzer-'));
  await fs.writeFile(path.join(dir, 'pom.xml'), POM);
  const src = path.join(dir, 'src', 'main', 'java', 'org', 'acme');
  await fs.ensureDir(src);
  await fs.writeFile(path.join(src, 'FruitResource.java'), RESOURCE);
  await fs.writeFile(path.join(src, 'Fruit.java'), ENTITY);
  await fs.writeFile(path.join(src, 'FruitRepository.java'), REPOSITORY);
  await fs.writeFile(path.join(src, 'CounterBean.java'), SCHEDULED);
  return dir;
}

test('canAnalyze: true for io.quarkus in pom.xml', async () => {
  const dir = await makeFixture();
  try {
    assert.equal(await new QuarkusAnalyzer().canAnalyze(dir), true);
  } finally {
    await fs.remove(dir);
  }
});

test('canAnalyze: true for JAX-RS imports without quarkus dep', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quarkus-jaxrs-'));
  try {
    const src = path.join(dir, 'src');
    await fs.ensureDir(src);
    await fs.writeFile(path.join(src, 'X.java'), 'import jakarta.ws.rs.GET;\npublic class X {}\n');
    assert.equal(await new QuarkusAnalyzer().canAnalyze(dir), true);
  } finally {
    await fs.remove(dir);
  }
});

test('canAnalyze: false for non-quarkus project', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quarkus-neg-'));
  try {
    await fs.writeFile(path.join(dir, 'pom.xml'), '<project><artifactId>plain</artifactId></project>');
    assert.equal(await new QuarkusAnalyzer().canAnalyze(dir), false);
  } finally {
    await fs.remove(dir);
  }
});

test('extracts JAX-RS routes + entry points with resolved class+method path', async () => {
  const dir = await makeFixture();
  try {
    const result = await new QuarkusAnalyzer().analyze({ projectPath: dir });

    const routeNodes = result.nodes.filter(n => n.type === 'route');
    const labels = routeNodes.map(n => n.name).sort();
    assert.ok(labels.includes('GET /fruits'), `expected GET /fruits, got ${JSON.stringify(labels)}`);
    assert.ok(labels.includes('POST /fruits/add'), `expected POST /fruits/add, got ${JSON.stringify(labels)}`);

    const getEntry = result.entry_points.find(
      ep => ep.type === 'http' && ep.trigger?.method === 'GET' && ep.trigger?.path === '/fruits'
    );
    assert.ok(getEntry, 'expected an http entry point for GET /fruits');
    assert.equal(getEntry?.handler?.method_name, 'list');
  } finally {
    await fs.remove(dir);
  }
});

test('extracts Panache entity, repository, CDI bean and scheduled job', async () => {
  const dir = await makeFixture();
  try {
    const result = await new QuarkusAnalyzer().analyze({ projectPath: dir });

    const entity = result.nodes.find(n => n.type === 'model' && n.name === 'Fruit');
    assert.ok(entity, 'expected a Fruit data-entity node');
    assert.equal((entity?.metadata as any)?.attributes?.kind, 'panache-entity');

    const repo = result.nodes.find(n => n.type === 'repository' && n.name === 'FruitRepository');
    assert.ok(repo, 'expected a FruitRepository repository node');

    const bean = result.nodes.find(n => n.type === 'bean' && n.name === 'FruitResource');
    assert.ok(bean, 'expected a FruitResource CDI bean node');

    const scheduled = result.entry_points.find(ep => ep.type === 'schedule');
    assert.ok(scheduled, 'expected a scheduled entry point');
    assert.equal(scheduled?.handler?.method_name, 'increment');

    const dbExit = result.exit_points.find(ep => ep.type === 'database');
    assert.ok(dbExit, 'expected a database exit point');
  } finally {
    await fs.remove(dir);
  }
});

test('incremental: analyzeFileSingle matches full analyze for one resource', async () => {
  const dir = await makeFixture();
  try {
    const analyzer = new QuarkusAnalyzer();
    assert.equal(analyzer.supportsIncrementalAnalysis(), true);

    const relevant = await analyzer.getRelevantFiles(dir);
    assert.ok(relevant.includes('src/main/java/org/acme/FruitResource.java'));

    const rel = 'src/main/java/org/acme/FruitResource.java';
    const single = await analyzer.analyzeFileSingle({
      projectPath: dir,
      filePath: path.join(dir, rel),
      relativePath: rel,
    });
    const singleRoutes = single.nodes.filter(n => n.type === 'route').map(n => n.name).sort();
    assert.deepEqual(singleRoutes, ['GET /fruits', 'POST /fruits/add']);
  } finally {
    await fs.remove(dir);
  }
});
