/**
 * Generates the two pinned reference fixtures used by perf-budget.ts:
 *   fixtures/perf-budget/small  (~150 files)
 *   fixtures/perf-budget/medium (~500 files)
 *
 * Both are deterministic (no randomness, no network, no timestamps) realistic
 * TS/Express+React apps: an Express API with routes/controllers/services/
 * models, and a React frontend with pages/components/hooks calling that API.
 * Run once to materialize; the OUTPUT is committed, not the generator's
 * runtime behavior, so re-running must reproduce byte-identical trees.
 *
 * Usage: tsx scripts/generate-perf-fixtures.ts
 */
import * as fs from 'fs-extra';
import * as path from 'path';

const FIXTURES_ROOT = path.resolve(__dirname, '..', 'fixtures', 'perf-budget');

interface FixtureSpec {
  name: 'small' | 'medium';
  resourceCount: number; // each resource contributes ~1 route file, 1 controller, 1 service, 1 model, 1 page, 1 component, 1 hook, 1 test = 8 files
}

const SPECS: FixtureSpec[] = [
  { name: 'small', resourceCount: 14 }, // 14*10 = 140 generated + 6 fixed scaffolding = 146
  { name: 'medium', resourceCount: 49 }, // 49*10 = 490 generated + 6 fixed scaffolding = 496
];

function pascalCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const RESOURCE_NAMES = [
  'user', 'order', 'product', 'invoice', 'payment', 'customer', 'shipment', 'inventory',
  'review', 'category', 'cart', 'coupon', 'subscription', 'notification', 'address',
  'refund', 'ticket', 'session', 'report', 'vendor', 'warehouse', 'employee', 'department',
  'project', 'task', 'comment', 'attachment', 'tag', 'audit', 'setting', 'role',
  'permission', 'team', 'contract', 'invoiceLine', 'shipmentLeg', 'paymentMethod',
  'discount', 'promotion', 'campaign', 'lead', 'contact', 'company', 'deal', 'quote',
  'renewal', 'webhook', 'apiKey', 'device', 'location', 'zone', 'route', 'driver',
  'vehicle', 'maintenance', 'fuelLog', 'incident', 'claim', 'policy', 'asset', 'license',
  'certificate', 'training', 'schedule', 'timesheet', 'expense', 'budget', 'forecast',
];

function resourceName(index: number): string {
  const base = RESOURCE_NAMES[index % RESOURCE_NAMES.length];
  const cycle = Math.floor(index / RESOURCE_NAMES.length);
  return cycle === 0 ? base : `${base}${cycle}`;
}

async function writeFile(root: string, rel: string, content: string): Promise<void> {
  const full = path.join(root, rel);
  await fs.ensureDir(path.dirname(full));
  await fs.writeFile(full, content);
}

function backendModel(entity: string): string {
  const Entity = pascalCase(entity);
  return `export interface ${Entity} {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: '${entity}_active' | '${entity}_inactive';
}

export function is${Entity}(value: unknown): value is ${Entity} {
  return typeof value === 'object' && value !== null && 'id' in value;
}
`;
}

function backendService(entity: string): string {
  const Entity = pascalCase(entity);
  return `import { ${Entity} } from '../models/${entity}.model';

const store = new Map<string, ${Entity}>();

export class ${Entity}Service {
  async list(): Promise<${Entity}[]> {
    return Array.from(store.values());
  }

  async get(id: string): Promise<${Entity} | undefined> {
    return store.get(id);
  }

  async create(input: Omit<${Entity}, 'id' | 'createdAt' | 'updatedAt'>): Promise<${Entity}> {
    const now = new Date(0).toISOString();
    const record: ${Entity} = {
      id: \`${entity}_\${store.size + 1}\`,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    store.set(record.id, record);
    return record;
  }

  async update(id: string, patch: Partial<${Entity}>): Promise<${Entity} | undefined> {
    const existing = store.get(id);
    if (!existing) return undefined;
    const updated = { ...existing, ...patch, updatedAt: new Date(0).toISOString() };
    store.set(id, updated);
    return updated;
  }

  async remove(id: string): Promise<boolean> {
    return store.delete(id);
  }
}

export const ${entity}Service = new ${Entity}Service();
`;
}

function backendController(entity: string): string {
  const Entity = pascalCase(entity);
  return `import { Request, Response } from 'express';
import { ${entity}Service } from '../services/${entity}.service';

export async function list${Entity}s(req: Request, res: Response): Promise<void> {
  const items = await ${entity}Service.list();
  res.json(items);
}

export async function get${Entity}(req: Request, res: Response): Promise<void> {
  const item = await ${entity}Service.get(req.params.id);
  if (!item) {
    res.status(404).json({ error: '${Entity} not found' });
    return;
  }
  res.json(item);
}

export async function create${Entity}(req: Request, res: Response): Promise<void> {
  const created = await ${entity}Service.create(req.body);
  res.status(201).json(created);
}

export async function update${Entity}(req: Request, res: Response): Promise<void> {
  const updated = await ${entity}Service.update(req.params.id, req.body);
  if (!updated) {
    res.status(404).json({ error: '${Entity} not found' });
    return;
  }
  res.json(updated);
}

export async function remove${Entity}(req: Request, res: Response): Promise<void> {
  const removed = await ${entity}Service.remove(req.params.id);
  res.status(removed ? 204 : 404).end();
}
`;
}

function backendRoute(entity: string): string {
  const Entity = pascalCase(entity);
  return `import { Router } from 'express';
import {
  list${Entity}s,
  get${Entity},
  create${Entity},
  update${Entity},
  remove${Entity},
} from '../controllers/${entity}.controller';

export const ${entity}Router = Router();

${entity}Router.get('/', list${Entity}s);
${entity}Router.get('/:id', get${Entity});
${entity}Router.post('/', create${Entity});
${entity}Router.put('/:id', update${Entity});
${entity}Router.delete('/:id', remove${Entity});
`;
}

function backendTest(entity: string): string {
  const Entity = pascalCase(entity);
  return `import { ${entity}Service } from '../services/${entity}.service';

describe('${Entity}Service', () => {
  it('creates and retrieves a ${entity}', async () => {
    const created = await ${entity}Service.create({ name: 'sample-${entity}', status: '${entity}_active' });
    const fetched = await ${entity}Service.get(created.id);
    expect(fetched).toEqual(created);
  });
});
`;
}

function frontendHook(entity: string): string {
  const Entity = pascalCase(entity);
  return `import { useCallback, useEffect, useState } from 'react';
import { fetch${Entity}s } from '../api/${entity}Client';
import type { ${Entity} } from '../types/${entity}';

export function use${Entity}s() {
  const [items, setItems] = useState<${Entity}[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const data = await fetch${Entity}s();
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, loading, reload };
}
`;
}

function frontendApiClient(entity: string): string {
  const Entity = pascalCase(entity);
  return `import type { ${Entity} } from '../types/${entity}';

const BASE_URL = '/api/${entity}s';

export async function fetch${Entity}s(): Promise<${Entity}[]> {
  const response = await fetch(BASE_URL);
  return response.json();
}

export async function fetch${Entity}(id: string): Promise<${Entity}> {
  const response = await fetch(\`\${BASE_URL}/\${id}\`);
  return response.json();
}

export async function create${Entity}(payload: Partial<${Entity}>): Promise<${Entity}> {
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}
`;
}

function frontendType(entity: string): string {
  const Entity = pascalCase(entity);
  return `export interface ${Entity} {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  status: '${entity}_active' | '${entity}_inactive';
}
`;
}

function frontendComponent(entity: string): string {
  const Entity = pascalCase(entity);
  return `import React from 'react';
import type { ${Entity} } from '../types/${entity}';

interface ${Entity}CardProps {
  item: ${Entity};
  onSelect?: (id: string) => void;
}

export function ${Entity}Card({ item, onSelect }: ${Entity}CardProps): JSX.Element {
  return (
    <div className="${entity}-card" onClick={() => onSelect?.(item.id)}>
      <h3>{item.name}</h3>
      <span>{item.status}</span>
    </div>
  );
}
`;
}

function frontendPage(entity: string): string {
  const Entity = pascalCase(entity);
  return `import React from 'react';
import { use${Entity}s } from '../hooks/use${Entity}s';
import { ${Entity}Card } from '../components/${Entity}Card';

export function ${Entity}Page(): JSX.Element {
  const { items, loading } = use${Entity}s();

  if (loading) {
    return <div>Loading ${entity}s...</div>;
  }

  return (
    <section className="${entity}-page">
      <h1>${Entity}s</h1>
      <div className="${entity}-list">
        {items.map((item) => (
          <${Entity}Card key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
`;
}

function backendApp(entities: string[]): string {
  const imports = entities
    .map((entity) => `import { ${entity}Router } from './routes/${entity}.routes';`)
    .join('\n');
  const mounts = entities
    .map((entity) => `app.use('/api/${entity}s', ${entity}Router);`)
    .join('\n');
  return `import express from 'express';
${imports}

export const app = express();
app.use(express.json());

${mounts}

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});
`;
}

function backendServer(): string {
  return `import { app } from './app';

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(\`server listening on \${PORT}\`);
});
`;
}

function frontendApp(entities: string[]): string {
  const imports = entities
    .map((entity) => `import { ${pascalCase(entity)}Page } from './pages/${pascalCase(entity)}Page';`)
    .join('\n');
  const routes = entities
    .map((entity) => `        <Route path="/${entity}s" element={<${pascalCase(entity)}Page />} />`)
    .join('\n');
  return `import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
${imports}

export function App(): JSX.Element {
  return (
    <BrowserRouter>
      <Routes>
${routes}
      </Routes>
    </BrowserRouter>
  );
}
`;
}

function frontendIndex(): string {
  return `import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
root.render(<App />);
`;
}

function packageJson(name: string): string {
  return `${JSON.stringify(
    {
      name,
      version: '0.0.0',
      private: true,
      scripts: {
        build: 'tsc -p tsconfig.json',
        test: 'jest',
      },
      dependencies: {
        express: '^4.19.2',
        react: '^18.3.1',
        'react-dom': '^18.3.1',
        'react-router-dom': '^6.26.0',
      },
      devDependencies: {
        typescript: '^5.5.4',
        jest: '^29.7.0',
        '@types/express': '^4.17.21',
        '@types/react': '^18.3.3',
      },
    },
    null,
    2
  )}\n`;
}

function tsconfigJson(): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2020',
        module: 'commonjs',
        jsx: 'react-jsx',
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        outDir: 'dist',
      },
      include: ['backend/src/**/*', 'frontend/src/**/*'],
    },
    null,
    2
  )}\n`;
}

async function generateFixture(spec: FixtureSpec): Promise<void> {
  const root = path.join(FIXTURES_ROOT, spec.name);
  await fs.remove(root);

  const entities = Array.from({ length: spec.resourceCount }, (_, i) => resourceName(i));

  await writeFile(root, 'package.json', packageJson(`perf-budget-fixture-${spec.name}`));
  await writeFile(root, 'tsconfig.json', tsconfigJson());
  await writeFile(root, 'backend/src/app.ts', backendApp(entities));
  await writeFile(root, 'backend/src/server.ts', backendServer());
  await writeFile(root, 'frontend/src/App.tsx', frontendApp(entities));
  await writeFile(root, 'frontend/src/index.tsx', frontendIndex());

  for (const entity of entities) {
    await writeFile(root, `backend/src/models/${entity}.model.ts`, backendModel(entity));
    await writeFile(root, `backend/src/services/${entity}.service.ts`, backendService(entity));
    await writeFile(root, `backend/src/controllers/${entity}.controller.ts`, backendController(entity));
    await writeFile(root, `backend/src/routes/${entity}.routes.ts`, backendRoute(entity));
    await writeFile(root, `backend/src/__tests__/${entity}.service.test.ts`, backendTest(entity));

    await writeFile(root, `frontend/src/types/${entity}.ts`, frontendType(entity));
    await writeFile(root, `frontend/src/api/${entity}Client.ts`, frontendApiClient(entity));
    await writeFile(root, `frontend/src/hooks/use${pascalCase(entity)}s.ts`, frontendHook(entity));
    await writeFile(root, `frontend/src/components/${pascalCase(entity)}Card.tsx`, frontendComponent(entity));
    await writeFile(root, `frontend/src/pages/${pascalCase(entity)}Page.tsx`, frontendPage(entity));
  }

  const fileCount = await countFiles(root);
  console.log(`generated ${spec.name}: ${entities.length} resources, ${fileCount} files at ${root}`);
}

async function countFiles(root: string): Promise<number> {
  let count = 0;
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        count += 1;
      }
    }
  };
  await walk(root);
  return count;
}

async function main(): Promise<void> {
  for (const spec of SPECS) {
    await generateFixture(spec);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
