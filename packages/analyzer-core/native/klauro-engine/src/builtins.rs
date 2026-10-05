static BUILTINS: &[(&str, &[&str])] = &[
    ("c", &["abs", "calloc", "exit", "fprintf", "free", "malloc", "memcmp", "memcpy", "memset",
        "printf", "realloc", "sizeof", "snprintf", "sprintf", "strcmp", "strcpy", "strlen"]),
    ("cpp", &["make_shared", "make_unique", "move", "sizeof", "static_cast", "swap"]),
    ("csharp", &["nameof", "sizeof", "typeof"]),
    ("dart", &["assert", "identical", "print"]),
    ("elixir", &["inspect", "is_atom", "is_binary", "is_list", "is_map", "is_nil", "length",
        "raise", "throw", "to_string"]),
    ("go", &["append", "cap", "close", "complex", "copy", "delete", "len", "make", "new",
        "panic", "print", "println", "recover"]),
    ("java", &["requireNonNull"]),
    ("javascript", &["decodeURIComponent", "encodeURIComponent", "eval", "isNaN", "parseFloat",
        "parseInt", "require", "structuredClone"]),
    ("kotlin", &["all", "also", "any", "apply", "arrayOf", "asFlow", "asSequence", "associate",
        "associateBy", "associateWith", "buildList", "buildMap", "buildString", "check",
        "checkNotNull", "chunked", "coerceAtLeast", "coerceAtMost", "coerceIn", "contains", "copy",
        "count", "distinct", "distinctBy", "drop", "dropLast", "emptyList", "emptyMap", "emptySet",
        "endsWith", "error", "filter", "filterIsInstance", "filterNot", "filterNotNull", "find",
        "first", "firstOrNull", "flatMap", "flatten", "fold", "forEach", "getOrElse", "getOrNull",
        "groupBy", "indexOf", "isEmpty", "isNotEmpty", "isNullOrBlank", "isNullOrEmpty",
        "joinToString", "last", "lastOrNull", "lazy", "let", "listOf", "lowercase", "map",
        "mapIndexed", "mapNotNull", "mapOf", "maxByOrNull", "maxOf", "minByOrNull", "minOf",
        "minus", "mutableListOf", "mutableMapOf", "mutableSetOf", "none", "onEach", "orEmpty",
        "padEnd", "padStart", "plus", "print", "println", "reduce", "repeat", "replace", "require",
        "requireNotNull", "reversed", "run", "setOf", "sortedBy", "sortedByDescending", "split",
        "startsWith", "substring", "sumOf", "take", "takeIf", "takeLast", "takeUnless", "to",
        "toBoolean", "toDouble", "toFloat", "toInt", "toList", "toLong", "toMap", "toMutableList",
        "toSet", "toString", "toTypedArray", "trim", "uppercase", "use", "with", "withIndex",
        "zip"]),
    ("php", &["array_filter", "array_keys", "array_map", "array_merge", "array_values", "count",
        "die", "empty", "implode", "in_array", "isset", "json_decode", "json_encode", "sprintf",
        "str_replace", "strlen", "strpos", "trim", "unset"]),
    ("python", &["abs", "all", "any", "bool", "bytes", "dict", "enumerate", "filter", "float",
        "format", "getattr", "hasattr", "id", "int", "isinstance", "issubclass", "iter", "len",
        "list", "map", "max", "min", "next", "open", "print", "range", "repr", "reversed",
        "round", "set", "setattr", "sorted", "str", "sum", "super", "tuple", "type", "zip"]),
    ("r", &["c", "cat", "length", "list", "names", "nchar", "paste", "paste0", "print",
        "rep", "seq", "sprintf", "stop", "vapply", "warning"]),
    ("ruby", &[
        "Array", "Float", "Hash", "Integer", "Rational", "String", "abort", "at_exit",
        "attr_accessor", "attr_reader", "attr_writer", "binding", "block_given?", "caller",
        "catch", "define_method", "exit", "extend", "fail", "format", "freeze", "gets", "include",
        "instance_of?", "instance_variable_get", "instance_variable_set", "is_a?", "itself",
        "kind_of?", "lambda", "loop", "method", "object_id", "p", "pp", "prepend", "print",
        "private", "proc", "protected", "public", "public_send", "puts", "raise", "rand",
        "require", "require_relative", "respond_to?", "ruby", "send", "sleep", "sprintf", "srand",
        "tap", "then", "throw", "warn", "yield_self",
    ]),
    ("rust", &["Err", "None", "Ok", "Some", "assert", "assert_eq", "drop", "format", "matches",
        "panic", "print", "println", "vec", "write", "writeln"]),
    ("scala", &["println", "require"]),
    ("swift", &["assert", "fatalError", "max", "min", "precondition", "print", "type"]),
    ("typescript", &["decodeURIComponent", "encodeURIComponent", "eval", "isNaN", "parseFloat",
        "parseInt", "require", "structuredClone"]),
];

pub fn is_builtin(language: &str, name: &str) -> bool {
    BUILTINS
        .iter()
        .find(|(id, _)| *id == language)
        .is_some_and(|(_, names)| names.binary_search(&name).is_ok())
}

static MEMBERS: &[(&str, &[&str])] = &[
    ("csharp", &[
        "Add", "Any", "Append", "Clear", "Close", "Contains", "ContainsKey", "Count", "Dispose",
        "Distinct", "EndsWith", "Equals", "First", "FirstOrDefault", "GetHashCode", "GetType",
        "GroupBy", "Join", "Length", "Max", "Min", "OrderBy", "OrderByDescending", "Remove",
        "Select", "Single", "SingleOrDefault", "Skip", "Split", "StartsWith", "Substring", "Sum",
        "Take", "ThenBy", "ToArray", "ToDictionary", "ToList", "ToString", "Trim", "TryGetValue",
        "Where",
    ]),
    ("go", &[
        "Add", "Close", "Copy", "Done", "Error", "Errorf", "Fatal", "Fatalf", "Get", "Lock", "Log",
        "Logf", "New", "Print", "Printf", "Println", "Read", "Reset", "Set", "Sprintf", "String",
        "Unlock", "Wait", "Write",
    ]),
    ("java", &[
        "add", "append", "charAt", "clear", "close", "collect", "contains", "containsKey",
        "equals", "filter", "forEach", "get", "getClass", "hashCode", "indexOf", "isEmpty",
        "iterator", "length", "map", "orElse", "put", "remove", "set", "size", "stream",
        "toString", "trim", "valueOf",
    ]),
    ("javascript", &[
        "abort", "add", "addEventListener", "addListener", "address", "after", "all", "any",
        "append", "appendChild", "apply", "arrayBuffer", "assign", "at", "before", "bind", "blob",
        "blur", "call", "catch", "charAt", "clear", "click", "cloneNode", "close", "closest",
        "complete", "concat", "connect", "constructor", "current", "debug", "delete", "destroy",
        "disconnect", "dispatchEvent", "emit", "end", "entries", "error", "every",
        "exitFullscreen", "fill", "filter", "finally", "find", "findIndex", "flat", "flatMap",
        "focus", "forEach", "formData", "formatMessage", "from", "get", "getAttribute",
        "getElementById", "getItem", "has", "includes", "indexOf", "info", "insertBefore",
        "isArray", "javascript", "join", "json", "keys", "lastIndexOf", "listen", "log", "map",
        "match", "max", "min", "next", "now", "off", "on", "once", "open", "parse", "pause",
        "pipe", "play", "pop", "prepend", "preventDefault", "push", "query", "querySelector",
        "querySelectorAll", "quit", "race", "reduce", "reduceRight", "ref", "reject", "release",
        "remove", "removeAttribute", "removeChild", "removeEventListener", "removeItem",
        "removeListener", "replace", "replaceWith", "requestFullscreen", "resolve", "reverse",
        "round", "select", "send", "set", "setAttribute", "setItem", "shift", "slice", "some",
        "sort", "splice", "split", "start", "status", "stopPropagation", "stringify", "submit",
        "subscribe", "tap", "test", "text", "then", "toFixed", "toString", "toggle", "trace",
        "trim", "unref", "unshift", "unsubscribe", "values", "warn", "write",
    ]),
    ("php", &[
        "add", "all", "count", "each", "filter", "first", "get", "has", "join", "last", "map",
        "remove", "set", "sort",
    ]),
    ("python", &[
        "add", "append", "clear", "close", "copy", "count", "decode", "encode", "endswith",
        "extend", "find", "format", "get", "index", "insert", "items", "join", "keys", "lower",
        "lstrip", "pop", "popitem", "read", "readline", "readlines", "remove", "replace",
        "reverse", "rstrip", "seek", "setdefault", "sort", "split", "splitlines", "startswith",
        "strip", "tell", "title", "update", "upper", "values", "write", "writelines",
    ]),
    ("ruby", &[
        "add", "all?", "any?", "as_json", "attributes", "backtrace", "blank?", "body", "build",
        "cache_key", "changed?", "changes", "clear", "clone", "code", "compact", "connection",
        "count", "create", "create!", "created_at", "debug", "delete", "delete_all", "destroy",
        "destroy!", "destroy_all", "destroyed?", "detect", "dig", "dup", "each", "each_pair",
        "each_slice", "each_with_index", "each_with_object", "empty?", "error", "errors", "except",
        "exists?", "fetch", "filter_map", "find", "find_by", "find_each", "find_or_create_by",
        "first", "flat_map", "flatten", "freeze", "get", "group_by", "gsub", "headers", "id",
        "import!", "in_batches", "include?", "includes", "info", "inject", "ip", "join", "joins",
        "key?", "keys", "last", "length", "limit", "many?", "map", "max", "max_by", "merge",
        "merge!", "message", "min", "min_by", "new", "new_record?", "nil?", "none", "none?",
        "one?", "open", "order", "partition", "path", "persisted?", "pluck", "pop", "post",
        "presence", "present?", "publish", "push", "reduce", "reject", "reload", "reverse", "ruby",
        "sample", "save", "save!", "select", "set", "shift", "size", "slice", "sort", "sort_by",
        "split", "start", "status", "strip", "sub", "sum", "take", "tally", "to_a", "to_h", "to_i",
        "to_json", "to_param", "to_query", "to_s", "to_sym", "touch", "truncate", "try", "uniq",
        "unshift", "update", "update!", "update_all", "updated_at", "valid?", "values", "warn",
        "where", "with_lock", "zip",
    ]),
    ("rust", &[
        "add", "all", "any", "append", "arg", "args", "as_bytes", "as_deref", "as_mut", "as_ref",
        "as_slice", "as_str", "borrow", "borrow_mut", "bytes", "canonicalize", "capacity", "chain",
        "char_indices", "chars", "chunks", "clear", "clone", "cloned", "cmp", "collect", "concat",
        "contains", "contains_key", "copied", "count", "create", "create_dir_all", "cycle",
        "debug_list", "debug_struct", "debug_tuple", "dedup", "default", "display", "div", "drain",
        "ends_with", "entries", "entry", "enumerate", "env", "eq", "exists", "expect", "extend",
        "extend_from_slice", "extension", "field", "file_name", "filter", "filter_map", "find",
        "finish", "first", "first_mut", "flat_map", "flatten", "flush", "fmt", "fold", "for_each",
        "from", "from_str", "get", "get_mut", "get_or_insert_with", "hash", "insert", "into",
        "into_iter", "is_dir", "is_empty", "is_err", "is_file", "is_none", "is_ok", "is_some",
        "iter", "iter_mut", "join", "keys", "kind", "last", "last_mut", "len", "lines", "lock",
        "map", "map_err", "matches", "max", "max_by", "max_by_key", "metadata", "min", "min_by",
        "min_by_key", "mul", "ne", "neg", "new", "next", "not", "ok", "ok_or", "ok_or_else",
        "open", "or_default", "or_insert", "or_insert_with", "output", "parent", "parse",
        "partial_cmp", "peekable", "pop", "position", "product", "push", "push_str", "read",
        "read_dir", "read_to_string", "remove", "repeat", "replace", "reserve", "resize", "retain",
        "rev", "reverse", "rfind", "rposition", "rsplit", "skip", "skip_while", "sort", "sort_by",
        "sort_by_key", "spawn", "split", "split_at", "split_off", "splitn", "starts_with",
        "status", "stderr", "stdin", "stdout", "step_by", "strip_prefix", "strip_suffix", "sub",
        "sum", "swap", "take", "take_while", "to_lowercase", "to_owned", "to_path_buf",
        "to_string", "to_uppercase", "to_vec", "trim", "trim_end", "trim_start", "truncate",
        "try_from", "try_into", "unwrap", "unwrap_or", "unwrap_or_default", "unwrap_or_else",
        "values", "windows", "with_capacity", "write", "write_all", "zip",
    ]),
    ("typescript", &[
        "abort", "add", "addEventListener", "addListener", "address", "after", "all", "any",
        "append", "appendChild", "apply", "arrayBuffer", "assign", "at", "before", "bind", "blob",
        "blur", "call", "catch", "charAt", "clear", "click", "cloneNode", "close", "closest",
        "complete", "concat", "connect", "constructor", "current", "debug", "delete", "destroy",
        "disconnect", "dispatchEvent", "emit", "end", "entries", "error", "every",
        "exitFullscreen", "fill", "filter", "finally", "find", "findIndex", "flat", "flatMap",
        "focus", "forEach", "formData", "formatMessage", "from", "get", "getAttribute",
        "getElementById", "getItem", "has", "includes", "indexOf", "info", "insertBefore",
        "isArray", "join", "json", "keys", "lastIndexOf", "listen", "log", "map", "match", "max",
        "min", "next", "now", "off", "on", "once", "open", "parse", "pause", "pipe", "play", "pop",
        "prepend", "preventDefault", "push", "query", "querySelector", "querySelectorAll", "quit",
        "race", "reduce", "reduceRight", "ref", "reject", "release", "remove", "removeAttribute",
        "removeChild", "removeEventListener", "removeItem", "removeListener", "replace",
        "replaceWith", "requestFullscreen", "resolve", "reverse", "round", "select", "send", "set",
        "setAttribute", "setItem", "shift", "slice", "some", "sort", "splice", "split", "start",
        "status", "stopPropagation", "stringify", "submit", "subscribe", "tap", "test", "text",
        "then", "toFixed", "toString", "toggle", "trace", "trim", "typescript", "unref", "unshift",
        "unsubscribe", "values", "warn", "write",
    ]),
];

pub fn is_standard_member(language: &str, name: &str) -> bool {
    MEMBERS
        .iter()
        .find(|(id, _)| *id == language)
        .is_some_and(|(_, names)| names.binary_search(&name).is_ok())
}

#[cfg(test)]
mod standard {
    use super::{BUILTINS, MEMBERS};

    #[test]
    fn every_table_is_sorted_so_it_can_be_searched() {
        for (language, names) in BUILTINS.iter().chain(MEMBERS.iter()) {
            assert!(names.windows(2).all(|pair| pair[0] < pair[1]), "{language}");
        }
    }
}
