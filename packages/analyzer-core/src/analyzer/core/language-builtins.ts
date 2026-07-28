import type { CASExitPoint } from '../../types/cas.types';

/**
 * Names that belong to a language runtime or standard library rather than an
 * external service. These must never be presented as external data recipients,
 * external services, or SDK integrations: "External call: array_filter" is a
 * language operation, not a system boundary.
 */
const LANGUAGE_BUILTIN_NAMES = new Set([
  // JavaScript/Node built-ins
  'console', 'path', 'fs', 'os', 'crypto', 'http', 'https', 'url', 'util',
  'stream', 'buffer', 'events', 'child_process', 'cluster', 'dgram', 'dns',
  'net', 'readline', 'repl', 'tls', 'tty', 'v8', 'vm', 'zlib', 'assert',
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Date', 'Math', 'JSON',
  'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol', 'Proxy', 'Reflect',
  'Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError',
  'RegExp', 'Function', 'Buffer', 'process', 'global', 'setTimeout',
  'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURI', 'decodeURI',
  'encodeURIComponent', 'decodeURIComponent', 'escape', 'unescape', 'eval',
  'Intl', 'Atomics', 'SharedArrayBuffer', 'ArrayBuffer', 'DataView',
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array',
  'BigUint64Array', 'BigInt', 'Infinity', 'NaN', 'undefined', 'null',
  // Rust standard library
  'std', 'core', 'alloc', 'Vec', 'HashMap', 'HashSet', 'BTreeMap', 'BTreeSet',
  'Option', 'Result', 'Box', 'Rc', 'Arc', 'Cell', 'RefCell', 'Mutex', 'RwLock',
  'Duration', 'Instant', 'SystemTime', 'Path', 'PathBuf', 'OsStr', 'OsString',
  'File', 'Read', 'Write', 'BufRead', 'BufReader', 'BufWriter',
  'TcpStream', 'TcpListener', 'UdpSocket', 'Command', 'Child', 'Stdio',
  'thread', 'sync', 'collections', 'io', 'env', 'fmt', 'str', 'slice', 'iter',
  'ops', 'cmp', 'convert', 'default', 'mem', 'ptr', 'num', 'time', 'ffi',
  'Cow', 'Deref', 'DerefMut', 'Drop', 'Clone', 'Copy', 'Debug', 'Display',
  'Default', 'PartialEq', 'Eq', 'PartialOrd', 'Ord', 'Hash', 'Iterator',
  'IntoIterator', 'FromIterator', 'Extend', 'From', 'Into', 'TryFrom', 'TryInto',
  'AsRef', 'AsMut', 'Send', 'Sync', 'Sized', 'Unpin', 'VecDeque', 'LinkedList',
  'BinaryHeap', 'Range', 'PhantomData', 'ManuallyDrop', 'MaybeUninit', 'NonNull',
  'Ordering', 'Reverse', 'format', 'println', 'print', 'eprintln', 'eprint',
  'dbg', 'todo', 'unimplemented', 'unreachable', 'assert', 'assert_eq', 'assert_ne',
  'vec', 'format_args', 'write', 'writeln', 'DefaultHasher', 'RandomState',
  'ErrorKind', 'Formatter', 'Arguments', 'Pin', 'Waker', 'Context', 'Poll',
  'Future', 'CStr', 'CString', 'ipaddr', 'RateLimiter',
  // Python modules that are pure in-process coordination for analysis purposes.
  'asyncio', 'logging',
  // .NET base class library
  'System', 'Console', 'Task', 'Thread', 'Timer', 'Directory',
  'MemoryStream', 'FileStream', 'DateTime', 'TimeSpan', 'Guid', 'Uri',
  'Regex', 'Enumerable',
  'File.Exists', 'String.IsNullOrEmpty', 'String.IsNullOrWhiteSpace',
  'Math.Abs', 'Math.Max', 'Math.Min',
]);

/**
 * PHP language builtins that are pure in-process operations. Calls to these
 * are language semantics, never an external interaction, so they must not
 * become exit points. Builtins that DO cross a process boundary (curl_*,
 * file_get_contents, mysqli_*, mail, exec, sockets) are intentionally absent.
 */
const PHP_PURE_BUILTIN_FUNCTIONS = new Set([
  'echo', 'print', 'printf', 'sprintf', 'vsprintf', 'die', 'exit',
  'isset', 'unset', 'empty', 'compact', 'extract', 'list',
  'count', 'sizeof', 'in_array', 'implode', 'explode', 'join', 'range',
  'json_encode', 'json_decode', 'serialize', 'unserialize',
  'intval', 'floatval', 'doubleval', 'strval', 'boolval', 'settype', 'gettype',
  'is_array', 'is_string', 'is_int', 'is_integer', 'is_numeric', 'is_float',
  'is_bool', 'is_null', 'is_object', 'is_callable', 'is_iterable', 'is_scalar',
  'abs', 'min', 'max', 'round', 'floor', 'ceil', 'pow', 'sqrt', 'rand',
  'mt_rand', 'random_int', 'intdiv', 'fmod', 'number_format',
  'trim', 'ltrim', 'rtrim', 'strtolower', 'strtoupper', 'ucfirst', 'ucwords',
  'lcfirst', 'strlen', 'strpos', 'strrpos', 'stripos', 'substr', 'strstr',
  'str_contains', 'str_starts_with', 'str_ends_with', 'strcmp', 'strcasecmp',
  'nl2br', 'htmlspecialchars', 'htmlentities', 'html_entity_decode',
  'strip_tags', 'addslashes', 'stripslashes', 'wordwrap', 'chunk_split',
  'str_pad', 'strrev', 'str_word_count', 'similar_text', 'levenshtein',
  'md5', 'sha1', 'hash', 'crc32', 'base64_encode', 'base64_decode',
  'urlencode', 'urldecode', 'rawurlencode', 'rawurldecode', 'http_build_query',
  'parse_url', 'parse_str', 'sort', 'rsort', 'asort', 'arsort', 'ksort',
  'krsort', 'usort', 'uasort', 'uksort', 'natsort', 'natcasesort', 'shuffle',
  'date', 'gmdate', 'mktime', 'gmmktime', 'strtotime', 'checkdate', 'time',
  'microtime', 'date_format', 'date_create', 'func_get_args', 'func_num_args',
  'call_user_func', 'call_user_func_array', 'get_class', 'get_object_vars',
  'get_class_methods', 'method_exists', 'property_exists', 'class_exists',
  'function_exists', 'defined', 'define', 'constant', 'spl_autoload_register',
  'iterator_to_array', 'array_walk', 'uniqid', 'var_dump', 'var_export',
  'print_r', 'preg_match', 'preg_match_all', 'preg_replace',
  'preg_replace_callback', 'preg_split', 'preg_quote', 'preg_grep',
  'include', 'require', 'include_once', 'require_once',
]);

/**
 * Module, package, keyword, and platform tokens that come from a language or
 * its source layout rather than the product domain. Capability and domain
 * naming must never seed a capability from these: "Fmt Management" or
 * "Lib Management" describe Rust stdlib and file layout, not system behavior.
 * Unlike LANGUAGE_BUILTIN_NAMES, entries here may legitimately cross process
 * boundaries (subprocess, urllib) because this set only guards domain naming,
 * never exit-point classification.
 */
const LANGUAGE_MODULE_TOKENS = new Set([
  // Rust keywords, source-layout module names, and plumbing crates whose
  // names surface in type/derive names (ClientClap, SerdeConfig)
  'lib', 'mod', 'main', 'impl', 'dyn', 'mut', 'pub', 'crate', 'crates', 'super',
  'trait', 'struct', 'enum', 'unsafe', 'async', 'await', 'match', 'loop',
  'ref', 'move', 'where', 'spawn', 'cfg', 'derive', 'macro', 'panic',
  'src', 'clap', 'serde', 'tokio',
  // Go standard library packages and source-layout names
  // ('runtime' and 'log' stay out: they are real product-domain nouns)
  'fmt', 'errors', 'strings', 'strconv', 'bytes', 'bufio', 'sort',
  'regexp', 'flag', 'encoding', 'xml', 'filepath', 'ioutil',
  'reflect', 'unicode', 'rand', 'atomic', 'func', 'chan',
  'pkg', 'cmd', 'internal', 'golang',
  // Python standard library modules
  'sys', 'itertools', 'functools', 'typing', 'datetime', 'pathlib',
  'subprocess', 'threading', 'asyncio', 'logging', 'random', 'abc',
  'dataclasses', 'contextlib', 'argparse', 'shutil', 'tempfile', 'glob',
  'hashlib', 'hmac', 'uuid', 'urllib', 'inspect', 'traceback', 'warnings',
  'weakref', 'queue', 'heapq', 'bisect', 'pickle', 'textwrap', 'codecs',
  'dict', 'list', 'tuple',
  // Platform module names used for OS-specific source files
  'linux', 'windows', 'macos', 'darwin', 'unix', 'posix', 'win32', 'android',
  'native',
  // Language/runtime labels emitted by polyglot paths, namespaces, and build
  // metadata. They describe an implementation surface, never the product.
  'javascript', 'typescript', 'nodejs', 'python', 'java', 'kotlin', 'scala',
  'dotnet', 'csharp', 'fsharp', 'rust', 'ruby', 'php', 'dart', 'flutter',
  'swift', 'objectivec', 'terraform', 'powershell',
]);

/**
 * Lowercase builtin names that double as common product-domain nouns. A todo
 * app's "Todo Management" or a trading platform's "Crypto Management" must
 * survive even though `todo!` is a Rust macro and `crypto` is a Node module.
 */
const DOMAIN_NOUN_EXCEPTIONS = new Set([
  'todo', 'crypto', 'stream', 'events', 'cluster', 'dns', 'tls',
]);

const LOWERCASE_BUILTIN_DOMAIN_TOKENS = (() => {
  const tokens = new Set<string>(LANGUAGE_MODULE_TOKENS);
  for (const name of LANGUAGE_BUILTIN_NAMES) {
    if (name === name.toLowerCase() && !name.includes('.')) {
      tokens.add(name);
    }
  }
  for (const exception of DOMAIN_NOUN_EXCEPTIONS) {
    tokens.delete(exception);
  }
  return tokens;
})();

/**
 * Qualifier and hedge words that describe certainty, age, or grab-bag grouping
 * rather than product behavior. A capability named "Likely Management" or
 * "Misc Management" carries no domain meaning, so these can never seed a
 * capability or domain name.
 */
const QUALIFIER_DOMAIN_TOKENS = new Set([
  'likely', 'unlikely', 'maybe', 'probably', 'possibly', 'perhaps',
  'unknown', 'misc', 'miscellaneous', 'temp', 'tmp', 'temporary',
  'new', 'old', 'common', 'util', 'utils', 'other', 'others', 'various',
]);

/**
 * CSS/DOM state adjectives that surface in theme and frontend code (class
 * toggles, pseudo-state handlers, layout helpers). A storefront theme's
 * "Inner Management", "Active Management", or "Predictive Management" is a
 * UI state token, not a product capability, so these can never seed a
 * capability or domain name. Real product nouns ("cart", "checkout",
 * "product") are unaffected because filtering is per-token: "Active
 * Directory" still seeds from "directory".
 */
const UI_STATE_DOMAIN_TOKENS = new Set([
  'inner', 'outer', 'active', 'inactive', 'connected', 'disconnected',
  'predictive', 'hover', 'hovered', 'hovering', 'focused', 'focusable',
  'selected', 'unselected', 'expanded', 'collapsed', 'hidden', 'visible',
  'sticky', 'disabled', 'enabled', 'checked', 'unchecked', 'dragging',
  'draggable', 'scrollable', 'clicked', 'pressed', 'highlighted',
]);

/**
 * Serialization/encoding plumbing verbs. When serde/marshalling helpers are
 * the most connected terminal nodes (common in Rust and Go service plumbing),
 * they produce capabilities like "Deserialize Management" or "Serialize
 * Management" that describe wire-format mechanics, not system behavior.
 * Domain nouns that merely contain these stems ("token", "encoder ring"
 * products) are unaffected because matching is exact-token.
 */
const SERIALIZATION_PLUMBING_TOKENS = new Set([
  'serialize', 'serializes', 'serialized', 'serializing', 'serialization',
  'deserialize', 'deserializes', 'deserialized', 'deserializing', 'deserialization',
  'encode', 'encodes', 'encoded', 'decode', 'decodes', 'decoded',
  'marshal', 'marshals', 'marshalled', 'marshaled', 'unmarshal', 'unmarshals',
  'unmarshalled', 'unmarshaled',
]);

/**
 * Vendor/infrastructure library names that show up as terminal nodes when a
 * codebase wraps an SDK (Jito block-engine clients, Borsh codecs). Unlike
 * LANGUAGE_MODULE_TOKENS these are not filtered unconditionally: a vendor
 * token may legitimately name a capability when the surrounding group shows
 * product evidence (entities or multiple operations). Capability building
 * consults isVendorLibDomainToken only for the evidence-free
 * "<Label> Capability" fallback.
 */
const VENDOR_LIB_DOMAIN_TOKENS = new Set([
  'jito', 'borsh',
]);

/**
 * True when a lowercased domain/capability token names a vendor or
 * infrastructure library (jito, borsh) rather than a product concept.
 * Callers should only suppress these when the capability has no product
 * evidence; see VENDOR_LIB_DOMAIN_TOKENS.
 */
export function isVendorLibDomainToken(token: string | undefined): boolean {
  if (!token) return false;
  return VENDOR_LIB_DOMAIN_TOKENS.has(token.trim().toLowerCase());
}

/**
 * Digit-led tokens that name real technology rather than numeric noise.
 * These survive the numeric-token rejection below.
 */
const DIGIT_LED_TECHNOLOGY_TOKENS = new Set([
  '2fa', '3ds', '5g', 'i18n', 'a11y',
]);

/**
 * True when a lowercased domain/capability token is numeric noise (an IP
 * octet like "172", a port, a version fragment) or a qualifier word. Pure
 * digits and digit-led tokens are rejected unless they name a real
 * technology ("2fa", "3ds"); qualifier words ("likely", "misc", "temp") are
 * always rejected. Capability clustering applies this alongside
 * isLanguageBuiltinDomainToken so junk tokens never seed capability names.
 */
export function isCapabilityNoiseToken(token: string | undefined): boolean {
  if (!token) return false;
  const normalized = token.trim().toLowerCase();
  if (!normalized) return false;
  if (QUALIFIER_DOMAIN_TOKENS.has(normalized)) return true;
  if (UI_STATE_DOMAIN_TOKENS.has(normalized)) return true;
  if (SERIALIZATION_PLUMBING_TOKENS.has(normalized)) return true;
  if (/^[0-9]/.test(normalized)) {
    return !DIGIT_LED_TECHNOLOGY_TOKENS.has(normalized);
  }
  return false;
}

/**
 * True when a lowercased domain/capability token originates from a language
 * runtime, standard library module, keyword, or source-layout convention
 * (fmt, lib, mod, vec, asyncio, strconv) instead of the product domain.
 * Capability clustering uses this so stdlib names never seed capability
 * names in any language. Intentionally skips capitalized-only builtins such
 * as Task, File, and Command whose lowercase forms are ordinary domain nouns.
 */
export function isLanguageBuiltinDomainToken(token: string | undefined): boolean {
  if (!token) return false;
  return LOWERCASE_BUILTIN_DOMAIN_TOKENS.has(token.trim().toLowerCase());
}

const PHP_BUILTIN_PREFIXES = /^(array_|str_|mb_|ctype_|filter_)/;

export function isPhpPureBuiltinFunction(name: string): boolean {
  const normalized = name.trim();
  return PHP_PURE_BUILTIN_FUNCTIONS.has(normalized) || PHP_BUILTIN_PREFIXES.test(normalized);
}

export function isLanguageBuiltinName(name: string | undefined): boolean {
  if (!name) return false;
  const normalized = name.trim();
  return LANGUAGE_BUILTIN_NAMES.has(normalized) || isPhpPureBuiltinFunction(normalized);
}

const EXTERNAL_CALL_LABEL = /^(external call|linq operation):\s*/i;

/**
 * True when an exit point's target resolves to a language/stdlib builtin
 * instead of an external system. Handles raw targets ("array_filter", "io"),
 * labeled names ("External call: array_filter"), and class-qualified calls
 * ("External call: Math::abs").
 */
export function isLanguageBuiltinExitPoint(
  exitPoint: Pick<CASExitPoint, 'name' | 'target'>
): boolean {
  const candidates: string[] = [];
  if (exitPoint.target?.sdk) candidates.push(exitPoint.target.sdk);
  if (exitPoint.name) {
    const stripped = exitPoint.name.replace(EXTERNAL_CALL_LABEL, '').trim();
    candidates.push(stripped);
    const classPart = stripped.split('::')[0]?.trim();
    if (classPart && classPart !== stripped) candidates.push(classPart);
  }
  return candidates.some(candidate => isLanguageBuiltinName(candidate));
}

export function languageBuiltinNames(): ReadonlySet<string> {
  return LANGUAGE_BUILTIN_NAMES;
}
