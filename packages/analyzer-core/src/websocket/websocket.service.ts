import { Injectable } from '@nestjs/common';

@Injectable()
export class WebSocketService {
  private clients = new Map<string, any>();

  addClient(clientId: string, client: any): void {
    this.clients.set(clientId, client);
  }

  removeClient(clientId: string): void {
    this.clients.delete(clientId);
  }

  broadcast(event: string, data: any): void {
    this.clients.forEach((client) => {
      client.emit(event, data);
    });
  }

  sendToClient(clientId: string, event: string, data: any): void {
    const client = this.clients.get(clientId);
    if (client) {
      client.emit(event, data);
    }
  }

  getConnectedClients(): number {
    return this.clients.size;
  }
}