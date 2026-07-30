jest.unmock('fs-extra');
jest.unmock('fs');
jest.unmock('glob');

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NestJSAnalyzer } from '../../analyzer/frameworks/web/nestjs-analyzer';

/**
 * Every @SubscribeMessage handler is its own entry point, anchored to the
 * gateway that receives it.
 *
 * Two defects this guards. (1) Decorators were matched against the literal
 * exported name, so `import { WebSocketGateway as WSGateway }` — the ordinary
 * way to write it when the class itself is called WebSocketGateway — made the
 * class-level match fail, and because the handler walk is nested inside it,
 * every handler in that gateway went missing too. (2) The handler entry points
 * carried no location, so "where is this message handled?" was unanswerable
 * from the record.
 */
describe('NestJS WebSocket message handlers', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-ws-handlers-'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'ws-fixture',
      dependencies: { '@nestjs/core': '^10.0.0', '@nestjs/websockets': '^10.0.0' },
    }));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const write = (relative: string, lines: string[]) => {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, lines.join('\n'));
  };

  const wsEntries = async () => {
    const contribution: any = await new NestJSAnalyzer().analyze({ projectPath: root } as any);
    const eps: any[] = contribution.entry_points || [];
    return {
      handlers: eps.filter(e => String(e.id).startsWith('entry_ws_msg_')),
      gateways: eps.filter(e => e.type === 'websocket'),
    };
  };

  it('emits one message entry point per @SubscribeMessage, with the message name and file:line', async () => {
    write('src/chat.gateway.ts', [
      "import { WebSocketGateway, SubscribeMessage } from '@nestjs/websockets';", // 1
      '',                                                                        // 2
      '@WebSocketGateway({ namespace: "/chat" })',                               // 3
      'export class ChatGateway {',                                              // 4
      "  @SubscribeMessage('ping')",                                             // 5
      '  handlePing() { return "pong"; }',                                       // 6
      '',                                                                        // 7
      "  @SubscribeMessage('join-room')",                                        // 8
      '  handleJoinRoom() {}',                                                   // 9
      '',                                                                        // 10
      "  @SubscribeMessage('leave-room')",                                       // 11
      '  handleLeaveRoom() {}',                                                  // 12
      '}',                                                                       // 13
    ]);

    const { handlers } = await wsEntries();
    expect(handlers.length).toBe(3);
    expect(handlers.every(e => e.type === 'message')).toBe(true);
    expect(handlers.map(e => e.trigger.event).sort()).toEqual(['join-room', 'leave-room', 'ping']);
    expect(handlers.map(e => `${e.trigger.event}@${e.handler.line}`).sort())
      .toEqual(['join-room@8', 'leave-room@11', 'ping@5']);
    for (const e of handlers) {
      expect(e.handler.file).toBe('src/chat.gateway.ts');
      expect(e.metadata.gateway_class).toBe('ChatGateway');
    }
  });

  it('finds a gateway and its handlers when the decorator is imported under an alias', async () => {
    write('src/websocket.gateway.ts', [
      "import { WebSocketGateway as WSGateway, SubscribeMessage } from '@nestjs/websockets';",
      '',
      '@WSGateway({ cors: { origin: "*" } })',
      // The class shadows the decorator's real name — which is exactly why the
      // import gets aliased in the first place.
      'export class WebSocketGateway {',
      "  @SubscribeMessage('ping')",
      '  handlePing() {}',
      '',
      "  @SubscribeMessage('join-room')",
      '  handleJoinRoom() {}',
      '}',
    ]);

    const { handlers, gateways } = await wsEntries();
    expect(gateways.length).toBe(1);
    expect(handlers.map(e => e.trigger.event).sort()).toEqual(['join-room', 'ping']);
  });

  it('keeps same-named messages on different gateways distinct', async () => {
    // 'ping' on two gateways is two entry points; collapsing them by message
    // name alone would lose one.
    write('src/a.gateway.ts', [
      "import { WebSocketGateway, SubscribeMessage } from '@nestjs/websockets';",
      '@WebSocketGateway()',
      'export class AlphaGateway {',
      "  @SubscribeMessage('ping')",
      '  handlePing() {}',
      '}',
    ]);
    write('src/b.gateway.ts', [
      "import { WebSocketGateway as WSGateway, SubscribeMessage } from '@nestjs/websockets';",
      '@WSGateway({ namespace: "/b" })',
      'export class BetaGateway {',
      "  @SubscribeMessage('ping')",
      '  handlePing() {}',
      '}',
    ]);

    const { handlers, gateways } = await wsEntries();
    expect(gateways.length).toBe(2);
    expect(handlers.length).toBe(2);
    expect(handlers.map(e => e.metadata.gateway_class).sort()).toEqual(['AlphaGateway', 'BetaGateway']);
    expect(new Set(handlers.map(e => e.id)).size).toBe(2);
  });

  it('anchors the line on the @SubscribeMessage registration, not the first decorator in the stack', async () => {
    write('src/guarded.gateway.ts', [
      "import { WebSocketGateway, SubscribeMessage } from '@nestjs/websockets';", // 1
      "import { UseGuards, UsePipes } from '@nestjs/common';",                    // 2
      '@WebSocketGateway()',                                                      // 3
      'export class GuardedGateway {',                                            // 4
      '  @UseGuards(WsAuthGuard)',                                                // 5
      '  @UsePipes(new ValidationPipe())',                                        // 6
      "  @SubscribeMessage('subscribe')",                                         // 7
      '  handleSubscribe() {}',                                                   // 8
      '}',                                                                        // 9
    ]);

    const { handlers } = await wsEntries();
    expect(handlers.length).toBe(1);
    // Line 7 (the registration), not 5 (where the method's decorator stack starts).
    expect(handlers[0].handler.line).toBe(7);
    expect(handlers[0].metadata.declaredAt).toBe('src/guarded.gateway.ts:7');
  });
});
