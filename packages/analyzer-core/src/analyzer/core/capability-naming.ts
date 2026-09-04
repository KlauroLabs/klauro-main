


















export const CAPABILITY_PURPOSE_VERBS = new Set<string>([
  'get', 'set', 'fetch', 'list', 'find', 'load', 'show', 'view', 'read', 'browse', 'retrieve', 'review',
  'create', 'add', 'new', 'update', 'edit', 'adjust', 'change', 'delete', 'remove', 'save', 'reset', 'transfer',
  'submit', 'send', 'sync', 'run', 'execute', 'process', 'handle', 'make',
  'build', 'init', 'initialize', 'validate', 'check', 'resolve', 'generate', 'parse', 'extract',
  'start', 'stop', 'open', 'close', 'enable', 'disable', 'apply', 'compute',
  'manage', 'provide', 'support', 'expose', 'monitor', 'track',
  'secure', 'detect', 'analyze', 'analyse', 'orchestrate', 'coordinate',
  'schedule', 'transform', 'render', 'display', 'authenticate', 'authorize', 'impersonate',
  'notify', 'report', 'export', 'import', 'connect', 'synchronize',
  'discover', 'configure', 'deploy', 'migrate', 'ingest', 'stream', 'route',
  'dispatch', 'reconcile', 'audit', 'log', 'cache', 'queue', 'persist',
  'store', 'serve', 'correlate', 'collect', 'record', 'settle', 'publish', 'categorize', 'classify', 'organize', 'group', 'maintain', 'administer', 'follow', 'unfollow', 'favorite', 'unfavorite',
  'capture', 'filter', 'keep', 'search', 'share', 'sort', 'index',
  'visualize',
  'learn', 'offer', 'onboard',
  'ground', 'help', 'surface', 'turn', 'understand',
]);


























export const SOURCE_FILE_EXTENSION_TOKENS = new Set<string>([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'd',
  'py', 'pyi', 'rb', 'rake', 'php', 'go', 'rs', 'java', 'kt', 'kts', 'scala',
  'swift', 'm', 'mm', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'cs', 'fs',
  'ex', 'exs', 'erl', 'hrl', 'clj', 'cljs', 'cljc', 'edn', 'lisp', 'el',
  'dart', 'vue', 'svelte', 'astro', 'sol', 'lua', 'pl', 'pm', 'r', 'jl',
  'groovy', 'gradle', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd',
  'sql', 'graphql', 'gql', 'proto', 'thrift', 'nix', 'tf', 'tfvars', 'hcl',
  'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env',
  'xml', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'styl',
  'md', 'mdx', 'rst', 'txt', 'lock', 'snap', 'map', 'wasm', 'vhd', 'vhdl', 'sv',
  'zig', 'nim', 'cr', 'hs', 'ml', 'mli', 'vb', 'pas', 'asm', 's',
]);
















export const STORAGE_PATH_NOISE_TOKENS = new Set<string>([
  'var', 'tmp', 'temp', 'opt', 'usr', 'srv', 'mnt', 'etc', 'proc',
  'private', 'volumes', 'workspace', 'workspaces', 'workdir', 'checkout',
  'prj', 'proj', 'bin', 'obj', 'dist', 'node_modules', 'vendor',
]);








const AMBIGUOUS_EXTENSION_WORDS = new Set<string>([
  'go', 'java', 'swift', 'sql', 'html', 'htm', 'css', 'xml', 'json', 'md',
  'env', 'map', 'lock', 'proto', 'graphql', 'dart', 'vue', 'svelte', 'astro',
  'sol', 'lua', 'txt', 'conf', 'cache', 'index', 'wasm',
]);






export const FILE_EXTENSION_TAIL_TOKENS = new Set<string>(
  [...SOURCE_FILE_EXTENSION_TOKENS].filter(token => !AMBIGUOUS_EXTENSION_WORDS.has(token))
);





export function isStoragePathToken(token: string): boolean {
  const normalized = String(token || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return Boolean(normalized) && STORAGE_PATH_NOISE_TOKENS.has(normalized);
}






export function isOpaqueIdentifierToken(token: string): boolean {
  const normalized = String(token || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (normalized.length < 6) return false;
  if (/^[0-9a-f]{8,}$/.test(normalized)) return true;
  return /^(?=.*[a-z])(?=.*[0-9])[a-z0-9]{8,}$/.test(normalized);
}







export function stripSourceFileExtension(segment: string): string {
  const value = String(segment || '');
  const match = /^(.*)\.([A-Za-z0-9]+)$/.exec(value);
  if (!match) return value;
  return SOURCE_FILE_EXTENSION_TOKENS.has(match[2].toLowerCase()) ? match[1] : value;
}












export function namingSubjectFromPath(value: string): string {
  const normalized = String(value || '').replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  const basename = segments.length > 0 ? segments[segments.length - 1] : normalized;
  return stripSourceFileExtension(basename);
}














export function isPathDerivedCapabilityName(name: string): boolean {
  const words = String(name || '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(word => word.toLowerCase());
  if (words.length === 0) return false;
  const tail = words[words.length - 1];
  if (words.length > 1 && FILE_EXTENSION_TAIL_TOKENS.has(tail)) return true;
  if (words.some(word => isOpaqueIdentifierToken(word))) return true;
  for (let index = 1; index < words.length; index++) {
    if (isStoragePathToken(words[index - 1]) && isStoragePathToken(words[index])) return true;
  }
  return false;
}
















export function isMalformedCapabilityLabel(name: string): boolean {
  const trimmed = String(name || '').trim();
  if (!trimmed) return true;
  const opens = (trimmed.match(/[([{]/g) || []).length;
  const closes = (trimmed.match(/[)\]}]/g) || []).length;
  if (opens !== closes) return true;

  if (/[*]/.test(trimmed)) return true;
  const words = trimmed.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (words.some(word => isOpaqueIdentifierToken(word) || /^\d{6,}$/.test(word))) return true;
  return false;
}








export function collapseDuplicateAdjacentWords(label: string): string {
  const words = String(label || '').split(/\s+/).filter(Boolean);
  const result: string[] = [];
  for (const word of words) {
    const previous = result[result.length - 1];
    if (previous && previous.toLowerCase() === word.toLowerCase()) continue;
    result.push(word);
  }
  return result.join(' ');
}





export function humanizeCapabilityLabel(label: string): string {
  return String(label || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, char => char.toUpperCase());
}

export function normalizeCapabilityActionName(name: string): string {
  const imperativeFor = (word: string): string => {
    const lower = word.toLowerCase();
    const candidates = [
      lower.endsWith('ies') ? `${lower.slice(0, -3)}y` : '',
      lower.endsWith('es') ? lower.slice(0, -1) : '',
      lower.endsWith('es') ? lower.slice(0, -2) : '',
      lower.endsWith('s') ? lower.slice(0, -1) : '',
    ].filter(Boolean);
    const imperative = candidates.find(candidate => CAPABILITY_PURPOSE_VERBS.has(candidate));
    if (!imperative) return word;
    return word[0] === word[0].toUpperCase()
      ? `${imperative[0].toUpperCase()}${imperative.slice(1)}`
      : imperative;
  };
  return String(name || '').trim().replace(
    /(^|\b(?:and|or)\s+)([A-Za-z]+)/gi,
    (_match, prefix: string, verb: string) => `${prefix}${imperativeFor(verb)}`,
  );
}















export function isBareNounCapabilityLabel(name: string): boolean {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 2) return false;
  if (words.length === 1) return true;
  const first = words[0].toLowerCase().replace(/[^a-z]/g, '');
  if (CAPABILITY_PURPOSE_VERBS.has(first)) return false;


  const stem = first.replace(/(ing|ed|es|s)$/, '');
  if (CAPABILITY_PURPOSE_VERBS.has(stem)) return false;
  return true;
}


export function isGenericManagementCapabilityLabel(name: string): boolean {
  return /^(?:manage(?:s|d|ment|ing)?|handl(?:e|es|ed|ing)|process(?:es|ed|ing)?)\b/i.test(String(name || '').trim());
}

export function isCrudInventoryCapabilityLabel(name: string): boolean {
  const value = String(name || '').trim().toLowerCase();
  const action = '(?:access|add|archive|browse|change|create|delete|edit|find|get|list|manage|read|record|register|remove|retrieve|review|search|show|update|view)';
  return new RegExp(`^${action}\\b(?:\\s*,\\s*|\\s+(?:and|or)\\s+)${action}\\b`, 'i').test(value) ||
    /^(?:access|browse|get|list|manage|read|record|register|review|show|track|view)\s+(?:and|or)\s+(?:archive|delete|remove)\b/i.test(value);
}







export function isCrudLifecycleFragmentCapabilityLabel(name: string, observableActions: readonly string[]): boolean {
  const lifecycleActions = new Set(observableActions.flatMap(value =>
    String(value || '').toLowerCase().match(/\b(?:create|read|update|delete)\b/g) || []));
  return lifecycleActions.size >= 3 &&
    /^(?:add|create|delete|edit|get|list|read|remove|retrieve|show|update|view)\b/i.test(String(name || '').trim());
}


export function isStructuralPlaceholderCapabilityDescription(description: string): boolean {
  const trimmed = String(description || '').trim();
  if (!trimmed) return false;
  return /^[^:]{1,80}:\s+(?:[a-z]+\s+operation\s+via\s+\S+\s*$|\d+\s+operations?\s*\()/i.test(trimmed) ||
    /\b(?:through the same|throughout the complete product|through (?:its|their|the) supported) lifecycle whenever needed\.?$/i.test(trimmed) ||
    /\bas part of (?:their|the) normal workflow whenever needed\.?$/i.test(trimmed);
}


export interface CapabilityOperationEvidence {
  name?: string;
  action?: string;
  entry_point_type?: string;
  trigger?: { type?: string; method?: string; path?: string };
}











export function deriveCapabilityNameFromOperations(
  subject: string,
  operations: CapabilityOperationEvidence[],
  hasAnchorEvidence: boolean
): string | undefined {
  const opLabels = (operations || [])
    .map(op => String(op.name || op.action || '').trim())
    .filter(Boolean)
    .map(label => humanizeCapabilityLabel(label));
  const verbHeaded = opLabels.find(label => {
    const words = label.split(/\s+/);
    return words.length >= 2 && !isBareNounCapabilityLabel(label);
  });
  if (verbHeaded) return verbHeaded;
  const trimmed = String(subject || '').trim();
  if (!trimmed || !hasAnchorEvidence) return undefined;
  return `Manage ${trimmed}`;
}







export function buildCapabilityDescriptionFromOperations(
  operations: CapabilityOperationEvidence[]
): string | undefined {
  const labels = Array.from(new Set(
    (operations || [])
      .map(op => String(op.name || op.action || '').trim())
      .filter(Boolean)
      .map(label => humanizeCapabilityLabel(label))
  ));
  if (labels.length === 0) return undefined;
  const kinds = Array.from(new Set(
    (operations || []).map(op => String(op.entry_point_type || op.trigger?.type || '').trim()).filter(Boolean)
  ));
  const kindLabel = kinds.length === 1 ? ` ${kinds[0]}` : '';
  const sample = labels.slice(0, 3).join(', ');
  const suffix = labels.length > 3 ? ` and ${labels.length - 3} more` : '';
  return `Covers ${labels.length}${kindLabel} operation${labels.length === 1 ? '' : 's'}: ${sample}${suffix}.`;
}
