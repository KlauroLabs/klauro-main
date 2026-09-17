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
    ("kotlin", &["also", "apply", "arrayOf", "check", "emptyList", "error", "let", "listOf",
        "mapOf", "print", "println", "require", "run", "setOf", "takeIf", "to", "with"]),
    ("php", &["array_filter", "array_keys", "array_map", "array_merge", "array_values", "count",
        "die", "empty", "implode", "in_array", "isset", "json_decode", "json_encode", "sprintf",
        "str_replace", "strlen", "strpos", "trim", "unset"]),
    ("python", &["abs", "all", "any", "bool", "bytes", "dict", "enumerate", "filter", "float",
        "format", "getattr", "hasattr", "id", "int", "isinstance", "issubclass", "iter", "len",
        "list", "map", "max", "min", "next", "open", "print", "range", "repr", "reversed",
        "round", "set", "setattr", "sorted", "str", "sum", "super", "tuple", "type", "zip"]),
    ("r", &["c", "cat", "length", "list", "names", "nchar", "paste", "paste0", "print",
        "rep", "seq", "sprintf", "stop", "vapply", "warning"]),
    ("ruby", &["block_given?", "freeze", "lambda", "loop", "proc", "puts", "raise", "require",
        "require_relative", "send", "sleep", "throw"]),
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
