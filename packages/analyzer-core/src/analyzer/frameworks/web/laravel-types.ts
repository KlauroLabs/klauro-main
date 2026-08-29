export interface LaravelApplication {
  nodeId: string;
  name: string;
  version: string;
  type: 'laravel' | 'lumen' | 'custom';
  hasEnvConfig: boolean;
  database: string[];
  cache: string[];
  queue: string[];
  session: string;
  mail: string;
}

export interface LaravelController {
  name: string;
  filePath: string;
  namespace: string;
  methods: Array<{ name: string; visibility: string; parameters: any[]; returnType?: string; line: number }>;
  middleware: string[];
  resourceController: boolean;
  apiController: boolean;
  traits: string[];
  dependencies: string[];
}

export interface LaravelModel {
  name: string;
  filePath: string;
  table?: string;
  primaryKey: string;
  fillable: string[];
  guarded: string[];
  hidden: string[];
  casts: Record<string, string>;
  relations: Array<{ name: string; type: string; model: string; foreignKey?: string; line: number }>;
  scopes: string[];
  mutators: string[];
  accessors: string[];
  traits: string[];
}

export interface LaravelMigration {
  name: string;
  filePath: string;
  table: string;
  action: 'create' | 'modify' | 'drop';
  columns: Array<{ name: string; type: string; modifiers: string[] }>;
  indexes: Array<{ type: string; columns: string[] }>;
  foreignKeys: Array<{ column: string; references: string; on: string }>;
}

export interface LaravelRoute {
  method: string | string[];
  uri: string;
  name?: string;
  controller?: string;
  action?: string;
  middleware: string[];
  where: Record<string, string>;
  parameters: string[];
  group?: string;
}

export interface LaravelMiddleware {
  name: string;
  filePath: string;
  handle: { parameters: any[]; returnType?: string };
  terminate?: { parameters: any[]; returnType?: string };
  global: boolean;
  routeMiddleware: boolean;
  middlewareGroups: string[];
}

export interface LaravelService {
  name: string;
  filePath: string;
  bindings: Array<{ abstract: string; concrete: string; singleton: boolean }>;
  dependencies: string[];
  methods: Array<{ name: string; visibility: string; parameters: any[]; line: number }>;
}

export interface LaravelCommand {
  name: string;
  filePath: string;
  signature: string;
  description: string;
  handle: { parameters: any[]; returnType?: string };
  arguments: Array<{ name: string; required: boolean; description?: string }>;
  options: Array<{ name: string; shortcut?: string; mode: string; description?: string }>;
}

export interface LaravelJob {
  name: string;
  filePath: string;
  queue?: string;
  connection?: string;
  tries?: number;
  timeout?: number;
  handle: { parameters: any[]; returnType?: string };
  failed?: { parameters: any[]; returnType?: string };
  shouldQueue: boolean;
}
