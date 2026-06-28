import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import { MicronautAnalyzer } from './micronaut-analyzer';

const BUILD_GRADLE = `plugins {
  id("io.micronaut.application") version "4.4.0"
}
dependencies {
  implementation("io.micronaut:micronaut-http-server-netty")
  implementation("io.micronaut.data:micronaut-data-jdbc")
}
`;

const CONTROLLER = `package org.acme;

import io.micronaut.http.annotation.Controller;
import io.micronaut.http.annotation.Get;
import io.micronaut.http.annotation.Post;
import jakarta.inject.Inject;

@Controller("/books")
public class BookController {

    @Inject
    BookRepository bookRepository;

    @Get("/list")
    public java.util.List<Book> list() {
        return bookRepository.findAll();
    }

    @Post
    public Book add(Book book) {
        return bookRepository.save(book);
    }
}
`;

const ENTITY = `package org.acme;

import io.micronaut.data.annotation.MappedEntity;
import io.micronaut.data.annotation.Id;

@MappedEntity
public class Book {
    @Id
    private Long id;
    private String title;
    private String author;
}
`;

const REPOSITORY = `package org.acme;

import io.micronaut.data.jdbc.annotation.JdbcRepository;
import io.micronaut.data.annotation.Repository;
import io.micronaut.data.repository.CrudRepository;

@Repository
public interface BookRepository extends CrudRepository<Book, Long> {
}
`;

const SERVICE = `package org.acme;

import jakarta.inject.Singleton;
import io.micronaut.scheduling.annotation.Scheduled;

@Singleton
public class InventoryService {

    @Inject
    BookRepository bookRepository;

    @Scheduled(fixedRate = "1m")
    void reconcile() {
    }
}
`;

const CLIENT = `package org.acme;

import io.micronaut.http.client.annotation.Client;
import io.micronaut.http.annotation.Get;

@Client("inventory")
public interface InventoryClient {
    @Get("/status")
    String status();
}
`;

async function makeFixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'micronaut-analyzer-'));
  await fs.writeFile(path.join(dir, 'build.gradle'), BUILD_GRADLE);
  const src = path.join(dir, 'src', 'main', 'java', 'org', 'acme');
  await fs.ensureDir(src);
  await fs.writeFile(path.join(src, 'BookController.java'), CONTROLLER);
  await fs.writeFile(path.join(src, 'Book.java'), ENTITY);
  await fs.writeFile(path.join(src, 'BookRepository.java'), REPOSITORY);
  await fs.writeFile(path.join(src, 'InventoryService.java'), SERVICE);
  await fs.writeFile(path.join(src, 'InventoryClient.java'), CLIENT);
  return dir;
}

test('canAnalyze: true for io.micronaut in build.gradle', async () => {
  const dir = await makeFixture();
  try {
    assert.equal(await new MicronautAnalyzer().canAnalyze(dir), true);
  } finally {
    await fs.remove(dir);
  }
});

test('canAnalyze: true for io.micronaut import without build dep', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'micronaut-src-'));
  try {
    const src = path.join(dir, 'src');
    await fs.ensureDir(src);
    await fs.writeFile(path.join(src, 'X.java'),
      'import io.micronaut.http.annotation.Controller;\n@Controller("/x")\npublic class X {}\n');
    assert.equal(await new MicronautAnalyzer().canAnalyze(dir), true);
  } finally {
    await fs.remove(dir);
  }
});

test('canAnalyze: false for non-micronaut project', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'micronaut-neg-'));
  try {
    await fs.writeFile(path.join(dir, 'build.gradle'), 'dependencies { implementation("org.springframework.boot:x") }');
    assert.equal(await new MicronautAnalyzer().canAnalyze(dir), false);
  } finally {
    await fs.remove(dir);
  }
});

test('extracts controller routes + entry points with resolved base+sub path', async () => {
  const dir = await makeFixture();
  try {
    const result = await new MicronautAnalyzer().analyze({ projectPath: dir });

    const routeLabels = result.nodes.filter(n => n.type === 'route').map(n => n.name).sort();
    assert.ok(routeLabels.includes('GET /books/list'), `expected GET /books/list, got ${JSON.stringify(routeLabels)}`);
    assert.ok(routeLabels.includes('POST /books'), `expected POST /books, got ${JSON.stringify(routeLabels)}`);

    const listEntry = result.entry_points.find(
      ep => ep.type === 'http' && ep.trigger?.method === 'GET' && ep.trigger?.path === '/books/list'
    );
    assert.ok(listEntry, 'expected http entry point for GET /books/list');
    assert.equal(listEntry?.handler?.method_name, 'list');
  } finally {
    await fs.remove(dir);
  }
});

test('extracts mapped entity, repository, singleton bean, scheduled job and client', async () => {
  const dir = await makeFixture();
  try {
    const result = await new MicronautAnalyzer().analyze({ projectPath: dir });

    const entity = result.nodes.find(n => n.type === 'model' && n.name === 'Book');
    assert.ok(entity, 'expected a Book entity node');
    assert.equal((entity?.metadata as any)?.attributes?.kind, 'mapped-entity');

    const repo = result.nodes.find(n => n.type === 'repository' && n.name === 'BookRepository');
    assert.ok(repo, 'expected a BookRepository repository node');
    assert.equal((repo?.metadata as any)?.attributes?.entityType, 'Book');

    const bean = result.nodes.find(n => n.type === 'bean' && n.name === 'InventoryService');
    assert.ok(bean, 'expected an InventoryService bean node');

    const scheduled = result.entry_points.find(ep => ep.type === 'schedule');
    assert.ok(scheduled, 'expected a scheduled entry point');
    assert.equal(scheduled?.handler?.method_name, 'reconcile');

    const client = result.nodes.find(n => n.type === 'external-service' && n.name === 'InventoryClient');
    assert.ok(client, 'expected an InventoryClient external-service node');
    assert.equal((client?.metadata as any)?.attributes?.serviceId, 'inventory');
  } finally {
    await fs.remove(dir);
  }
});

test('incremental: analyzeFileSingle matches full analyze for one controller', async () => {
  const dir = await makeFixture();
  try {
    const analyzer = new MicronautAnalyzer();
    assert.equal(analyzer.supportsIncrementalAnalysis(), true);

    const relevant = await analyzer.getRelevantFiles(dir);
    assert.ok(relevant.includes('src/main/java/org/acme/BookController.java'));

    const rel = 'src/main/java/org/acme/BookController.java';
    const single = await analyzer.analyzeFileSingle({
      projectPath: dir,
      filePath: path.join(dir, rel),
      relativePath: rel,
    });
    const singleRoutes = single.nodes.filter(n => n.type === 'route').map(n => n.name).sort();
    assert.deepEqual(singleRoutes, ['GET /books/list', 'POST /books']);
  } finally {
    await fs.remove(dir);
  }
});
