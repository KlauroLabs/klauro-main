use std::collections::{HashMap, HashSet};

use serde::Serialize;

use crate::model::*;
use crate::resolve::Resolution;
use crate::paths::is_test;

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

static LIFECYCLE_NAMES: &[&str] = &["Main", "main", "wmain"];

static PATH_REGISTRARS: &[&str] =
    &["handle", "handlefunc", "handler", "handlerfunc", "path", "re_path", "route"];

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

fn split_label(label: &str) -> (Option<String>, String) {
    let trimmed = label.trim();
    if let Some((head, rest)) = trimmed.split_once(char::is_whitespace) {
        let verb = head.to_ascii_lowercase();
        if HTTP_METHODS.binary_search(&verb.as_str()).is_ok() {
            return (Some(head.to_ascii_uppercase()), rest.trim().to_string());
        }
    }
    (None, trimmed.to_string())
}

fn classify_registration(registrar: &str, label: Option<&str>) -> Option<&'static str> {
    let verb = tail(registrar);
    let lowered = verb.to_ascii_lowercase();
    if PATH_REGISTRARS.binary_search(&lowered.as_str()).is_ok()
        || HTTP_METHODS.binary_search(&verb).is_ok()
    {
        let through_receiver = verb.len() != registrar.len();
        return match label {
            Some(label) if !looks_like_route(&split_label(label).1) => None,
            Some(label) if through_receiver && !label.contains('/') => None,
            Some(_) => Some("http"),
            None => None,
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

fn normalize_annotation(name: &str) -> String {
    let name = name.rsplit('.').next().unwrap_or(name);
    let mut lowered = name.to_ascii_lowercase();
    for suffix in ["mapping", "attribute", "async"] {
        if let Some(stripped) = lowered.strip_suffix(suffix)
            && !stripped.is_empty()
        {
            lowered = stripped.to_string();
        }
    }
    if let Some(stripped) = lowered.strip_prefix("http")
        && !stripped.is_empty()
    {
        lowered = stripped.to_string();
    }
    lowered
}

fn names_a_test(name: &str) -> bool {
    let Some(rest) = name.get(..4).filter(|head| head.eq_ignore_ascii_case("test")).map(|_| &name[4..])
    else {
        return false;
    };
    rest.is_empty() || rest.starts_with('_') || rest.starts_with(char::is_uppercase)
}

fn looks_like_route(value: &str) -> bool {
    !value.is_empty() && !value.contains(' ') && (value.contains('/') || !value.contains('.'))
}

fn owner_path(path: &str, owner: &str) -> String {
    path.replace("[controller]", owner.strip_suffix("Controller").unwrap_or(owner))
}

fn decorator_entry(decorator: &Decorator) -> Option<(&'static str, String, Option<String>)> {
    let verb = decorator.name.rsplit('.').next().unwrap_or(&decorator.name);
    let qualified = verb.len() != decorator.name.len();
    let lowered = normalize_annotation(&decorator.name);
    let path = decorator
        .arguments
        .iter()
        .find(|argument| {
            argument.literal
                && looks_like_route(&argument.value)
                && (!qualified || argument.value.contains('/'))
        })
        .map(|argument| argument.value.clone());
    if matches!(lowered.as_str(), "controller" | "request" | "route") {
        return Some(("http", "ANY".to_string(), path));
    }
    if HTTP_METHODS.binary_search(&lowered.as_str()).is_ok() {
        if !qualified && verb.starts_with(char::is_lowercase) {
            return None;
        }
        return Some(("http", lowered.to_ascii_uppercase(), path));
    }
    match lowered.as_str() {
        "eventpattern" | "onevent" | "subscribe" | "eventlistener" | "kafkalistener"
        | "rabbitlistener" | "streamlistener" => Some(("event", lowered, None)),
        "messagepattern" | "jmslistener" | "sqslistener" => Some(("message", lowered, None)),
        "cron" | "interval" | "timeout" | "scheduled" => Some(("schedule", lowered, None)),
        "resolvefield" | "schemamapping" | "querymapping" | "mutationmapping"
        | "subscriptionmapping" => Some(("graphql", lowered, None)),
        "grpcmethod" | "grpcstreammethod" | "grpcservice" => Some(("rpc", lowered, None)),
        "command" | "consolecommand" => Some(("cli", lowered, None)),
        "fact" | "theory" | "test" | "testcase" | "testmethod" | "parameterizedtest"
        | "benchmark" => Some(("test", lowered, None)),
        _ => None,
    }
}

static FILE_OPERATIONS: &[&str] = &[
    "appendfile", "copyfile", "create", "createreadstream", "createwritestream", "mkdir",
    "mkdirall", "open", "openfile", "readall", "readdir", "readfile", "remove", "removeall",
    "rename", "rm", "rmdir", "stat", "unlink", "writefile",
];
static NETWORK_OPERATIONS: &[&str] = &[
    "connect", "delete", "do", "fetch", "get", "head", "newrequest", "patch", "post",
    "postform", "put", "request", "send",
];
static DATABASE_OPERATIONS: &[&str] = &[
    "aggregate", "begin", "begintx", "deletemany", "deleteone", "exec", "execcontext",
    "execute", "findmany", "findone", "insertmany", "insertone", "prepare", "preparecontext",
    "query", "querycontext", "queryrow", "queryrowcontext", "transaction", "updatemany",
    "updateone", "upsert",
];
static MESSAGE_OPERATIONS: &[&str] = &[
    "broadcast", "emit", "produce", "publish", "sendmessage",
];
static CACHE_OPERATIONS: &[&str] = &["del", "expire", "getex", "hget", "hset", "setex", "ttl"];

static CLIENT_STORAGE_GLOBALS: &[&str] = &["localStorage", "sessionStorage"];
static IO_GLOBALS: &[&str] = &["fetch", "localStorage", "process", "sessionStorage"];

fn classify_exit(binding: &str, origin: &str, member: &str) -> Option<&'static str> {
    let operation = tail(member).to_ascii_lowercase();
    let operation = operation.as_str();
    if CLIENT_STORAGE_GLOBALS.binary_search(&binding).is_ok() {
        return Some("client_storage");
    }
    if is_file_origin(origin) && FILE_OPERATIONS.binary_search(&operation).is_ok() {
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
    None
}

fn join_paths(base: &str, path: &str) -> String {
    let base = base.trim_end_matches('/');
    let path = path.trim_start_matches('/');
    if path.is_empty() {
        return base.to_string();
    }
    format!("{base}/{path}")
}

fn root_binding(receiver: &str) -> &str {
    let end = receiver.find(['.', '[', '(', ' ']).unwrap_or(receiver.len());
    &receiver[..end]
}

fn is_file_origin(origin: &str) -> bool {
    origin.contains("fs") || origin.ends_with("/os") || origin == "os" || origin.contains("path/filepath")
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
    registrations: &[RegistrationFact],
    resolution: &Resolution,
) -> Derived {
    let Resolution { modules, local, unique_units, call_origins, .. } = resolution;
    let mut entry_points = Vec::new();
    let mut base_paths: HashMap<&str, String> = HashMap::new();
    for node in nodes {
        if !matches!(node.kind, NodeKind::Class | NodeKind::Interface) {
            continue;
        }
        for decorator in &node.decorators {
            if let Some(("http", _, Some(path))) = decorator_entry(decorator) {
                base_paths.insert(node.id.as_str(), owner_path(&path, &node.name));
                break;
            }
        }
    }

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
                if method == "ANY" && matches!(node.kind, NodeKind::Class | NodeKind::Interface) {
                    continue;
                }
                let base = node
                    .parent
                    .as_deref()
                    .and_then(|parent| base_paths.get(parent));
                let path = match (base, path) {
                    (Some(base), Some(path)) => Some(join_paths(base, &path)),
                    (Some(base), None) => Some(base.clone()),
                    (None, path) => path,
                };
                if kind == "http" && path.is_none() {
                    continue;
                }
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

    let declared: HashSet<&str> = nodes
        .iter()
        .filter(|node| node.kind.is_type() || matches!(node.kind, NodeKind::Function | NodeKind::Method))
        .flat_map(|node| [node.name.as_str(), node.name.rsplit('.').next().unwrap_or(&node.name)])
        .collect();
    let mut registered: HashSet<(u32, u32)> = HashSet::new();
    for registration in registrations {
        let Some(kind) = classify_registration(&registration.registrar, Some(&registration.label))
        else {
            continue;
        };
        let leaf = registration
            .handler
            .rsplit('.')
            .next()
            .unwrap_or(&registration.handler);
        let Some(handler) = local
            .get(&(registration.file, registration.handler.clone()))
            .or_else(|| local.get(&(registration.file, leaf.to_string())))
            .or_else(|| unique_units.get(leaf))
            .cloned()
            .or_else(|| {
                declared.contains(leaf).then(|| files[registration.file as usize].clone())
            })
        else {
            continue;
        };
        if !registered.insert((registration.file, registration.line)) {
            continue;
        }
        let verb = tail(&registration.registrar);
        let (label_method, path) = split_label(&registration.label);
        entry_points.push(EntryPoint {
            id: format!("entry:{handler}:{}", registration.label),
            kind,
            name: registration.label.clone(),
            method: if kind == "http" {
                Some(label_method.unwrap_or_else(|| verb.to_ascii_uppercase()))
            } else {
                None
            },
            path: if kind == "http" { Some(path) } else { None },
            handler,
            file: registration.file,
            line: registration.line,
            registrar: registration.registrar.clone(),
        });
    }

    let declared_cases: HashSet<String> = entry_points
        .iter()
        .filter(|entry| entry.kind == "test")
        .map(|entry| entry.handler.clone())
        .collect();
    for node in nodes {
        if matches!(node.kind, NodeKind::Function | NodeKind::Method)
            && names_a_test(&node.name)
            && is_test(&files[node.file as usize])
            && !declared_cases.contains(node.id.as_str())
        {
            entry_points.push(EntryPoint {
                id: format!("entry:{}:test", node.id),
                kind: "test",
                name: node.name.clone(),
                method: None,
                path: None,
                handler: node.id.clone(),
                file: node.file,
                line: node.span.line,
                registrar: node.name.clone(),
            });
        }
    }

    for node in nodes {
        if !matches!(node.kind, NodeKind::Function | NodeKind::Method) {
            continue;
        }
        if LIFECYCLE_NAMES.binary_search(&node.name.as_str()).is_err() {
            continue;
        }
        entry_points.push(EntryPoint {
            id: format!("entry:{}:lifecycle", node.id),
            kind: "lifecycle",
            name: node.name.clone(),
            method: None,
            path: None,
            handler: node.id.clone(),
            file: node.file,
            line: node.span.line,
            registrar: node.name.clone(),
        });
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
        let origin = match call_origins
            .get(&(source.clone(), receiver.to_string()))
            .or_else(|| modules.get(&(call.file, receiver.to_string())))
            .or_else(|| modules.get(&(call.file, binding.to_string())))
        {
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
    entry_points.dedup_by(|left, right| left.id == right.id);
    exit_points.sort_by(|left, right| left.id.cmp(&right.id));
    entry_points.retain(|entry| entry.kind != "http" || !is_test(&files[entry.file as usize]));
    Derived { entry_points, exit_points }
}
