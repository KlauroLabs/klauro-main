import type { CASExitPoint } from '../../types/cas.types';

const GO_STANDARD_PACKAGE_ROOTS = new Set([
  'bufio', 'bytes', 'context', 'crypto', 'encoding', 'errors', 'fmt', 'io',
  'log', 'math', 'net', 'os', 'path', 'filepath', 'reflect', 'regexp',
  'runtime', 'sort', 'strconv', 'strings', 'sync', 'time', 'unicode',
]);







const LANGUAGE_BUILTIN_NAMES = new Set([

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

  'asyncio', 'logging',

  'System', 'Console', 'Task', 'Thread', 'Timer', 'Directory',
  'MemoryStream', 'FileStream', 'DateTime', 'TimeSpan', 'Guid', 'Uri',
  'Regex', 'Enumerable',
  'File.Exists', 'String.IsNullOrEmpty', 'String.IsNullOrWhiteSpace',
  'Math.Abs', 'Math.Max', 'Math.Min',
]);







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










const LANGUAGE_MODULE_TOKENS = new Set([


  'lib', 'mod', 'main', 'impl', 'dyn', 'mut', 'pub', 'crate', 'crates', 'super',
  'trait', 'struct', 'enum', 'unsafe', 'async', 'await', 'match', 'loop',
  'ref', 'move', 'where', 'spawn', 'cfg', 'derive', 'macro', 'panic',
  'src', 'clap', 'serde', 'tokio',


  'fmt', 'errors', 'strings', 'strconv', 'bytes', 'bufio', 'sort',
  'regexp', 'flag', 'encoding', 'xml', 'filepath', 'ioutil',
  'reflect', 'unicode', 'rand', 'atomic', 'func', 'chan',
  'pkg', 'cmd', 'internal', 'golang',

  'sys', 'itertools', 'functools', 'typing', 'datetime', 'pathlib',
  'subprocess', 'threading', 'asyncio', 'logging', 'random', 'abc',
  'dataclasses', 'contextlib', 'argparse', 'shutil', 'tempfile', 'glob',
  'hashlib', 'hmac', 'uuid', 'urllib', 'inspect', 'traceback', 'warnings',
  'weakref', 'queue', 'heapq', 'bisect', 'pickle', 'textwrap', 'codecs',
  'dict', 'list', 'tuple',

  'linux', 'windows', 'macos', 'darwin', 'unix', 'posix', 'win32', 'android',
  'native',


  'javascript', 'typescript', 'nodejs', 'python', 'java', 'kotlin', 'scala',
  'dotnet', 'csharp', 'fsharp', 'rust', 'ruby', 'php', 'dart', 'flutter',
  'swift', 'objectivec', 'terraform', 'powershell',
]);






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







const QUALIFIER_DOMAIN_TOKENS = new Set([
  'likely', 'unlikely', 'maybe', 'probably', 'possibly', 'perhaps',
  'unknown', 'misc', 'miscellaneous', 'temp', 'tmp', 'temporary',
  'new', 'old', 'common', 'util', 'utils', 'other', 'others', 'various',
]);










const UI_STATE_DOMAIN_TOKENS = new Set([
  'inner', 'outer', 'active', 'inactive', 'connected', 'disconnected',
  'predictive', 'hover', 'hovered', 'hovering', 'focused', 'focusable',
  'selected', 'unselected', 'expanded', 'collapsed', 'hidden', 'visible',
  'sticky', 'disabled', 'enabled', 'checked', 'unchecked', 'dragging',
  'draggable', 'scrollable', 'clicked', 'pressed', 'highlighted',
]);









const SERIALIZATION_PLUMBING_TOKENS = new Set([
  'serialize', 'serializes', 'serialized', 'serializing', 'serialization',
  'deserialize', 'deserializes', 'deserialized', 'deserializing', 'deserialization',
  'encode', 'encodes', 'encoded', 'decode', 'decodes', 'decoded',
  'marshal', 'marshals', 'marshalled', 'marshaled', 'unmarshal', 'unmarshals',
  'unmarshalled', 'unmarshaled',
]);










const VENDOR_LIB_DOMAIN_TOKENS = new Set([
  'jito', 'borsh',
]);







export function isVendorLibDomainToken(token: string | undefined): boolean {
  if (!token) return false;
  return VENDOR_LIB_DOMAIN_TOKENS.has(token.trim().toLowerCase());
}





const DIGIT_LED_TECHNOLOGY_TOKENS = new Set([
  '2fa', '3ds', '5g', 'i18n', 'a11y',
]);









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
  return candidates.some(candidate => {
    if (isLanguageBuiltinName(candidate)) return true;
    const qualifiedRoot = candidate.split(/[.:]/)[0]?.trim();
    return Boolean(qualifiedRoot && GO_STANDARD_PACKAGE_ROOTS.has(qualifiedRoot));
  });
}

export function languageBuiltinNames(): ReadonlySet<string> {
  return LANGUAGE_BUILTIN_NAMES;
}
