import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProtobufAnalyzer } from './protobuf-analyzer';

function makeTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'protobuf-analyzer-test-'));

  const greeter = [
    'syntax = "proto3";',
    'package demo;',
    '',
    'message HelloRequest {',
    '  string name = 1;',
    '}',
    '',
    'message HelloReply {',
    '  string message = 1;',
    '}',
    '',
    'service Greeter {',
    '  rpc SayHello (HelloRequest) returns (HelloReply);',
    '  rpc SayHelloStream (HelloRequest) returns (stream HelloReply);',
    '}',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'greeter.proto'), greeter);

  return dir;
}

test('ProtobufAnalyzer.canAnalyze returns true for a project with .proto files', async () => {
  const dir = makeTempProject();
  try {
    const analyzer = new ProtobufAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ProtobufAnalyzer.analyze extracts messages, fields, services, rpcs, entry points, and contract edges', async () => {
  const dir = makeTempProject();
  try {
    const analyzer = new ProtobufAnalyzer();
    const cas = await analyzer.analyze({ projectPath: dir });

    // File node captures package + syntax.
    const fileNode = cas.nodes.find(n => n.type === 'file');
    assert.ok(fileNode, 'file node exists');
    assert.equal(fileNode!.metadata?.attributes?.package, 'demo');
    assert.equal(fileNode!.metadata?.attributes?.syntax, 'proto3');

    // Message nodes HelloRequest + HelloReply (data entities).
    const messageNodes = cas.nodes.filter(n => n.type === 'data-entity');
    const messageNames = messageNodes.map(n => n.name).sort();
    assert.deepEqual(messageNames, ['HelloReply', 'HelloRequest'], 'extracts both messages');

    const helloRequest = messageNodes.find(n => n.name === 'HelloRequest')!;
    const helloReply = messageNodes.find(n => n.name === 'HelloReply')!;
    assert.ok(helloRequest && helloReply, 'message nodes exist');

    // Field nodes with field numbers.
    const fieldNodes = cas.nodes.filter(n => n.type === 'field');
    const reqNameField = fieldNodes.find(n => n.name === 'name');
    const replyMsgField = fieldNodes.find(n => n.name === 'message');
    assert.ok(reqNameField, 'HelloRequest.name field exists');
    assert.ok(replyMsgField, 'HelloReply.message field exists');
    assert.equal(reqNameField!.metadata?.attributes?.fieldType, 'string');
    assert.equal(reqNameField!.metadata?.attributes?.fieldNumber, 1);

    // Service node Greeter.
    const serviceNode = cas.nodes.find(n => n.type === 'service' && n.name === 'Greeter');
    assert.ok(serviceNode, 'Greeter service node exists');

    // RPC nodes SayHello + SayHelloStream.
    const rpcNodes = cas.nodes.filter(n => n.type === 'rpc');
    const rpcNames = rpcNodes.map(n => n.name).sort();
    assert.deepEqual(rpcNames, ['SayHello', 'SayHelloStream'], 'extracts both RPCs');

    const sayHello = rpcNodes.find(n => n.name === 'SayHello')!;
    const sayHelloStream = rpcNodes.find(n => n.name === 'SayHelloStream')!;

    // Streaming flagged: SayHello unary, SayHelloStream server-streaming.
    assert.equal(sayHello.metadata?.attributes?.serverStreaming, false, 'SayHello is unary');
    assert.equal(sayHello.metadata?.attributes?.streaming, 'unary');
    assert.equal(sayHelloStream.metadata?.attributes?.serverStreaming, true, 'SayHelloStream streams responses');
    assert.equal(sayHelloStream.metadata?.attributes?.streaming, 'server');

    // RPCs are entry points (API contract endpoints).
    const entryNames = cas.entry_points.map(ep => ep.name).sort();
    assert.ok(
      cas.entry_points.some(ep => ep.metadata?.rpc === 'SayHello'),
      'SayHello is an entry point'
    );
    assert.ok(
      cas.entry_points.some(ep => ep.metadata?.rpc === 'SayHelloStream'),
      'SayHelloStream is an entry point'
    );
    assert.equal(cas.entry_points.length, 2, 'two RPC entry points');
    assert.ok(entryNames.length === 2);

    // Contract edges: SayHello -> request (HelloRequest) + response (HelloReply).
    const requestEdge = cas.edges.find(e =>
      e.source === sayHello.id && e.target === helloRequest.id && e.metadata?.role === 'request'
    );
    const responseEdge = cas.edges.find(e =>
      e.source === sayHello.id && e.target === helloReply.id && e.metadata?.role === 'response'
    );
    assert.ok(requestEdge, 'SayHello links to its request message HelloRequest');
    assert.ok(responseEdge, 'SayHello links to its response message HelloReply');

    // Streaming RPC also links its request + response.
    assert.ok(
      cas.edges.some(e => e.source === sayHelloStream.id && e.target === helloRequest.id && e.metadata?.role === 'request'),
      'SayHelloStream links to HelloRequest'
    );
    assert.ok(
      cas.edges.some(e => e.source === sayHelloStream.id && e.target === helloReply.id && e.metadata?.role === 'response'),
      'SayHelloStream links to HelloReply'
    );

    // Service contains its RPCs.
    assert.ok(
      cas.edges.some(e => e.source === serviceNode!.id && e.target === sayHello.id && e.type === 'contains'),
      'Greeter contains SayHello'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
