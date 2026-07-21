export type EntryPointFamily = 'request-wait' | 'send-forget' | 'reacts-alone' | 'specialized';

export type EntryKind =
  | 'http'
  | 'api'
  | 'route'
  | 'page'
  | 'websocket'
  | 'cli'
  | 'command'
  | 'ipc'
  | 'rpc'
  | 'event'
  | 'schedule'
  | 'message'
  | 'task'
  | 'pipeline'
  | 'lifecycle'
  | 'file'
  | 'interrupt'
  | 'driver'
  | 'train'
  | 'notebook-cell';

export interface FamilyMeta {
  id: EntryPointFamily;
  label: string;
  modality: string;
  tagline: string;
}

export const FAMILIES: Record<EntryPointFamily, FamilyMeta> = {
  'request-wait': {
    id: 'request-wait',
    label: 'Request & wait',
    modality: 'Synchronous',
    tagline: 'A caller sends a request and holds the line until the system responds.',
  },
  'send-forget': {
    id: 'send-forget',
    label: 'Send & forget',
    modality: 'Asynchronous',
    tagline: 'A message, event, or timer arrives and the system reacts — no one is waiting on a reply.',
  },
  'reacts-alone': {
    id: 'reacts-alone',
    label: 'Reacts on its own',
    modality: 'Passive',
    tagline: "Nothing external calls these — the system's own runtime or environment triggers them.",
  },
  specialized: {
    id: 'specialized',
    label: 'Specialized',
    modality: 'Data / ML',
    tagline: 'Entry points specific to data pipelines and model training.',
  },
};

export interface KindMeta {
  kind: EntryKind;
  family: EntryPointFamily;
  label: string;
  meaning: string;
}

export const KIND_META: Record<EntryKind, KindMeta> = {
  http: { kind: 'http', family: 'request-wait', label: 'Web / HTTP endpoint', meaning: 'A URL the system answers, with a verb (GET, POST…).' },
  api: { kind: 'api', family: 'request-wait', label: 'API operation', meaning: 'A declared API call, often one of many under a shared spec.' },
  route: { kind: 'route', family: 'request-wait', label: 'Web route / page', meaning: 'A page or route a browser loads directly.' },
  page: { kind: 'page', family: 'request-wait', label: 'UI interaction', meaning: 'A button or form handler in a web app.' },
  rpc: { kind: 'rpc', family: 'request-wait', label: 'gRPC / RPC method', meaning: 'A remote procedure call — a method, not a web path.' },
  websocket: { kind: 'websocket', family: 'request-wait', label: 'Live socket (WebSocket)', meaning: 'A persistent two-way connection held open.' },
  cli: { kind: 'cli', family: 'request-wait', label: 'Command-line command', meaning: 'A subcommand run in a terminal.' },
  command: { kind: 'command', family: 'request-wait', label: 'Desktop app command', meaning: 'A command a desktop UI calls into its own backend.' },
  ipc: { kind: 'ipc', family: 'request-wait', label: 'In-app message (IPC)', meaning: 'A call from a desktop UI to its background process.' },
  message: { kind: 'message', family: 'send-forget', label: 'Message / queue', meaning: 'An item pulled from a queue and handled.' },
  event: { kind: 'event', family: 'send-forget', label: 'Event / topic', meaning: 'A published or consumed event — pub/sub, streams, and incoming webhooks all surface here.' },
  schedule: { kind: 'schedule', family: 'send-forget', label: 'Scheduled job', meaning: 'A timed, recurring trigger (a cron schedule).' },
  task: { kind: 'task', family: 'send-forget', label: 'Pipeline task', meaning: 'A data-pipeline step.' },
  pipeline: { kind: 'pipeline', family: 'send-forget', label: 'Pipeline run', meaning: 'A whole pipeline run — the DAG/flow/job itself.' },
  lifecycle: { kind: 'lifecycle', family: 'reacts-alone', label: 'Lifecycle hook', meaning: "Runs at a defined moment in the app's life, including startup/shutdown." },
  file: { kind: 'file', family: 'reacts-alone', label: 'File watcher', meaning: 'Fires when a file appears or changes.' },
  interrupt: { kind: 'interrupt', family: 'reacts-alone', label: 'Hardware interrupt', meaning: 'A timer or hardware signal (embedded systems).' },
  driver: { kind: 'driver', family: 'reacts-alone', label: 'Driver hook', meaning: 'A kernel or driver callback (embedded systems).' },
  train: { kind: 'train', family: 'specialized', label: 'ML training entry', meaning: 'The start of a model training loop.' },
  'notebook-cell': { kind: 'notebook-cell', family: 'specialized', label: 'Notebook cell', meaning: 'An ordered cell in a data notebook.' },
};

export const FAMILY_ORDER: EntryPointFamily[] = ['request-wait', 'send-forget', 'reacts-alone', 'specialized'];

export function kindsInFamily(family: EntryPointFamily): EntryKind[] {
  return (Object.keys(KIND_META) as EntryKind[]).filter(k => KIND_META[k].family === family);
}

export function isKnownKind(value: string): value is EntryKind {
  return value !== 'test' && Object.prototype.hasOwnProperty.call(KIND_META, value);
}
