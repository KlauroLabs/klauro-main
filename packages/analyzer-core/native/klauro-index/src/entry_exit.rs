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

struct EntryBase {
    base: &'static str,
    kind: &'static str,
    members: &'static [&'static str],
}

const fn base(base: &'static str, kind: &'static str, members: &'static [&'static str]) -> EntryBase {
    EntryBase { base, kind, members }
}

static GRAPHQL_MEMBERS: &[&str] = &["resolve_*", "mutate", "mutate_and_get_payload", "perform_mutation"];
static COMMAND_MEMBERS: &[&str] = &["execute", "handle"];

static ENTRY_BASES: &[EntryBase] = &[
    base("Activity", "lifecycle", &[]),
    base("AppCompatActivity", "lifecycle", &[]),
    base("Application", "lifecycle", &[]),
    base("BaseCommand", "cli", COMMAND_MEMBERS),
    base("BroadcastReceiver", "lifecycle", &[]),
    base("ComponentActivity", "lifecycle", &[]),
    base("Fragment", "lifecycle", &[]),
    base("Mutation", "graphql", GRAPHQL_MEMBERS),
    base("ObjectType", "graphql", GRAPHQL_MEMBERS),
    base("Service", "lifecycle", &[]),
    base("Subscription", "graphql", GRAPHQL_MEMBERS),
    base("Worker", "lifecycle", &[]),
];

fn matches_member(pattern: &str, name: &str) -> bool {
    match pattern.strip_suffix('*') {
        Some(prefix) => name.starts_with(prefix) && name.len() > prefix.len(),
        None => pattern == name,
    }
}

fn entry_base(name: &str) -> Option<&'static EntryBase> {
    let leaf = name.rsplit('.').next().unwrap_or(name);
    ENTRY_BASES.iter().find(|entry| entry.base == leaf)
}

static FILE_OPERATIONS: &[&str] = &[
    "appendalltext", "appendfile", "canonicalize", "contentsofdirectory", "copy", "copyfile",
    "copyitem", "create", "create_dir", "create_dir_all", "createdirectory",
    "createreadstream", "createwritestream", "delete", "deletefile", "enumeratefiles",
    "exists", "exists_sync", "existssync", "getdirectories", "getfiles", "hard_link",
    "metadata", "mkdir", "mkdirall", "move", "open", "openfile", "openread", "openwrite",
    "read_dir", "read_link", "read_to_end", "read_to_string", "readall", "readallbytes",
    "readalllines", "readalltext", "readalltextasync", "readdir", "readfile", "remove",
    "remove_dir", "remove_dir_all", "remove_file", "removeall", "removeitem", "rename", "rm",
    "rmdir", "set_permissions", "stat", "symlink_metadata", "unlink", "write_all",
    "writeallbytes", "writealltext", "writealltextasync", "writefile",
];
static NETWORK_OPERATIONS: &[&str] = &[
    "connect", "data", "datatask", "delete", "deleteasync", "do", "execute", "fetch", "get",
    "get_async", "getasync", "head", "newrequest", "patch", "patchasync", "post", "postasync",
    "postform", "put", "putasync", "request", "send", "send_async", "sendasync",
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
static PROCESS_OPERATIONS: &[&str] = &[
    "check_call", "check_output", "command", "communicate", "exec", "execfile", "execsync",
    "execute", "fork", "popen", "run", "spawn", "spawnsync", "start", "system", "waitpid",
];

static CACHE_OPERATIONS: &[&str] = &[
    "del", "expire", "getex", "hget", "hset", "setex", "ttl",
];

static CLIENT_STORAGE_GLOBALS: &[&str] = &["localStorage", "sessionStorage"];
static IO_GLOBALS: &[&str] = &["fetch", "localStorage", "process", "sessionStorage"];

/// What a module reaches out to. The specifier is matched whole or as a path prefix, so
/// `std::fs::read` and `fs` both land on the same entry. Only modules that leave the process
/// belong here: `std::path` manipulates strings and is not an exit.
struct IoModule {
    specifier: &'static str,
    kinds: &'static [&'static str],
}

const fn io(specifier: &'static str, kinds: &'static [&'static str]) -> IoModule {
    IoModule { specifier, kinds }
}

static FILE: &[&str] = &["file"];
static API: &[&str] = &["api"];
static DATABASE: &[&str] = &["database"];
static PROCESS: &[&str] = &["process"];
static FILE_OR_PROCESS: &[&str] = &["file", "process"];

static IO_MODULES: &[IoModule] = &[
    io("ActiveRecord", DATABASE),
    io("Alamofire", API),
    io("Directory", FILE),
    io("File", FILE),
    io("FileManager", FILE),
    io("HttpClient", API),
    io("System.Data", DATABASE),
    io("System.Diagnostics", PROCESS),
    io("System.IO", FILE),
    io("System.Net.Http", API),
    io("URLSession", API),
    io("aiohttp", API),
    io("axios", API),
    io("child_process", PROCESS),
    io("database/sql", DATABASE),
    io("diesel", DATABASE),
    io("fs", FILE),
    io("fs/promises", FILE),
    io("got", API),
    io("httpx", API),
    io("hyper", API),
    io("io/ioutil", FILE),
    io("java.io", FILE),
    io("java.lang.ProcessBuilder", PROCESS),
    io("java.lang.Runtime", PROCESS),
    io("java.net.http", API),
    io("java.nio.file", FILE),
    io("java.sql", DATABASE),
    io("mongoose", DATABASE),
    io("mysql2", DATABASE),
    io("net/http", API),
    io("node-fetch", API),
    io("okhttp3", API),
    io("os", FILE_OR_PROCESS),
    io("os/exec", PROCESS),
    io("pathlib", FILE),
    io("pg", DATABASE),
    io("psycopg2", DATABASE),
    io("pymysql", DATABASE),
    io("requests", API),
    io("reqwest", API),
    io("retrofit2", API),
    io("shutil", FILE),
    io("sqlite3", DATABASE),
    io("sqlx", DATABASE),
    io("std::fs", FILE),
    io("std::net", API),
    io("std::process", PROCESS),
    io("subprocess", PROCESS),
    io("tokio::fs", FILE),
    io("tokio::net", API),
    io("tokio::process", PROCESS),
    io("undici", API),
    io("ureq", API),
    io("urllib", API),
];

fn module_kind(specifier: &str) -> Option<&'static [&'static str]> {
    let specifier = specifier.trim_start_matches("./").trim_start_matches("node:");
    IO_MODULES
        .iter()
        .filter(|entry| {
            specifier == entry.specifier
                || specifier
                    .strip_prefix(entry.specifier)
                    .is_some_and(|rest| {
                        rest.starts_with("::") || rest.starts_with('/') || rest.starts_with('.')
                    })
        })
        .max_by_key(|entry| entry.specifier.len())
        .map(|entry| entry.kinds)
}

fn classify_exit(binding: &str, origin: &str, member: &str) -> Option<&'static str> {
    let operation = tail(member).to_ascii_lowercase();
    let operation = operation.as_str();
    if CLIENT_STORAGE_GLOBALS.binary_search(&binding).is_ok() {
        return Some("client_storage");
    }
    // A module that names what it reaches is authoritative: `os.execute` shells out, and the
    // fact that "execute" also reads as a database verb must not make it a query.
    if let Some(reaches) = module_kind(origin) {
        return reaches.iter().copied().find(|kind| {
            let operations = match *kind {
                "file" => FILE_OPERATIONS,
                "api" => NETWORK_OPERATIONS,
                "process" => PROCESS_OPERATIONS,
                _ => DATABASE_OPERATIONS,
            };
            operations.binary_search(&operation).is_ok()
        });
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

static SESSION_OPERATIONS: &[&str] = &[
    "add", "add_all", "bulk_save_objects", "commit", "delete", "execute", "flush", "merge",
    "query", "refresh", "rollback", "scalar", "scalars",
];

fn manager_exit(receiver: &str, operation: &str) -> Option<&'static str> {
    let manager = receiver.rsplit('.').next()?.trim();
    if manager == "objects" {
        return Some("database");
    }
    // A generated query object carries the query in its own method names, so the receiver is
    // the only stable evidence: `db.episodesQueries.showIdForEpisodeId(...)`.
    if manager.len() > "Queries".len() && manager.ends_with("Queries") {
        return Some("database");
    }
    let operation = operation.to_ascii_lowercase();
    if (manager == "session" || manager == "db_session")
        && SESSION_OPERATIONS.binary_search(&operation.as_str()).is_ok()
    {
        return Some("database");
    }
    None
}

/// Members of a request or a response that hold data rather than a connection. The origin of
/// `req.Header` is `net/http` because `req` is, but reading a header leaves nothing: the
/// package a value's type came from does not make every member of it an exit.
static DATA_MEMBERS: &[&str] = &[
    "body", "cookies", "form", "header", "headers", "multipartform", "params", "postform",
    "query", "request", "response", "tls", "trailer", "url",
];

fn reads_a_data_member(receiver: &str) -> bool {
    let member = receiver.rsplit('.').next().unwrap_or(receiver);
    let member = member.split(['(', '[']).next().unwrap_or(member).trim();
    DATA_MEMBERS.binary_search(&member.to_ascii_lowercase().as_str()).is_ok()
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
    if let Some(specifier) = modules.get(&(call.file, call.callee.clone())) {
        return classify_exit(&call.callee, specifier, &call.callee);
    }
    // A qualified call names its own module: `fs::metadata`, `std::fs::read`. The root is
    // resolved through the file's imports when it is an alias, and read literally otherwise.
    let at = call.callee.rfind("::").map(|at| at + 2).or_else(|| {
        call.callee.rfind('.').map(|at| at + 1)
    })?;
    let operation = &call.callee[at..];
    if operation.is_empty() {
        return None;
    }
    let path = &call.callee[..at];
    let path = path.trim_end_matches(['.', ':']);
    let root = path.split([':', '.']).next().unwrap_or(path);
    match modules.get(&(call.file, root.to_string())) {
        Some(specifier) => classify_exit(root, specifier, operation),
        // Nothing imported this root, so the call path is the only evidence. It must name a
        // module that leaves the process; an operation name alone is not enough to claim one.
        None => module_kind(path).and(classify_exit(root, path, operation)),
    }
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
    type_references: &[TypeReferenceFact],
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

    let mut by_name: HashMap<&str, &IndexNode> = HashMap::new();
    let mut above: HashMap<&str, Vec<&str>> = HashMap::new();
    for node in nodes {
        if node.kind.is_type() {
            by_name.entry(node.name.as_str()).or_insert(node);
        }
    }
    for fact in type_references {
        if !matches!(fact.kind, EdgeKind::Extends | EdgeKind::Implements) {
            continue;
        }
        above.entry(fact.source.as_str()).or_default().push(fact.name.as_str());
    }
    let inherits = |node: &IndexNode| -> Option<&'static EntryBase> {
        let mut seen: HashSet<&str> = HashSet::new();
        let mut pending: Vec<&str> = vec![node.id.as_str()];
        while let Some(at) = pending.pop() {
            if !seen.insert(at) {
                continue;
            }
            for name in above.get(at).into_iter().flatten() {
                if let Some(found) = entry_base(name) {
                    return Some(found);
                }
                let leaf = name.rsplit('.').next().unwrap_or(name);
                if let Some(declared) = by_name.get(leaf) {
                    pending.push(declared.id.as_str());
                }
            }
        }
        None
    };

    let mut members: HashMap<&str, Vec<&IndexNode>> = HashMap::new();
    for node in nodes {
        if let Some(parent) = node.parent.as_deref()
            && matches!(node.kind, NodeKind::Method | NodeKind::Function)
        {
            members.entry(parent).or_default().push(node);
        }
    }
    for node in nodes {
        if !node.kind.is_type() {
            continue;
        }
        let Some(found) = inherits(node) else { continue };
        if found.members.is_empty() {
            entry_points.push(EntryPoint {
                id: format!("entry:{}", node.id),
                kind: found.kind,
                name: node.name.clone(),
                method: None,
                path: None,
                handler: node.id.clone(),
                file: node.file,
                line: node.span.line,
                registrar: found.base.to_string(),
            });
            continue;
        }
        for member in members.get(node.id.as_str()).into_iter().flatten() {
            if !found.members.iter().any(|pattern| matches_member(pattern, &member.name)) {
                continue;
            }
            entry_points.push(EntryPoint {
                id: format!("entry:{}", member.id),
                kind: found.kind,
                name: member.name.clone(),
                method: None,
                path: None,
                handler: member.id.clone(),
                file: member.file,
                line: member.span.line,
                registrar: found.base.to_string(),
            });
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
        if receiver.contains('.') && reads_a_data_member(receiver) {
            continue;
        }
        if let Some(kind) = manager_exit(receiver, &call.callee) {
            let operation = tail(&call.callee);
            exit_points.push(ExitPoint {
                id: format!("exit:{}:{}", files[call.file as usize], position),
                kind,
                name: format!("{receiver}.{operation}"),
                source: source.clone(),
                target: binding.to_string(),
                operation: operation.to_string(),
                file: call.file,
                line: call.line,
                awaited: call.context.awaited,
            });
            continue;
        }
        let origin = match call_origins
            .get(&(source.clone(), receiver.to_string()))
            .or_else(|| modules.get(&(call.file, receiver.to_string())))
            .or_else(|| modules.get(&(call.file, binding.to_string())))
        {
            Some(specifier) => specifier.as_str(),
            None if IO_GLOBALS.binary_search(&binding).is_ok() => binding,
            // A static I/O type is its own evidence: `File.ReadAllBytes`, `Directory.Delete`.
            None if module_kind(binding).is_some() => binding,
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Every vocabulary here is looked up with `binary_search`, which answers "absent" for a
    /// table that is merely unsorted. That failure is silent: the rule simply stops firing.
    #[test]
    fn every_vocabulary_is_sorted() {
        let tables: &[(&str, &[&str])] = &[
            ("CACHE_OPERATIONS", CACHE_OPERATIONS),
            ("CLIENT_STORAGE_GLOBALS", CLIENT_STORAGE_GLOBALS),
            ("COMMAND_REGISTRARS", COMMAND_REGISTRARS),
            ("DATABASE_OPERATIONS", DATABASE_OPERATIONS),
            ("DATA_MEMBERS", DATA_MEMBERS),
            ("EVENT_REGISTRARS", EVENT_REGISTRARS),
            ("FILE_OPERATIONS", FILE_OPERATIONS),
            ("HTTP_METHODS", HTTP_METHODS),
            ("IO_GLOBALS", IO_GLOBALS),
            ("IPC_REGISTRARS", IPC_REGISTRARS),
            ("LIFECYCLE_NAMES", LIFECYCLE_NAMES),
            ("MESSAGE_OPERATIONS", MESSAGE_OPERATIONS),
            ("MESSAGE_REGISTRARS", MESSAGE_REGISTRARS),
            ("NETWORK_OPERATIONS", NETWORK_OPERATIONS),
            ("PATH_REGISTRARS", PATH_REGISTRARS),
            ("PROCESS_OPERATIONS", PROCESS_OPERATIONS),
            ("SCHEDULE_REGISTRARS", SCHEDULE_REGISTRARS),
            ("SESSION_OPERATIONS", SESSION_OPERATIONS),
            ("TEST_REGISTRARS", TEST_REGISTRARS),
        ];
        for (name, table) in tables {
            assert!(table.is_sorted(), "{name} is not sorted, so binary_search cannot find it");
        }
    }

    #[test]
    fn a_module_reaches_only_what_its_own_operations_name() {
        assert_eq!(classify_exit("os", "os", "execute"), Some("process"));
        assert_eq!(classify_exit("os", "os", "readfile"), Some("file"));
        assert_eq!(classify_exit("os", "os", "getenv"), None);
        assert_eq!(classify_exit("subprocess", "subprocess", "check_output"), Some("process"));
    }

    #[test]
    fn a_data_member_of_a_request_is_not_a_connection() {
        assert!(reads_a_data_member("req.Header"));
        assert!(reads_a_data_member("this.rw.Header()"));
        assert!(!reads_a_data_member("this.client"));
        assert!(!reads_a_data_member("http.DefaultClient"));
    }
}
