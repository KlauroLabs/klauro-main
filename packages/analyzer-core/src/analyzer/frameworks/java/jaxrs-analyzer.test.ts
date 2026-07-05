import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import { JaxRsAnalyzer } from './jaxrs-analyzer';

const POM = `<?xml version="1.0"?>
<project>
  <groupId>com.example</groupId>
  <artifactId>plain-jaxrs</artifactId>
  <dependencies>
    <dependency>
      <groupId>org.glassfish.jersey.core</groupId>
      <artifactId>jersey-server</artifactId>
    </dependency>
  </dependencies>
</project>
`;

const RESOURCE = `package com.example;

import jakarta.ws.rs.GET;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.PathParam;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.core.MediaType;
import jakarta.annotation.security.RolesAllowed;

@Path("/books")
public class BookResource {

    @GET
    @Produces(MediaType.APPLICATION_JSON)
    public java.util.List<Book> list() {
        return null;
    }

    @GET
    @Path("/{id}")
    public Book get(@PathParam("id") String id) {
        return null;
    }

    @POST
    @RolesAllowed("admin")
    public Book create(Book book) {
        return book;
    }
}
`;

const PROVIDER = `package com.example;

import jakarta.ws.rs.ext.Provider;
import jakarta.ws.rs.ext.ExceptionMapper;

@Provider
public class NotFoundMapper implements ExceptionMapper<RuntimeException> {
    public jakarta.ws.rs.core.Response toResponse(RuntimeException e) {
        return null;
    }
}
`;

async function makeFixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jaxrs-analyzer-'));
  await fs.writeFile(path.join(dir, 'pom.xml'), POM);
  const src = path.join(dir, 'src', 'main', 'java', 'com', 'example');
  await fs.ensureDir(src);
  await fs.writeFile(path.join(src, 'BookResource.java'), RESOURCE);
  await fs.writeFile(path.join(src, 'NotFoundMapper.java'), PROVIDER);
  return dir;
}

test('canAnalyze: true for plain JAX-RS/Jersey dependency', async () => {
  const dir = await makeFixture();
  try {
    assert.equal(await new JaxRsAnalyzer().canAnalyze(dir), true);
  } finally {
    await fs.remove(dir);
  }
});

test('canAnalyze: false when quarkus signal is present (defers to QuarkusAnalyzer)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jaxrs-quarkus-'));
  try {
    await fs.writeFile(path.join(dir, 'pom.xml'), `<project><dependencies>
      <dependency><groupId>io.quarkus</groupId><artifactId>quarkus-resteasy-reactive</artifactId></dependency>
    </dependencies></project>`);
    const src = path.join(dir, 'src');
    await fs.ensureDir(src);
    await fs.writeFile(path.join(src, 'X.java'), 'import jakarta.ws.rs.GET;\n@jakarta.ws.rs.Path("/x")\npublic class X {}\n');
    assert.equal(await new JaxRsAnalyzer().canAnalyze(dir), false);
  } finally {
    await fs.remove(dir);
  }
});

test('canAnalyze: false when micronaut signal is present', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jaxrs-micronaut-'));
  try {
    await fs.writeFile(path.join(dir, 'pom.xml'), `<project><dependencies>
      <dependency><groupId>io.micronaut</groupId><artifactId>micronaut-http-server</artifactId></dependency>
    </dependencies></project>`);
    assert.equal(await new JaxRsAnalyzer().canAnalyze(dir), false);
  } finally {
    await fs.remove(dir);
  }
});

test('canAnalyze: false for non-JAX-RS project', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jaxrs-neg-'));
  try {
    await fs.writeFile(path.join(dir, 'pom.xml'), '<project><artifactId>plain</artifactId></project>');
    assert.equal(await new JaxRsAnalyzer().canAnalyze(dir), false);
  } finally {
    await fs.remove(dir);
  }
});

test('extracts routes composed from class + method @Path, with roles and provider', async () => {
  const dir = await makeFixture();
  try {
    const result = await new JaxRsAnalyzer().analyze({ projectPath: dir });

    const routeNodes = result.nodes.filter(n => n.type === 'route');
    const labels = routeNodes.map(n => n.name).sort();
    assert.ok(labels.includes('GET /books'), `expected GET /books, got ${JSON.stringify(labels)}`);
    assert.ok(labels.includes('GET /books/{id}'), `expected GET /books/{id}, got ${JSON.stringify(labels)}`);
    assert.ok(labels.includes('POST /books'), `expected POST /books, got ${JSON.stringify(labels)}`);

    const createEntry = result.entry_points.find(
      ep => ep.type === 'http' && ep.trigger?.method === 'POST' && ep.trigger?.path === '/books'
    );
    assert.ok(createEntry, 'expected an http entry point for POST /books');
    assert.equal(createEntry?.security?.authenticated, true);
    assert.deepEqual(createEntry?.security?.authorized_roles, ['admin']);
    assert.equal(createEntry?.handler?.method_name, 'create');

    const getEntry = result.entry_points.find(
      ep => ep.type === 'http' && ep.trigger?.method === 'GET' && ep.trigger?.path === '/books'
    );
    assert.equal(getEntry?.security?.authenticated, false);

    const providerNode = result.nodes.find(n => n.type === 'provider');
    assert.ok(providerNode, 'expected a provider node for @Provider class');
    assert.equal(providerNode?.metadata?.attributes?.kind, 'exception-mapper');

    const resourceNode = result.nodes.find(n => n.type === 'controller');
    assert.ok(resourceNode, 'expected a controller node for the @Path resource class');
    assert.equal(resourceNode?.name, 'BookResource');
  } finally {
    await fs.remove(dir);
  }
});
