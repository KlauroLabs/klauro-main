import path from "node:path";
import { CallManager } from "./manager.js";

export const registry = new Map<string, CallManager>();

export function mount(server: Server): void {
  server.get('/health', async (request) => {
    return { root: path.join('/', 'health'), size: registry.size };
  });
}

const widened = await load<typeof import("./manager.js")>();

export function afterTheLimitation(): number {
  return registry.size;
}
