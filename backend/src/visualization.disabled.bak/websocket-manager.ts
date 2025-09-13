import { Server as HTTPServer } from 'http';
import { Server as SocketServer, Socket } from 'socket.io';
import { EventEmitter } from 'events';
import Redis from 'ioredis';
import { TelemetryUpdate } from './visualization-engine';
import { AuthService } from '../auth/auth-service';
import { Pool } from 'pg';
import { JWTPayload } from '../types';
import { RateLimiterMemory } from 'rate-limiter-flexible';

export interface WebSocketClient {
  id: string;
  socket: Socket;
  projectId?: string;
  filters?: any;
  subscriptions: Set<string>;
  metadata: ClientMetadata;
}

export interface ClientMetadata {
  connectedAt: Date;
  lastActivity: Date;
  userAgent?: string;
  ipAddress?: string;
  userId?: string;
  organizationId?: string;
}

export interface TelemetryMessage {
  type: 'telemetry';
  projectId: string;
  data: TelemetryUpdate;
  timestamp: Date;
}

export interface FilterMessage {
  type: 'filter';
  filters: any;
}

export interface SubscriptionMessage {
  type: 'subscribe' | 'unsubscribe';
  channel: string;
}

export interface BroadcastOptions {
  room?: string;
  except?: string[];
  volatile?: boolean;
}

export class WebSocketManager extends EventEmitter {
  private io: SocketServer | null = null;
  private clients: Map<string, WebSocketClient>;
  private rooms: Map<string, Set<string>>;
  private redis: Redis;
  private pubClient: Redis;
  private subClient: Redis;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private metricsInterval: NodeJS.Timeout | null = null;
  private authService: AuthService;
  private rateLimiter: RateLimiterMemory;
  private cleanupTimeouts: Map<string, NodeJS.Timeout>;

  constructor(
    private pool: Pool,
    redisConfig?: { host: string; port: number; password?: string }
  ) {
    super();
    this.clients = new Map();
    this.rooms = new Map();
    this.cleanupTimeouts = new Map();
    this.authService = new AuthService(pool);
    
    // Setup rate limiter
    this.rateLimiter = new RateLimiterMemory({
      points: 100,
      duration: 60,
      blockDuration: 60,
    });
    
    // Setup Redis for pub/sub
    const config = redisConfig || { host: 'localhost', port: 6379 };
    this.redis = new Redis(config);
    this.pubClient = new Redis(config);
    this.subClient = new Redis(config);
    
    this.setupRedisSubscriptions();
    this.startHeartbeat();
    this.startMetricsCollection();
  }

  attach(server: HTTPServer): void {
    this.io = new SocketServer(server, {
      cors: {
        origin: process.env.FRONTEND_URL || '*',
        methods: ['GET', 'POST'],
        credentials: true
      },
      pingTimeout: 60000,
      pingInterval: 25000,
      transports: ['websocket', 'polling'],
      allowEIO3: true
    });

    this.setupSocketHandlers();
  }

  private setupSocketHandlers(): void {
    if (!this.io) return;

    this.io.on('connection', (socket: Socket) => {
      this.handleConnection(socket);
    });

    // Middleware for authentication
    this.io.use(async (socket, next) => {
      try {
        const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.replace('Bearer ', '');
        
        if (!token) {
          return next(new Error('Authentication required'));
        }
        
        // Validate JWT token using auth service
        const payload = await this.authService.verifyAccessToken(token);
        
        // Get user details and verify they're still active
        const { user, memberships } = await this.authService.getUserWithMemberships(payload.sub);
        
        if (user.deleted_at) {
          return next(new Error('Account has been deleted'));
        }
        
        socket.data.user = {
          id: user.id,
          email: user.email,
          organizationId: memberships[0]?.organization_id,
          organizations: payload.organizations,
        };
        
        next();
      } catch (error) {
        console.error('WebSocket authentication error:', error);
        next(new Error('Authentication failed'));
      }
    });
    
    // Rate limiting middleware
    this.io.use(async (socket, next) => {
      try {
        const clientId = socket.data.user?.id || socket.handshake.address;
        await this.rateLimiter.consume(clientId);
        next();
      } catch (rateLimitError) {
        next(new Error('Rate limit exceeded'));
      }
    });
  }

  private handleConnection(socket: Socket): void {
    const client: WebSocketClient = {
      id: socket.id,
      socket,
      subscriptions: new Set(),
      metadata: {
        connectedAt: new Date(),
        lastActivity: new Date(),
        userAgent: socket.handshake.headers['user-agent'],
        ipAddress: socket.handshake.address,
        userId: socket.data.user?.id,
        organizationId: socket.data.user?.organizationId
      }
    };

    this.clients.set(socket.id, client);
    this.emit('client-connected', client);

    // Setup event handlers
    socket.on('subscribe', (msg: SubscriptionMessage) => {
      this.handleSubscribe(client, msg);
    });

    socket.on('unsubscribe', (msg: SubscriptionMessage) => {
      this.handleUnsubscribe(client, msg);
    });

    socket.on('filter', (msg: FilterMessage) => {
      this.handleFilter(client, msg);
    });

    socket.on('telemetry', (msg: TelemetryMessage) => {
      this.handleTelemetry(msg);
    });

    socket.on('ping', () => {
      socket.emit('pong', { timestamp: Date.now() });
      client.metadata.lastActivity = new Date();
    });

    socket.on('disconnect', () => {
      this.handleDisconnect(client);
    });

    socket.on('error', (error) => {
      console.error(`Socket error for client ${client.id}:`, error);
      this.emit('client-error', { client, error });
    });

    // Send initial connection success
    socket.emit('connected', {
      clientId: socket.id,
      timestamp: new Date()
    });
  }

  private async handleSubscribe(client: WebSocketClient, msg: SubscriptionMessage): Promise<void> {
    const { channel } = msg;
    
    // Validate channel access
    if (!await this.validateChannelAccess(client, channel)) {
      client.socket.emit('error', { 
        message: 'Access denied to channel',
        channel 
      });
      return;
    }
    
    if (!client.subscriptions.has(channel)) {
      client.subscriptions.add(channel);
      client.socket.join(channel);
      
      // Add to room tracking
      if (!this.rooms.has(channel)) {
        this.rooms.set(channel, new Set());
      }
      this.rooms.get(channel)!.add(client.id);
      
      // Subscribe to Redis channel if needed
      this.subClient.subscribe(`viz:${channel}`).catch(error => {
        console.error('Redis subscription error:', error);
      });
      
      client.socket.emit('subscribed', { channel });
      this.emit('client-subscribed', { client, channel });
    }
  }

  private handleUnsubscribe(client: WebSocketClient, msg: SubscriptionMessage): void {
    const { channel } = msg;
    
    if (client.subscriptions.has(channel)) {
      client.subscriptions.delete(channel);
      client.socket.leave(channel);
      
      // Remove from room tracking
      this.rooms.get(channel)?.delete(client.id);
      if (this.rooms.get(channel)?.size === 0) {
        this.rooms.delete(channel);
        // Unsubscribe from Redis if no more clients
        this.subClient.unsubscribe(`viz:${channel}`);
      }
      
      client.socket.emit('unsubscribed', { channel });
      this.emit('client-unsubscribed', { client, channel });
    }
  }

  private handleFilter(client: WebSocketClient, msg: FilterMessage): void {
    client.filters = msg.filters;
    client.metadata.lastActivity = new Date();
    
    this.emit('client-filter', client.id, msg.filters);
    
    // Acknowledge filter update
    client.socket.emit('filter-updated', {
      filters: msg.filters,
      timestamp: new Date()
    });
  }

  private handleTelemetry(msg: TelemetryMessage): void {
    // Publish telemetry to Redis for distribution
    this.pubClient.publish(
      `viz:telemetry:${msg.projectId}`,
      JSON.stringify(msg.data)
    );
    
    this.emit('telemetry', msg.data);
  }

  private handleDisconnect(client: WebSocketClient): void {
    // Clean up subscriptions
    client.subscriptions.forEach(channel => {
      this.rooms.get(channel)?.delete(client.id);
      if (this.rooms.get(channel)?.size === 0) {
        this.rooms.delete(channel);
        this.subClient.unsubscribe(`viz:${channel}`);
      }
    });
    
    this.clients.delete(client.id);
    this.emit('client-disconnected', client);
  }

  private setupRedisSubscriptions(): void {
    this.subClient.on('message', (channel: string, message: string) => {
      if (channel.startsWith('viz:telemetry:')) {
        const projectId = channel.replace('viz:telemetry:', '');
        try {
          const data = JSON.parse(message);
          this.broadcastTelemetry(data, projectId);
        } catch (error) {
          console.error('Failed to parse telemetry message:', error);
        }
      }
    });
  }

  subscribeToTelemetry(projectId: string, clientId: string): void {
    const client = this.clients.get(clientId);
    if (client) {
      client.projectId = projectId;
      this.handleSubscribe(client, {
        type: 'subscribe',
        channel: `telemetry:${projectId}`
      });
    }
  }

  unsubscribeFromTelemetry(clientId: string): void {
    const client = this.clients.get(clientId);
    if (client && client.projectId) {
      this.handleUnsubscribe(client, {
        type: 'unsubscribe',
        channel: `telemetry:${client.projectId}`
      });
      client.projectId = undefined;
    }
  }

  broadcastTelemetry(update: TelemetryUpdate, projectId?: string): void {
    const channel = projectId ? `telemetry:${projectId}` : 'telemetry';
    
    if (this.io) {
      this.io.to(channel).emit('telemetry-update', {
        data: update,
        timestamp: new Date()
      });
    }
  }

  broadcast(
    event: string,
    data: any,
    options: BroadcastOptions = {}
  ): void {
    if (!this.io) return;
    
    let emitter: any = this.io;
    
    if (options.room) {
      emitter = emitter.to(options.room);
    }
    
    if (options.except?.length) {
      options.except.forEach(clientId => {
        emitter = emitter.except(clientId);
      });
    }
    
    if (options.volatile) {
      emitter = emitter.volatile;
    }
    
    emitter.emit(event, data);
  }

  sendToClient(clientId: string, event: string, data: any): boolean {
    const client = this.clients.get(clientId);
    if (client) {
      client.socket.emit(event, data);
      return true;
    }
    return false;
  }

  sendToRoom(room: string, event: string, data: any): void {
    if (this.io) {
      this.io.to(room).emit(event, data);
    }
  }

  private async validateChannelAccess(client: WebSocketClient, channel: string): Promise<boolean> {
    // Validate user has access to the requested channel
    if (!client.metadata.userId) {
      return false;
    }
    
    // Extract project ID from channel name (e.g., 'telemetry:project-id')
    const projectMatch = channel.match(/^telemetry:([\w-]+)$/);
    if (projectMatch) {
      const projectId = projectMatch[1];
      
      // Verify user has access to this project
      try {
        const query = `
          SELECT COUNT(*) as count
          FROM projects p
          JOIN memberships m ON p.organization_id = m.organization_id
          WHERE p.id = $1 AND m.user_id = $2
        `;
        const result = await this.pool.query(query, [projectId, client.metadata.userId]);
        return result.rows[0].count > 0;
      } catch (error) {
        console.error('Channel access validation error:', error);
        return false;
      }
    }
    
    // Default channels that authenticated users can access
    const publicChannels = ['system', 'notifications'];
    return publicChannels.includes(channel);
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();
      const timeout = 60000; // 1 minute
      
      this.clients.forEach((client, id) => {
        const lastActivity = client.metadata.lastActivity.getTime();
        if (now - lastActivity > timeout * 2) {
          // Client seems dead, disconnect
          client.socket.disconnect();
          this.handleDisconnect(client);
        } else if (now - lastActivity > timeout) {
          // Send ping to check if client is alive
          client.socket.emit('ping');
        }
      });
    }, 30000); // Check every 30 seconds
  }

  private startMetricsCollection(): void {
    this.metricsInterval = setInterval(() => {
      const metrics = this.getMetrics();
      this.emit('metrics', metrics);
      
      // Store metrics in Redis for monitoring
      this.redis.setex(
        'viz:metrics:websocket',
        60,
        JSON.stringify(metrics)
      );
    }, 10000); // Collect every 10 seconds
  }

  getMetrics(): any {
    const clientsByProject = new Map<string, number>();
    const clientsByOrg = new Map<string, number>();
    
    this.clients.forEach(client => {
      if (client.projectId) {
        clientsByProject.set(
          client.projectId,
          (clientsByProject.get(client.projectId) || 0) + 1
        );
      }
      
      if (client.metadata.organizationId) {
        clientsByOrg.set(
          client.metadata.organizationId,
          (clientsByOrg.get(client.metadata.organizationId) || 0) + 1
        );
      }
    });
    
    return {
      totalClients: this.clients.size,
      totalRooms: this.rooms.size,
      clientsByProject: Object.fromEntries(clientsByProject),
      clientsByOrganization: Object.fromEntries(clientsByOrg),
      subscriptions: Array.from(this.rooms.entries()).map(([room, clients]) => ({
        room,
        clientCount: clients.size
      }))
    };
  }

  getClientInfo(clientId: string): WebSocketClient | undefined {
    return this.clients.get(clientId);
  }

  getClientsInRoom(room: string): string[] {
    return Array.from(this.rooms.get(room) || []);
  }

  disconnectClient(clientId: string, reason?: string): void {
    const client = this.clients.get(clientId);
    if (client) {
      client.socket.emit('disconnect-reason', { reason });
      client.socket.disconnect();
      this.handleDisconnect(client);
    }
  }

  dispose(): void {
    // Clean up intervals
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
      this.metricsInterval = null;
    }
    
    // Clean up timeout handlers
    this.cleanupTimeouts.forEach(timeout => clearTimeout(timeout));
    this.cleanupTimeouts.clear();
    
    // Disconnect all clients gracefully
    this.clients.forEach(client => {
      client.socket.emit('server-shutdown', { message: 'Server is shutting down' });
      client.socket.disconnect(true);
    });
    
    // Close Socket.IO server
    if (this.io) {
      this.io.close();
      this.io = null;
    }
    
    // Close Redis connections
    this.redis.disconnect();
    this.pubClient.disconnect();
    this.subClient.disconnect();
    
    // Clear data
    this.clients.clear();
    this.rooms.clear();
    this.removeAllListeners();
  }
}