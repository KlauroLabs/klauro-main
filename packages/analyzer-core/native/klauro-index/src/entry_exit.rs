use std::collections::HashMap;

use serde::Serialize;

use crate::model::*;

#[derive(Debug, Serialize)]
pub struct EntryPoint {
    pub id: String,
    pub kind: &'static str,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub handler: String,
    pub file: u32,
    pub line: u32,
    pub registrar: String,
}

#[derive(Debug, Serialize)]
pub struct ExitPoint {
    pub id: String,
    pub kind: &'static str,
    pub name: String,
    pub source: String,
    pub target: String,
    pub operation: String,
    pub file: u32,
    pub line: u32,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub awaited: bool,
}

static HTTP_METHODS: &[&str] = &[
    "all", "delete", "get", "head", "options", "patch", "post", "put",
];

static EVENT_REGISTRARS: &[&str] = &["addEventListener", "on", "once", "prependListener"];
static TEST_REGISTRARS: &[&str] = &["bench", "describe", "it", "suite", "test"];
static SCHEDULE_REGISTRARS: &[&str] = &["cron", "schedule", "setInterval", "setTimeout"];
static MESSAGE_REGISTRARS: &[&str] = &["consume", "process", "subscribe", "worker"];
static COMMAND_REGISTRARS: &[&str] = &["action", "command", "handler"];
static IPC_REGISTRARS: &[&str] = &["handle", "handleOnce", "invoke"];

fn tail(registrar: &str) -> &str {
    match registrar.rfind('.') {
        Some(at) => &registrar[at + 1..],
        None => registrar,
    }
}

fn looks_like_path(label: &str) -> bool {
    label.starts_with('/') || label.starts_with("./") || label.contains("/:")
}

fn classify_registration(registrar: &str, label: Option<&str>) -> Option<&'static str> {
    let verb = tail(registrar);
    if HTTP_METHODS.binary_search(&verb).is_ok() {
        return match label {
            Some(label) if looks_like_path(label) => Some("http"),
            _ => None,
        };
    }
    if verb == "use" && label.is_some_and(looks_like_path) {
        return Some("http");
    }
    if TEST_REGISTRARS.binary_search(&verb).is_ok() {
        return Some("test");
    }
    if SCHEDULE_REGISTRARS.binary_search(&verb).is_ok() {
        return Some("schedule");
    }
    if EVENT_REGISTRARS.binary_search(&verb).is_ok() {
        return Some("event");
    }
    if MESSAGE_REGISTRARS.binary_search(&verb).is_ok() {
        return Some("message");
    }
    if IPC_REGISTRARS.binary_search(&verb).is_ok() {
        return Some("ipc");
    }
    if COMMAND_REGISTRARS.binary_search(&verb).is_ok() {
        return Some("cli");
    }
    None
}

fn decorator_entry(decorator: &Decorator) -> Option<(&'static str, String, Option<String>)> {
    let name = decorator.name.rsplit('.').next().unwrap_or(&decorator.name);
    let lowered = name.to_ascii_lowercase();
    if HTTP_METHODS.binary_search(&lowered.as_str()).is_ok() {
        let path = decorator
            .arguments
            .iter()
            .find(|argument| argument.literal)
            .map(|argument| argument.value.clone());
        return Some(("http", lowered.to_ascii_uppercase(), path));
    }
    match lowered.as_str() {
        "eventpattern" | "onevent" | "subscribe" => Some(("event", lowered, None)),
        "messagepattern" => Some(("message", lowered, None)),
        "cron" | "interval" | "timeout" => Some(("schedule", lowered, None)),
        "query" | "mutation" | "subscription" | "resolvefield" => {
            Some(("graphql", lowered, None))
        }
        "grpcmethod" | "grpcstreammethod" => Some(("rpc", lowered, None)),
        _ => None,
    }
}

static FILE_OPERATIONS: &[&str] = &[
    "appendFile", "copyFile", "createReadStream", "createWriteStream", "mkdir", "open",
    "readFile", "readdir", "rename", "rm", "rmdir", "stat", "unlink", "writeFile",
];
static NETWORK_OPERATIONS: &[&str] = &[
    "connect", "delete", "fetch", "get", "head", "patch", "post", "put", "request", "send",
];
static DATABASE_OPERATIONS: &[&str] = &[
    "aggregate", "deleteMany", "deleteOne", "execute", "findMany", "findOne", "insertMany",
    "insertOne", "query", "transaction", "updateMany", "updateOne", "upsert",
];
static MESSAGE_OPERATIONS: &[&str] = &["broadcast", "emit", "produce", "publish", "sendMessage"];
static CACHE_OPERATIONS: &[&str] = &["del", "expire", "getex", "hget", "hset", "setex", "ttl"];

static CLIENT_STORAGE_GLOBALS: &[&str] = &["localStorage", "sessionStorage"];
static IO_GLOBALS: &[&str] = &["fetch", "localStorage", "process", "sessionStorage"];

fn classify_exit(binding: &str, origin: &str, member: &str) -> Option<&'static str> {
    let operation = tail(member);
    if CLIENT_STORAGE_GLOBALS.binary_search(&binding).is_ok() {
        return Some("client_storage");
    }
    if origin.contains("fs") && FILE_OPERATIONS.binary_search(&operation).is_ok() {
        return Some("file");
    }
    if is_network_origin(origin) && NETWORK_OPERATIONS.binary_search(&operation).is_ok() {
        return Some("api");
    }
    if DATABASE_OPERATIONS.binary_search(&operation).is_ok() {
        return Some("database");
    }
    if MESSAGE_OPERATIONS.binary_search(&operation).is_ok() {
        return Some("message");
    }
    if CACHE_OPERATIONS.binary_search(&operation).is_ok() {
        return Some("cache");
    }
    if FILE_OPERATIONS.binary_search(&operation).is_ok() {
        return Some("file");
    }
    None
}

fn root_binding(receiver: &str) -> &str {
    let end = receiver.find(['.', '[', '(', ' ']).unwrap_or(receiver.len());
    &receiver[..end]
}

fn is_network_origin(origin: &str) -> bool {
    origin == "fetch"
        || origin.contains("http")
        || origin.contains("axios")
        || origin.contains("undici")
        || origin.contains("got")
        || origin.contains("node-fetch")
}

fn bare_exit(call: &CallFact, modules: &HashMap<(u32, String), String>) -> Option<&'static str> {
    if call.callee == "fetch" {
        return Some("api");
    }
    let specifier = modules.get(&(call.file, call.callee.clone()))?;
    classify_exit(&call.callee, specifier, &call.callee)
}

pub struct Derived {
    pub entry_points: Vec<EntryPoint>,
    pub exit_points: Vec<ExitPoint>,
}

pub fn derive(
    nodes: &[IndexNode],
    calls: &[CallFact],
    files: &[String],
    modules: &HashMap<(u32, String), String>,
) -> Derived {
    let mut entry_points = Vec::new();

    for node in nodes {
        if let Some(registrar) = &node.callback_of {
            let label = node.registration_label.as_deref();
            if let Some(kind) = classify_registration(registrar, label) {
                let verb = tail(registrar);
                entry_points.push(EntryPoint {
                    id: format!("entry:{}", node.id),
                    kind,
                    name: label.unwrap_or(registrar).to_string(),
                    method: if kind == "http" {
                        Some(verb.to_ascii_uppercase())
                    } else {
                        None
                    },
                    path: if kind == "http" {
                        label.map(str::to_string)
                    } else {
                        None
                    },
                    handler: node.id.clone(),
                    file: node.file,
                    line: node.span.line,
                    registrar: registrar.clone(),
                });
            }
        }
        for decorator in &node.decorators {
            if let Some((kind, method, path)) = decorator_entry(decorator) {
                entry_points.push(EntryPoint {
                    id: format!("entry:{}:{}", node.id, decorator.name),
                    kind,
                    name: path.clone().unwrap_or_else(|| node.name.clone()),
                    method: Some(method),
                    path,
                    handler: node.id.clone(),
                    file: node.file,
                    line: node.span.line,
                    registrar: decorator.name.clone(),
                });
            }
        }
    }

    let mut exit_points = Vec::new();
    for (position, call) in calls.iter().enumerate() {
        let Some(source) = &call.caller else { continue };
        let Some(receiver) = call.receiver.as_deref() else {
            let Some(kind) = bare_exit(call, modules) else { continue };
            let origin = modules
                .get(&(call.file, call.callee.clone()))
                .cloned()
                .unwrap_or_else(|| call.callee.clone());
            exit_points.push(ExitPoint {
                id: format!("exit:{}:{}", files[call.file as usize], position),
                kind,
                name: call.callee.clone(),
                source: source.clone(),
                target: origin,
                operation: call.callee.clone(),
                file: call.file,
                line: call.line,
                awaited: call.context.awaited,
            });
            continue;
        };
        let binding = root_binding(receiver);
        let origin = match modules.get(&(call.file, binding.to_string())) {
            Some(specifier) => specifier.as_str(),
            None if IO_GLOBALS.binary_search(&binding).is_ok() => binding,
            None => continue,
        };
        let Some(kind) = classify_exit(binding, origin, &call.callee) else {
            continue;
        };
        let receiver = receiver.to_string();
        exit_points.push(ExitPoint {
            id: format!("exit:{}:{}", files[call.file as usize], position),
            kind,
            name: format!("{receiver}.{}", call.callee),
            source: source.clone(),
            target: origin.to_string(),
            operation: call.callee.clone(),
            file: call.file,
            line: call.line,
            awaited: call.context.awaited,
        });
    }

    entry_points.sort_by(|left, right| left.id.cmp(&right.id));
    exit_points.sort_by(|left, right| left.id.cmp(&right.id));
    Derived { entry_points, exit_points }
}
