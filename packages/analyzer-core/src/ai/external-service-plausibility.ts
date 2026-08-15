const KNOWN_SERVICE_NAMES = new Set([
  'stripe', 'paypal', 'braintree', 'plaid', 'square', 'adyen',
  'redis', 'postgres', 'postgresql', 'mysql', 'mariadb', 'mongodb', 'mongo', 'sqlite', 'dynamodb',
  'kafka', 'rabbitmq', 'nats', 'pulsar', 'sqs', 'sns', 'kinesis', 'pubsub', 'eventbridge',
  'elasticsearch', 'opensearch', 'solr', 'algolia', 'meilisearch', 'typesense',
  'memcached', 'etcd', 'consul', 'vault', 'zookeeper',
  's3', 'gcs', 'lambda', 'cloudfront', 'cloudflare', 'fastly', 'akamai',
  'twilio', 'sendgrid', 'mailgun', 'postmark', 'ses', 'mailchimp',
  'github', 'gitlab', 'bitbucket', 'jira', 'linear', 'slack', 'discord', 'teams', 'zoom', 'intercom', 'zendesk',
  'openai', 'anthropic', 'ollama', 'huggingface', 'cohere', 'gemini', 'bedrock',
  'firebase', 'supabase', 'auth0', 'okta', 'cognito', 'clerk', 'keycloak',
  'datadog', 'sentry', 'newrelic', 'grafana', 'prometheus', 'splunk', 'pagerduty', 'segment', 'mixpanel', 'amplitude',
  'salesforce', 'hubspot', 'shopify', 'zapier', 'airtable', 'notion',
  'vercel', 'netlify', 'heroku', 'render', 'fly', 'railway',
  'pinecone', 'weaviate', 'qdrant', 'milvus', 'chroma',
  'pusher', 'lob', 'taxjar', 'taxjarapi', 'geocodio', 'mapbox', 'twilioverify',
  'shippo', 'easypost', 'stripeconnect',
]);

const CODE_TYPE_TOKENS = new Set([
  'socket', 'sockets', 'packet', 'packets', 'pool', 'pools', 'pooled', 'buffer', 'buffers', 'bufferpool',
  'stream', 'streams', 'channel', 'channels', 'mutex', 'rwlock', 'thread', 'threads', 'timer', 'timers',
  'future', 'futures', 'slice', 'slices', 'offset', 'offsets', 'ptr', 'vec', 'bytes', 'codec',
  'frame', 'frames', 'header', 'headers', 'payload', 'cursor', 'waker', 'task', 'tasks', 'spawn',
  'runtime', 'executor', 'listener', 'acceptor', 'duration', 'instant', 'datetime', 'timestamp',
  'offsetdatetime', 'uuid', 'regex', 'path', 'pathbuf', 'string', 'str', 'option', 'result', 'error',
  'iterator', 'stdin', 'stdout', 'stderr', 'tcpstream', 'udpsocket', 'tcplistener', 'unixstream',
  'hashmap', 'hashset', 'btreemap', 'btreeset', 'vecdeque', 'arc', 'box', 'cell', 'refcell',
  'queuehandle', 'handle', 'handles', 'context', 'config', 'options', 'builder', 'wrapper',
  'session', 'sessions', 'connection', 'connections', 'message', 'messages', 'request', 'requests',
  'response', 'responses', 'client', 'clients', 'server', 'servers', 'peer', 'peers',
  'database', 'mutation', 'mutations', 'query', 'queries', 'apiconnection',
  'self',
]);

const PASCAL_CASE_MULTIWORD_PATTERN = /^[A-Z][a-z0-9]*(?:[A-Z][a-z0-9]*)+$/;



const COMMAND_VERB_PATTERN = /^(?:\.net|dotnet|npm|npx|pnpm|yarn|bun|cargo|rustup|docker|docker-compose|podman|kubectl|helm|bash|sh|zsh|pwsh|powershell|python[0-9.]*|pip[0-9]*|node|deno|go|mvn|gradle|make|cmake|msbuild|nuget|terraform|ansible|pulumi|aws|az|gcloud|gh|git|curl|wget|scp|rsync|ssh|apt|apt-get|yum|brew|composer|bundle|rake|flutter|swift|xcodebuild|echo|export|cd|cp|mv|rm|mkdir|chmod|tar|zip|unzip)\s+\S/i;







export function isCommandShapedLabel(name: string): boolean {
  const value = (name || '').trim();
  if (!value) return false;

  if (/[|&;<>`"\\]/.test(value)) return true;

  if (/\$\{?[A-Za-z_{]/.test(value) || /%[A-Za-z_][A-Za-z0-9_]*%/.test(value)) return true;

  if (/(?:^|\s)--?[A-Za-z]/.test(value)) return true;

  if (/\/[^\s/]*\.[A-Za-z0-9]{1,6}(?:\s|$)/.test(value) && !/:\/\//.test(value)) return true;

  if (COMMAND_VERB_PATTERN.test(value)) return true;



  if (/^(?:dotnet|npm|npx|pnpm|yarn|cargo|docker|docker-compose|podman|kubectl|helm|git|nuget|msbuild|gradle|mvn|pip|terraform|pulumi|ansible|xcodebuild)[-_][a-z][a-z0-9-]*$/i.test(value)) return true;

  const words = value.split(/\s+/);
  if (words.length >= 5) return true;
  if (words.length >= 2 && value.length > 60) return true;
  return false;
}






const KNOWN_SERVICE_TLDS = new Set([
  'com', 'net', 'org', 'io', 'co', 'ai', 'dev', 'app', 'cloud', 'gov', 'edu',
  'info', 'biz', 'me', 'sh', 'xyz', 'tech', 'run', 'link',
]);










export function isHostnameLikeServiceName(name: string): boolean {
  let value = (name || '').trim();
  if (!value) return false;
  if (isCommandShapedLabel(value)) return false;

  const schemeMatch = value.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (schemeMatch) {
    if (!/^https?$/i.test(schemeMatch[1])) return false;
    value = value.slice(schemeMatch[0].length);
  }

  if (/[\/?#:\s]/.test(value)) return false;
  const labels = value.split('.');
  if (labels.length < 2) return false;

  if (!labels.every(label => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))) return false;
  const tld = labels[labels.length - 1].toLowerCase();

  if (!/^[a-z]{2,}$/.test(tld)) return false;
  return KNOWN_SERVICE_TLDS.has(tld);
}

function normalizeServiceName(name: string): string {
  return (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function isPlausibleExternalServiceName(name: string, selfNames: string[] = []): boolean {
  const trimmed = (name || '').trim();
  if (!trimmed) return false;
  const norm = normalizeServiceName(trimmed);
  if (!norm) return false;

  const selfNorms = selfNames.map(normalizeServiceName).filter(Boolean);
  if (selfNorms.some(self => self === norm || (norm.length >= 3 && self.includes(norm)) || (self.length >= 3 && norm.includes(self)))) {
    return false;
  }

  if (KNOWN_SERVICE_NAMES.has(norm)) return true;
  if (isCommandShapedLabel(trimmed)) return false;
  if (/^[A-Za-z][A-Za-z ]*:\s/.test(trimmed)) return false;
  if (/\boperations?\s+via\b/i.test(trimmed)) return false;
  if (/_/.test(trimmed)) return false;
  if (/\.(?:js|jsx|ts|tsx|mjs|cjs|dart|rs|go|py|php|rb|java|cs)$/i.test(trimmed)) return false;
  if (/^(?:@\/|~\/|\.{1,2}\/|\/)/.test(trimmed)) return false;
  if (/^@[^/]+\/.+\/.+/.test(trimmed)) return false;
  if (/^@?[\w.-]+\/[\w./-]+$/.test(trimmed) && !/:\/\//.test(trimmed)) return false;
  if (/\.|:\/\//.test(trimmed)) return true;
  if (/^[A-Z][A-Za-z0-9]*(?:Service|Client|Sdk|SDK|Api|API)$/.test(trimmed) && !CODE_TYPE_TOKENS.has(norm)) return true;
  if (PASCAL_CASE_MULTIWORD_PATTERN.test(trimmed)) return false;
  if (CODE_TYPE_TOKENS.has(norm)) return false;
  return false;
}

export function filterPlausibleExternalServices(externalServices: string[], selfNames: string[] = []): string[] {
  return (externalServices || []).filter(name => isPlausibleExternalServiceName(name, selfNames));
}
