import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
  WsException,
} from '@nestjs/websockets';
import { Injectable, Logger, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { TelemetryService } from '../services/telemetry.service';
import { TelemetrySubscriptionDto, TelemetryBatchDto } from '../dto/telemetry.dto';
import { TelemetryEventType, TelemetryStream } from '../types/telemetry.types';
import { WsAuthGuard } from '../guards/ws-auth.guard';
import { ConnectionPool } from '../services/connection-pool.service';
import { BackpressureManager } from '../services/backpressure.service';

interface AuthenticatedSocket extends Socket {
  userId?: string;
  organizationId?: string;
  projectId?: string;
  subscriptions?: Map<string, TelemetrySubscriptionDto>;
}

@Injectable()
@WebSocketGateway({
  namespace: '/telemetry',
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e8,
  connectTimeout: 45000,
})
export class TelemetryGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  private server: Server;

  private readonly logger = new Logger(TelemetryGateway.name);
  private readonly maxConnectionsPerProject = 100;
  private readonly maxEventsPerSecond = 1000;

  constructor(
    private readonly telemetryService: TelemetryService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly connectionPool: ConnectionPool,
    private readonly backpressureManager: BackpressureManager,
  ) {}

  async handleConnection(client: AuthenticatedSocket) {
    try {
      const token = this.extractToken(client);
      if (!token) {
        throw new WsException('Missing authentication token');
      }

      const payload = await this.validateToken(token);
      if (!payload) {
        throw new WsException('Invalid authentication token');
      }

      client.userId = payload.sub;
      client.organizationId = payload.organizationId;
      client.projectId = payload.projectId;
      client.subscriptions = new Map();

      const connectionCount = await this.connectionPool.addConnection(
        client.id,
        client.projectId,
        {
          userId: client.userId,
          organizationId: client.organizationId,
          connectedAt: Date.now(),
          remoteAddress: client.handshake.address,
        },
      );

      if (connectionCount > this.maxConnectionsPerProject) {
        await this.connectionPool.removeConnection(client.id);
        throw new WsException('Maximum connections exceeded for project');
      }

      await client.join(`project:${client.projectId}`);
      await client.join(`org:${client.organizationId}`);

      this.logger.log(`Client connected: ${client.id} (Project: ${client.projectId})`);

      client.emit('connected', {
        clientId: client.id,
        projectId: client.projectId,
        organizationId: client.organizationId,
        timestamp: Date.now(),
      });

      await this.telemetryService.trackConnection({
        projectId: client.projectId,
        event: 'connect',
        clientId: client.id,
        metadata: {
          userId: client.userId,
          organizationId: client.organizationId,
        },
      });
    } catch (error) {
      this.logger.error(`Connection failed: ${error.message}`, error.stack);
      client.emit('error', { message: error.message });
      client.disconnect();
    }
  }

  async handleDisconnect(client: AuthenticatedSocket) {
    try {
      if (client.projectId) {
        await this.connectionPool.removeConnection(client.id);
        await this.telemetryService.trackConnection({
          projectId: client.projectId,
          event: 'disconnect',
          clientId: client.id,
          metadata: {
            userId: client.userId,
            organizationId: client.organizationId,
          },
        });
      }

      if (client.subscriptions) {
        client.subscriptions.clear();
      }

      this.logger.log(`Client disconnected: ${client.id}`);
    } catch (error) {
      this.logger.error(`Disconnect handler error: ${error.message}`, error.stack);
    }
  }

  @UseGuards(WsAuthGuard)
  @UsePipes(new ValidationPipe({ transform: true }))
  @SubscribeMessage('subscribe')
  async handleSubscribe(
    @MessageBody() subscription: TelemetrySubscriptionDto,
    @ConnectedSocket() client: AuthenticatedSocket,
  ) {
    try {
      if (subscription.projectId !== client.projectId) {
        throw new WsException('Unauthorized project access');
      }

      const subscriptionId = this.generateSubscriptionId(subscription);
      client.subscriptions.set(subscriptionId, subscription);

      if (subscription.componentIds?.length) {
        for (const componentId of subscription.componentIds) {
          await client.join(`component:${componentId}`);
        }
      }

      if (subscription.eventTypes?.length) {
        for (const eventType of subscription.eventTypes) {
          await client.join(`event:${eventType}`);
        }
      }

      await this.telemetryService.registerSubscription(client.id, subscription);

      return {
        success: true,
        subscriptionId,
        message: 'Subscription created successfully',
      };
    } catch (error) {
      this.logger.error(`Subscribe error: ${error.message}`, error.stack);
      throw new WsException(error.message);
    }
  }

  @UseGuards(WsAuthGuard)
  @SubscribeMessage('unsubscribe')
  async handleUnsubscribe(
    @MessageBody() data: { subscriptionId: string },
    @ConnectedSocket() client: AuthenticatedSocket,
  ) {
    try {
      const subscription = client.subscriptions.get(data.subscriptionId);
      if (!subscription) {
        throw new WsException('Subscription not found');
      }

      client.subscriptions.delete(data.subscriptionId);

      if (subscription.componentIds?.length) {
        for (const componentId of subscription.componentIds) {
          await client.leave(`component:${componentId}`);
        }
      }

      if (subscription.eventTypes?.length) {
        for (const eventType of subscription.eventTypes) {
          await client.leave(`event:${eventType}`);
        }
      }

      await this.telemetryService.removeSubscription(client.id, data.subscriptionId);

      return {
        success: true,
        message: 'Unsubscribed successfully',
      };
    } catch (error) {
      this.logger.error(`Unsubscribe error: ${error.message}`, error.stack);
      throw new WsException(error.message);
    }
  }

  @UseGuards(WsAuthGuard)
  @UsePipes(new ValidationPipe({ transform: true }))
  @SubscribeMessage('telemetry:batch')
  async handleTelemetryBatch(
    @MessageBody() batch: TelemetryBatchDto,
    @ConnectedSocket() client: AuthenticatedSocket,
  ) {
    try {
      if (batch.projectId !== client.projectId) {
        throw new WsException('Unauthorized project access');
      }

      const canProcess = await this.backpressureManager.checkBackpressure(
        client.projectId,
        batch.events.length,
      );

      if (!canProcess) {
        return {
          success: false,
          message: 'System overloaded. Please retry later.',
          retryAfter: 5000,
        };
      }

      await this.telemetryService.processBatch(batch);

      return {
        success: true,
        processed: batch.events.length,
        timestamp: Date.now(),
      };
    } catch (error) {
      this.logger.error(`Telemetry batch error: ${error.message}`, error.stack);
      throw new WsException(error.message);
    }
  }

  @UseGuards(WsAuthGuard)
  @SubscribeMessage('ping')
  async handlePing(@ConnectedSocket() client: AuthenticatedSocket) {
    return {
      pong: true,
      timestamp: Date.now(),
      clientId: client.id,
    };
  }

  async broadcastToProject(projectId: string, event: string, data: any) {
    try {
      const room = `project:${projectId}`;
      const clients = await this.server.in(room).fetchSockets();
      
      if (clients.length === 0) {
        this.logger.debug(`No clients in project room: ${projectId}`);
        return;
      }

      const shouldThrottle = await this.backpressureManager.shouldThrottle(
        projectId,
        clients.length,
      );

      if (shouldThrottle) {
        data = this.backpressureManager.sampleData(data);
      }

      this.server.to(room).emit(event, data);
      this.logger.debug(`Broadcast to ${clients.length} clients in project ${projectId}`);
    } catch (error) {
      this.logger.error(`Broadcast error: ${error.message}`, error.stack);
    }
  }

  async broadcastToComponent(componentId: string, event: string, data: any) {
    try {
      const room = `component:${componentId}`;
      this.server.to(room).emit(event, data);
    } catch (error) {
      this.logger.error(`Component broadcast error: ${error.message}`, error.stack);
    }
  }

  async broadcastTelemetryStream(stream: TelemetryStream) {
    try {
      const eventType = this.determineEventType(stream);
      const rooms = this.determineRooms(stream);

      for (const room of rooms) {
        this.server.to(room).emit('telemetry:stream', {
          type: eventType,
          data: stream,
          timestamp: Date.now(),
        });
      }
    } catch (error) {
      this.logger.error(`Stream broadcast error: ${error.message}`, error.stack);
    }
  }

  async getConnectionStats() {
    const sockets = await this.server.fetchSockets();
    const stats = new Map<string, number>();

    for (const socket of sockets) {
      const projectId = (socket as any).projectId;
      if (projectId) {
        stats.set(projectId, (stats.get(projectId) || 0) + 1);
      }
    }

    return {
      total: sockets.length,
      byProject: Object.fromEntries(stats),
      timestamp: Date.now(),
    };
  }

  private extractToken(client: Socket): string | null {
    const auth = client.handshake.auth;
    if (auth?.token) {
      return auth.token;
    }

    const authHeader = client.handshake.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }

    const queryToken = client.handshake.query.token;
    if (queryToken && typeof queryToken === 'string') {
      return queryToken;
    }

    return null;
  }

  private async validateToken(token: string): Promise<any> {
    try {
      return await this.jwtService.verifyAsync(token, {
        secret: this.configService.get('JWT_SECRET'),
      });
    } catch (error) {
      this.logger.error(`Token validation failed: ${error.message}`);
      return null;
    }
  }

  private generateSubscriptionId(subscription: TelemetrySubscriptionDto): string {
    const components = subscription.componentIds?.join('-') || 'all';
    const events = subscription.eventTypes?.join('-') || 'all';
    return `${subscription.projectId}-${components}-${events}-${Date.now()}`;
  }

  private determineEventType(stream: TelemetryStream): TelemetryEventType {
    if (stream.requestFlow) return TelemetryEventType.REQUEST_FLOW;
    if (stream.performanceMetrics) return TelemetryEventType.PERFORMANCE_METRICS;
    if (stream.activeConnections) return TelemetryEventType.ACTIVE_CONNECTIONS;
    if (stream.issues) return TelemetryEventType.ISSUES;
    if (stream.componentStatus) return TelemetryEventType.COMPONENT_STATUS;
    if (stream.databaseQuery) return TelemetryEventType.DATABASE_QUERY;
    if (stream.messageQueue) return TelemetryEventType.MESSAGE_QUEUE;
    return TelemetryEventType.CUSTOM;
  }

  private determineRooms(stream: TelemetryStream): string[] {
    const rooms: string[] = [];

    if (stream.requestFlow) {
      rooms.push(`project:${stream.requestFlow.projectId}`);
      rooms.push(`component:${stream.requestFlow.componentId}`);
      rooms.push(`event:${TelemetryEventType.REQUEST_FLOW}`);
    }

    if (stream.performanceMetrics) {
      rooms.push(`project:${stream.performanceMetrics.projectId}`);
      rooms.push(`component:${stream.performanceMetrics.componentId}`);
      rooms.push(`event:${TelemetryEventType.PERFORMANCE_METRICS}`);
    }

    if (stream.componentStatus) {
      rooms.push(`project:${stream.componentStatus.projectId}`);
      rooms.push(`component:${stream.componentStatus.componentId}`);
      rooms.push(`event:${TelemetryEventType.COMPONENT_STATUS}`);
    }

    return rooms;
  }
}