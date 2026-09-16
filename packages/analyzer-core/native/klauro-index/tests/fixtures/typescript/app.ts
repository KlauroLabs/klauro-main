import path from "node:path";
import fs from "node:fs/promises";
import { CallManager } from "./manager.js";

export const registry = new Map<string, CallManager>();

export function mount(server: Server, logger: Logger): void {
  server.get('/health', async (request) => {
    logger.info('health checked');
    return { root: path.join('/', 'health'), size: registry.size };
  });

  server.post('/calls/:id', async (request) => {
    return persist(request.id);
  });
}

export async function persist(id: string): Promise<void> {
  if (!id) {
    throw new ValidationError('id is required');
  }
  await fs.writeFile(path.join('/tmp', id), '');
  await fetch(`https://example.invalid/${id}`);
}

const widened = await load<typeof import("./manager.js")>();

export function afterTheLimitation(): number {
  return registry.size;
}

export function summarise(raw: string, store: Store): string[] {
  store.purge();
  return raw.split(',').map((entry) => entry.trim());
}

export const dispatch = (respond: (ok: boolean) => void, id: string): void => {
  respond(true);
  const parts: string[] = [];
  parts.push(id);
};
