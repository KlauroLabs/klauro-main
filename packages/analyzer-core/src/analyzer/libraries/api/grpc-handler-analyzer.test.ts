import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { GrpcHandlerAnalyzer } from './grpc-handler-analyzer';

async function makeNodeProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'grpc-node-test-'));
  await fs.writeJson(path.join(dir, 'package.json'), {
    name: 'grpc-node-fixture',
    dependencies: { '@grpc/grpc-js': '^1.9.0' }
  });
  const src = path.join(dir, 'src');
  await fs.ensureDir(src);

  await fs.writeFile(path.join(src, 'server.ts'), [
    "import * as grpc from '@grpc/grpc-js';",
    "import { greeterProto } from './proto';",
    '',
    'const server = new grpc.Server();',
    'server.addService(greeterProto.greeter.Greeter.service, {',
    '  SayHello(call, callback) {',
    '    callback(null, { message: `Hello ${call.request.name}` });',
    '  },',
    '  SayGoodbye: async (call, callback) => {',
    '    callback(null, {});',
    '  },',
    '});',
    '',
  ].join('\n'));

  return dir;
}

async function makeNestProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'grpc-nest-test-'));
  await fs.writeJson(path.join(dir, 'package.json'), {
    name: 'grpc-nest-fixture',
    dependencies: { '@nestjs/microservices': '^10.0.0' }
  });
  const src = path.join(dir, 'src');
  await fs.ensureDir(src);

  await fs.writeFile(path.join(src, 'hero.controller.ts'), [
    "import { GrpcMethod, GrpcStreamMethod } from '@nestjs/microservices';",
    '',
    'export class HeroController {',
    "  @GrpcMethod('HeroService', 'FindOne')",
    '  findOne(data: any) {',
    '    return { id: data.id };',
    '  }',
    '',
    "  @GrpcStreamMethod('HeroService', 'StreamHeroes')",
    '  streamHeroes(messages: any) {',
    '    return messages;',
    '  }',
    '}',
    '',
  ].join('\n'));

  return dir;
}

async function makePythonProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'grpc-py-test-'));
  await fs.writeFile(path.join(dir, 'requirements.txt'), 'grpcio==1.60.0\ngrpcio-tools==1.60.0\n');
  const proto = path.join(dir, 'proto');
  await fs.ensureDir(proto);

  // Generated-style stub: Servicer base + registration with streaming + types.
  await fs.writeFile(path.join(proto, 'greeter_pb2_grpc.py'), [
    'import grpc',
    'import greeter_pb2 as greeter__pb2',
    '',
    'class GreeterServicer(object):',
    '    def SayHello(self, request, context):',
    "        raise NotImplementedError('Method not implemented!')",
    '    def LotsOfReplies(self, request, context):',
    "        raise NotImplementedError('Method not implemented!')",
    '',
    'def add_GreeterServicer_to_server(servicer, server):',
    '    rpc_method_handlers = {',
    "            'SayHello': grpc.unary_unary_rpc_method_handler(",
    '                    servicer.SayHello,',
    '                    request_deserializer=greeter__pb2.HelloRequest.FromString,',
    '                    response_serializer=greeter__pb2.HelloReply.SerializeToString,',
    '            ),',
    "            'LotsOfReplies': grpc.unary_stream_rpc_method_handler(",
    '                    servicer.LotsOfReplies,',
    '                    request_deserializer=greeter__pb2.HelloRequest.FromString,',
    '                    response_serializer=greeter__pb2.HelloReply.SerializeToString,',
    '            ),',
    '    }',
    "    generic_handler = grpc.method_handlers_generic_handler('greeter.Greeter', rpc_method_handlers)",
    '    server.add_generic_rpc_handlers((generic_handler,))',
    '',
    "SERVICE_NAME = 'greeter.Greeter'",
    '',
  ].join('\n'));

  // User handler impl subclassing the generated base.
  await fs.writeFile(path.join(dir, 'service.py'), [
    'import grpc',
    'from proto import greeter_pb2_grpc',
    '',
    'class GreeterImpl(greeter_pb2_grpc.GreeterServicer):',
    '    def SayHello(self, request, context):',
    '        return greeter_pb2.HelloReply(message="hi")',
    '',
  ].join('\n'));

  return dir;
}

test('GrpcHandlerAnalyzer extracts grpc-js addService handlers as rpc entry points', async () => {
  const dir = await makeNodeProject();
  try {
    const analyzer = new GrpcHandlerAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), true, 'should detect grpc-js');

    const result = await analyzer.analyze({ projectPath: dir });
    const rpcEntries = result.entry_points!.filter(e => e.type === 'rpc');
    const names = rpcEntries.map(e => e.name).sort();
    assert.deepEqual(names, ['SayGoodbye', 'SayHello'], 'both handler-map methods are entry points');

    const svc = result.nodes!.find(n => n.type === 'service' && n.name === 'Greeter');
    assert.ok(svc, 'Greeter service node emitted');
    for (const e of rpcEntries) {
      assert.equal(e.metadata?.protocol, 'grpc');
      assert.equal(e.trigger?.method, 'POST');
      assert.ok(e.trigger?.path?.startsWith('/Greeter/'), 'canonical rpc path');
    }
  } finally {
    await fs.remove(dir);
  }
});

test('GrpcHandlerAnalyzer extracts NestJS @GrpcMethod / @GrpcStreamMethod handlers', async () => {
  const dir = await makeNestProject();
  try {
    const analyzer = new GrpcHandlerAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), true, 'should detect @nestjs/microservices');

    const result = await analyzer.analyze({ projectPath: dir });
    const rpcEntries = result.entry_points!.filter(e => e.type === 'rpc');
    const byName = new Map(rpcEntries.map(e => [e.name, e]));
    assert.ok(byName.has('FindOne'), 'FindOne handler');
    assert.ok(byName.has('StreamHeroes'), 'StreamHeroes handler');
    assert.equal(byName.get('StreamHeroes')!.metadata?.streaming, 'server', 'stream method is server-streaming');
    assert.equal(byName.get('FindOne')!.metadata?.service, 'HeroService', 'service name from decorator arg');
  } finally {
    await fs.remove(dir);
  }
});

test('GrpcHandlerAnalyzer extracts grpcio registration handlers with streaming + message types', async () => {
  const dir = await makePythonProject();
  try {
    const analyzer = new GrpcHandlerAnalyzer();
    assert.equal(await analyzer.canAnalyze(dir), true, 'should detect grpcio / _pb2_grpc.py');

    const result = await analyzer.analyze({ projectPath: dir });
    const rpcEntries = result.entry_points!.filter(e => e.type === 'rpc');
    const byName = new Map(rpcEntries.map(e => [e.name, e]));

    assert.ok(byName.has('SayHello'), 'SayHello handler');
    assert.ok(byName.has('LotsOfReplies'), 'LotsOfReplies handler');

    const hello = byName.get('SayHello')!;
    assert.equal(hello.metadata?.streaming, 'unary');
    assert.equal(hello.metadata?.requestType, 'HelloRequest', 'request type from FromString deserializer');
    assert.equal(hello.metadata?.responseType, 'HelloReply', 'response type from SerializeToString serializer');
    assert.equal(hello.input?.type, 'HelloRequest');
    assert.equal(hello.output?.type, 'HelloReply');

    const lots = byName.get('LotsOfReplies')!;
    assert.equal(lots.metadata?.streaming, 'server', 'unary_stream -> server streaming');

    // Package resolved from SERVICE_NAME, carried on the canonical path.
    assert.ok(hello.trigger?.path === '/greeter.Greeter/SayHello', `expected packaged path, got ${hello.trigger?.path}`);

    // The user servicer subclass merges into the same Greeter service (one node).
    const greeterNodes = result.nodes!.filter(n => n.type === 'service' && n.name === 'Greeter');
    assert.equal(greeterNodes.length, 1, 'registration + servicer subclass merge into one service node');
  } finally {
    await fs.remove(dir);
  }
});
