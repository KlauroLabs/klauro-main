pub static RUNTIME_GLOBALS: &[&str] = &[
    "Array", "ArrayBuffer", "Atomics", "BigInt", "BigInt64Array", "BigUint64Array",
    "Boolean", "DataView", "Date", "Error", "EvalError", "FinalizationRegistry",
    "Float32Array", "Float64Array", "Function", "Infinity", "Int16Array", "Int32Array",
    "Int8Array", "Intl", "JSON", "Map", "Math", "NaN", "Number", "Object", "Promise",
    "Proxy", "RangeError", "ReferenceError", "Reflect", "RegExp", "Set", "SharedArrayBuffer",
    "String", "Symbol", "SyntaxError", "TypeError", "URIError", "Uint16Array", "Uint32Array",
    "Uint8Array", "Uint8ClampedArray", "WeakMap", "WeakRef", "WeakSet", "decodeURI",
    "decodeURIComponent", "encodeURI", "encodeURIComponent", "escape", "eval", "globalThis",
    "isFinite", "isNaN", "parseFloat", "parseInt", "unescape",
    "AbortController", "AbortSignal", "Blob", "BroadcastChannel", "Buffer", "ByteLengthQueuingStrategy",
    "CompressionStream", "CountQueuingStrategy", "Crypto", "CryptoKey", "CustomEvent",
    "DecompressionStream", "Event", "EventSource", "EventTarget", "FormData", "Headers",
    "MessageChannel", "MessageEvent", "MessagePort", "PerformanceEntry", "PerformanceObserver",
    "ReadableStream", "Request", "Response", "SubtleCrypto", "TextDecoder", "TextEncoder",
    "TransformStream", "URL", "URLSearchParams", "WebAssembly", "WebSocket", "WritableStream",
    "atob", "btoa", "clearImmediate", "clearInterval", "clearTimeout", "console", "crypto",
    "fetch", "performance", "process", "queueMicrotask", "setImmediate", "setInterval",
    "setTimeout", "structuredClone",
    "Awaited", "Capitalize", "ConstructorParameters", "Disposable", "Exclude",
    "Extract", "InstanceType", "Iterable", "IterableIterator", "Iterator", "Lowercase",
    "NonNullable", "OmitThisParameter", "Omit", "Parameters", "Partial", "Pick", "Readonly",
    "ReadonlyArray", "ReadonlyMap", "ReadonlySet", "Record", "Required", "ReturnType",
    "ThisParameterType", "ThisType", "Uncapitalize", "Uppercase", "AsyncDisposable",
    "AsyncGenerator", "AsyncIterable", "AsyncIterableIterator", "AsyncIterator", "Generator",
    "PromiseLike", "ArrayLike", "NodeJS",
    "document", "window", "navigator", "localStorage", "sessionStorage", "location",
    "history", "alert", "confirm", "prompt", "requestAnimationFrame", "cancelAnimationFrame",
];

pub fn is_runtime_global(name: &str) -> bool {
    RUNTIME_GLOBALS.binary_search(&name).is_ok()
}

pub fn sorted_runtime_globals() -> Vec<&'static str> {
    let mut sorted = RUNTIME_GLOBALS.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    sorted
}
