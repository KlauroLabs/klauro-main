import { useEffect, useState, useRef, useCallback } from 'react';
import io, { Socket } from 'socket.io-client';
import { API_CONFIG } from '../config/api';

export interface TelemetryData {
  nodeActivity: Record<string, number>;
  edgeFlow: Record<string, number>;
  errors: Array<{ nodeId: string; count: number; message: string }>;
  performance: {
    latency: Record<string, number>;
    throughput: Record<string, number>;
  };
  timestamp: Date;
}

export interface WebSocketOptions {
  enabled?: boolean;
  reconnect?: boolean;
  reconnectAttempts?: number;
  reconnectDelay?: number;
}

export interface UseWebSocketReturn {
  socket: Socket | null;
  isConnected: boolean;
  telemetry: TelemetryData | null;
  error: Error | null;
  connect: () => void;
  disconnect: () => void;
  subscribe: (channel: string) => void;
  unsubscribe: (channel: string) => void;
  sendMessage: (event: string, data: any) => void;
}

export function useWebSocket(
  projectId: string,
  options: WebSocketOptions = {}
): UseWebSocketReturn {
  const {
    enabled = true,
    reconnect = true,
    reconnectAttempts = 5,
    reconnectDelay = 3000
  } = options;

  const [socket, setSocket] = useState<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [telemetry, setTelemetry] = useState<TelemetryData | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const reconnectTimer = useRef<NodeJS.Timeout>();
  const reconnectCount = useRef(0);

  const connect = useCallback(() => {
    if (socket?.connected) return;

    const newSocket = io(API_CONFIG.wsURL, {
      transports: ['websocket'],
      auth: {
        token: localStorage.getItem('authToken')
      },
      query: {
        projectId
      }
    });

    newSocket.on('connect', () => {
      console.log('WebSocket connected');
      setIsConnected(true);
      setError(null);
      reconnectCount.current = 0;
      
      newSocket.emit('subscribe', {
        type: 'subscribe',
        channel: `telemetry:${projectId}`
      });
    });

    newSocket.on('disconnect', (reason) => {
      console.log('WebSocket disconnected:', reason);
      setIsConnected(false);
      
      if (reconnect && reconnectCount.current < reconnectAttempts) {
        reconnectTimer.current = setTimeout(() => {
          reconnectCount.current++;
          connect();
        }, reconnectDelay);
      }
    });

    newSocket.on('error', (err) => {
      console.error('WebSocket error:', err);
      setError(new Error(err.message || 'WebSocket error'));
    });

    newSocket.on('telemetry-update', (data: { data: TelemetryData; timestamp: Date }) => {
      setTelemetry({
        ...data.data,
        timestamp: new Date(data.timestamp)
      });
    });

    newSocket.on('connected', (data) => {
      console.log('Connected with client ID:', data.clientId);
    });

    newSocket.on('subscribed', (data) => {
      console.log('Subscribed to channel:', data.channel);
    });

    newSocket.on('unsubscribed', (data) => {
      console.log('Unsubscribed from channel:', data.channel);
    });

    newSocket.on('pong', (data) => {
      console.log('Pong received:', data.timestamp);
    });

    setSocket(newSocket);
  }, [projectId, reconnect, reconnectAttempts, reconnectDelay]);

  const disconnect = useCallback(() => {
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
    }
    
    if (socket) {
      socket.disconnect();
      setSocket(null);
      setIsConnected(false);
    }
  }, [socket]);

  const subscribe = useCallback((channel: string) => {
    if (socket?.connected) {
      socket.emit('subscribe', {
        type: 'subscribe',
        channel
      });
    }
  }, [socket]);

  const unsubscribe = useCallback((channel: string) => {
    if (socket?.connected) {
      socket.emit('unsubscribe', {
        type: 'unsubscribe',
        channel
      });
    }
  }, [socket]);

  const sendMessage = useCallback((event: string, data: any) => {
    if (socket?.connected) {
      socket.emit(event, data);
    } else {
      console.warn('Cannot send message - socket not connected');
    }
  }, [socket]);

  useEffect(() => {
    if (enabled && projectId) {
      connect();
    }

    return () => {
      disconnect();
    };
  }, [enabled, projectId]);

  useEffect(() => {
    const pingInterval = setInterval(() => {
      if (socket?.connected) {
        socket.emit('ping');
      }
    }, 30000);

    return () => clearInterval(pingInterval);
  }, [socket]);

  return {
    socket,
    isConnected,
    telemetry,
    error,
    connect,
    disconnect,
    subscribe,
    unsubscribe,
    sendMessage
  };
}