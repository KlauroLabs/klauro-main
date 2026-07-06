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

// Command verbs that indicate a shell command was captured, not a service name
// (e.g. `dotnet pack "Foo/Foo.csproj" -p:Version=$VER` from a CI script).
const COMMAND_VERB_PATTERN = /^(?:\.net|dotnet|npm|npx|pnpm|yarn|bun|cargo|rustup|docker|docker-compose|podman|kubectl|helm|bash|sh|zsh|pwsh|powershell|python[0-9.]*|pip[0-9]*|node|deno|go|mvn|gradle|make|cmake|msbuild|nuget|terraform|ansible|pulumi|aws|az|gcloud|gh|git|curl|wget|scp|rsync|ssh|apt|apt-get|yum|brew|composer|bundle|rake|flutter|swift|xcodebuild|echo|export|cd|cp|mv|rm|mkdir|chmod|tar|zip|unzip)\s+\S/i;

/**
 * True when a candidate label looks like a shell command / CI script fragment
 * (or a piece of one) rather than the name of a real external service.
 * Command-shaped tokens must never become narrative labels — they can survive
 * only as raw evidence/metadata. (hash-shaped-token-leak class)
 */
export function isCommandShapedLabel(name: string): boolean {
  const value = (name || '').trim();
  if (!value) return false;
  // Shell metacharacters / quoting never appear in real service names.
  if (/[|&;<>`"\\]/.test(value)) return true;
  // Unexpanded variables: $VER, ${VERSION}, %VERSION%, ${{ github.ref }}
  if (/\$\{?[A-Za-z_{]/.test(value) || /%[A-Za-z_][A-Za-z0-9_]*%/.test(value)) return true;
  // CLI flag tokens: -p:Version=, --output, -o dir
  if (/(?:^|\s)--?[A-Za-z]/.test(value)) return true;
  // Path separator combined with a file extension: Soon.TestingUtilities/Soon.TestingUtilities.csproj
  if (/\/[^\s/]*\.[A-Za-z0-9]{1,6}(?:\s|$)/.test(value) && !/:\/\//.test(value)) return true;
  // Command verb at the start followed by arguments: `dotnet pack …`, `npm publish …`
  if (COMMAND_VERB_PATTERN.test(value)) return true;
  // Command verb joined to a subcommand by - or _: `dotnet-pack`, `npm-publish`.
  // Deliberately a NARROW verb list (no `go`, `make`, …) so real library/service
  // labels like `go-redis` are not swept up.
  if (/^(?:dotnet|npm|npx|pnpm|yarn|cargo|docker|docker-compose|podman|kubectl|helm|git|nuget|msbuild|gradle|mvn|pip|terraform|pulumi|ansible|xcodebuild)[-_][a-z][a-z0-9-]*$/i.test(value)) return true;
  // Overlong multi-word fragments are prose/commands, not names.
  const words = value.split(/\s+/);
  if (words.length >= 5) return true;
  if (words.length >= 2 && value.length > 60) return true;
  return false;
}

// A conservative set of TLDs that real external-service hostnames use. This is
// not exhaustive — it exists only to distinguish a hostname (auth0.com,
// api.stripe.com, sentry.io) from a dotted code identifier (this.foo.bar,
// Repo.Save) or a namespaced type (System.Text). Bare-domain services must be
// admissible; internal member access must not.
const KNOWN_SERVICE_TLDS = new Set([
  'com', 'net', 'org', 'io', 'co', 'ai', 'dev', 'app', 'cloud', 'gov', 'edu',
  'info', 'biz', 'me', 'sh', 'xyz', 'tech', 'run', 'link',
]);

/**
 * True when a candidate label is a real hostname (an external service reachable
 * by domain), e.g. `auth0.com`, `api.stripe.com`, `sentry.io`. Requires:
 * dot-separated DNS labels, a recognized TLD, no path, no scheme, no shell
 * characters, no CLI flags — so a file path (`foo/bar.csproj`), a namespaced
 * code identifier (`System.Text`), or a member-access chain (`this.repo.save`)
 * is NOT a hostname. Optional URL scheme (`https://…`) and a leading `www.` /
 * `api.` subdomain are tolerated; a path segment is not.
 */
export function isHostnameLikeServiceName(name: string): boolean {
  let value = (name || '').trim();
  if (!value) return false;
  if (isCommandShapedLabel(value)) return false;
  // Tolerate an explicit scheme but reject anything with a path/query/port.
  const schemeMatch = value.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (schemeMatch) {
    if (!/^https?$/i.test(schemeMatch[1])) return false;
    value = value.slice(schemeMatch[0].length);
  }
  // A path, query, fragment, port, or whitespace means this is not a bare host.
  if (/[\/?#:\s]/.test(value)) return false;
  const labels = value.split('.');
  if (labels.length < 2) return false;
  // Each DNS label: alphanumeric + hyphen, not starting/ending with a hyphen.
  if (!labels.every(label => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))) return false;
  const tld = labels[labels.length - 1].toLowerCase();
  // TLD must be alphabetic and recognized (excludes `.csproj`, `.Save`, `.ts`).
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
