use std::collections::{HashMap, HashSet};

use serde::Serialize;

use crate::model::*;
use crate::names;
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
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub guards: Vec<Guard>,
    pub registrar: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Guard {
    pub name: String,
    pub kind: &'static str,
    pub via: &'static str,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub addressed: Option<String>,
}

static HTTP_METHODS: &[&str] = &[
    "all", "delete", "get", "head", "options", "patch", "post", "put",
];

static LIFECYCLE_NAMES: &[&str] = &["Main", "main", "wmain"];

static ROUTERS: &[&str] = &["Route", "Router", "blueprint", "bp", "mux", "route", "router"];

fn registered_on_a_router(registrar: &str) -> bool {
    match registrar.rfind('.') {
        Some(at) => ROUTERS.binary_search(&&registrar[..at]).is_ok(),
        None => false,
    }
}

static PATH_REGISTRARS: &[&str] = &[
    "handle", "handlefunc", "handler", "handlerfunc", "mount", "nest", "path", "re_path",
    "resource", "route", "service",
];

static EVENT_REGISTRARS: &[&str] = &["addEventListener", "on", "once", "prependListener"];
static TEST_REGISTRARS: &[&str] = &["bench", "describe", "it", "suite", "test"];
static SCHEDULE_REGISTRARS: &[&str] = &["cron", "schedule", "setInterval", "setTimeout"];
static RECURRING: &[&str] = &["cron", "schedule", "setInterval"];

pub fn recurring(registrar: &str) -> bool {
    RECURRING.binary_search(&names::leaf(registrar)).is_ok()
}
static MESSAGE_REGISTRARS: &[&str] = &["consume", "process", "subscribe", "worker"];
static COMMAND_REGISTRARS: &[&str] = &["action", "command", "handler"];
static IPC_REGISTRARS: &[&str] = &["handle", "handleOnce", "invoke"];
static PROCEDURE_REGISTRARS: &[&str] = &["mutation", "query", "subscription"];

fn running_within<'a>(node: &'a IndexNode, named_of: &HashMap<&str, &'a IndexNode>) -> Option<&'a str> {
    let runs = |held: &IndexNode| {
        matches!(
            held.kind,
            NodeKind::Function | NodeKind::Method | NodeKind::Constructor | NodeKind::Class
        ) && !held.name.contains('#')
    };
    let mut climbed: HashSet<&str> = HashSet::from([node.id.as_str()]);
    let mut holder = node;
    while !runs(holder) {
        let above = named_of.get(holder.parent.as_deref()?)?;
        if !climbed.insert(above.id.as_str()) {
            return None;
        }
        holder = above;
    }
    (!holder.name.is_empty()).then_some(holder.name.as_str())
}

fn declared_by_a_command(registrar: &str) -> bool {
    let Some((held, _)) = registrar.rsplit_once('.') else { return false };
    let leaf = held.rsplit(['.', ':']).next().unwrap_or(held).to_ascii_lowercase();
    leaf.ends_with("command") || leaf.ends_with("cmd")
}

fn registered_on_a_procedure(registrar: &str) -> bool {
    names::root(registrar).to_ascii_lowercase().ends_with("procedure")
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
    let verb = names::leaf(registrar);
    let lowered = verb.to_ascii_lowercase();
    if PATH_REGISTRARS.binary_search(&lowered.as_str()).is_ok()
        || HTTP_METHODS.binary_search(&lowered.as_str()).is_ok()
    {
        let through_receiver = verb.len() != registrar.len() && !registered_on_a_router(registrar);
        return match label {
            Some(label) if !looks_like_route(&split_label(label).1) => None,
            Some(label) if through_receiver && !label.contains('/') => None,
            Some(_) => Some("http"),
            None => None,
        };
    }
    if declared_by_a_command(registrar)
        && matches!(lowered.as_str(), "run" | "rune" | "runfunc" | "action" | "execute" | "handler")
    {
        return Some("cli");
    }
    if PROCEDURE_REGISTRARS.binary_search(&lowered.as_str()).is_ok()
        && registered_on_a_procedure(registrar)
    {
        return Some("rpc");
    }
    if let Some(_) = mapped_method(verb) {
        return match label {
            Some(label) if looks_like_route(&split_label(label).1) => Some("http"),
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

fn normalize_annotation(name: &str) -> String {
    let name = names::leaf(name);
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

fn mapped_method(verb: &str) -> Option<String> {
    let rest = verb.strip_prefix("Map").or_else(|| verb.strip_prefix("map"))?;
    let lowered = rest.to_ascii_lowercase();
    HTTP_METHODS
        .binary_search(&lowered.as_str())
        .is_ok()
        .then(|| lowered.to_ascii_uppercase())
}

fn looks_like_route(value: &str) -> bool {
    !value.is_empty() && !value.contains(' ') && (value.contains('/') || !value.contains('.'))
}

fn asked_of_a_table(call: &CallFact) -> Option<(String, String)> {
    call.literals.iter().find_map(|held| a_statement_about(held))
}

static SAID_BY_A_CLAUSE: &[&str] = &[
    "group", "having", "join", "limit", "on", "order", "returning", "set", "using", "values",
    "where",
];

fn reads_like_sql(held: &str, spoken: &[&str]) -> bool {
    held.contains([',', '(', '*', ';', '=', '$', '?'])
        || spoken.iter().any(|word| {
            SAID_BY_A_CLAUSE.binary_search(&word.to_ascii_lowercase().as_str()).is_ok()
        })
}

fn a_statement_about(held: &str) -> Option<(String, String)> {
    let spoken: Vec<&str> = held.split_whitespace().collect();
    if !reads_like_sql(held, &spoken) {
        return None;
    }
    let verb = spoken.first()?.trim_matches(['(', '"']).to_ascii_lowercase();
    let (clause, follows) = match verb.as_str() {
        "select" | "with" | "delete" => ("from", "from"),
        "insert" => ("into", "into"),
        "update" => ("set", ""),
        _ => return None,
    };
    if !spoken.iter().any(|held| held.eq_ignore_ascii_case(clause)) {
        return None;
    }
    let named = match follows.is_empty() {
        true => spoken.get(1).copied().and_then(plainly_a_table),
        false => named_after(&spoken, follows),
    }?;
    Some((verb, named))
}

fn named_after(spoken: &[&str], word: &str) -> Option<String> {
    spoken
        .iter()
        .enumerate()
        .filter(|(_, held)| held.eq_ignore_ascii_case(word))
        .find_map(|(at, _)| spoken.get(at + 1).copied().and_then(plainly_a_table))
}

static NEVER_A_TABLE: &[&str] = &[
    "a", "all", "an", "and", "any", "as", "by", "case", "distinct", "each", "else", "end", "every",
    "from", "group", "having", "insert", "into", "it", "join", "lateral", "limit", "not", "offset",
    "on", "or", "order", "select", "set", "some", "that", "the", "then", "these", "this", "those",
    "union", "unnest", "update", "values", "when", "where", "with",
];

fn plainly_a_table(held: &str) -> Option<String> {
    let spoken = held.trim_matches(|letter: char| !letter.is_alphanumeric() && letter != '_' && letter != '.');
    if spoken.contains('$') || spoken.contains('{') {
        return None;
    }
    let named = spoken.rsplit('.').next()?;
    let spoken = named.len() > 1
        && named.starts_with(|letter: char| letter.is_ascii_alphabetic() || letter == '_')
        && named.chars().all(|letter| letter.is_ascii_alphanumeric() || letter == '_')
        && NEVER_A_TABLE.binary_search(&named.to_ascii_lowercase().as_str()).is_err();
    spoken.then(|| named.to_string())
}

fn owner_path(path: &str, owner: &str) -> String {
    path.replace("[controller]", owner.strip_suffix("Controller").unwrap_or(owner))
}

fn decorator_entry(decorator: &Decorator) -> Option<(&'static str, String, Option<String>)> {
    let verb = names::leaf(&decorator.name);
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

static CASE_MEMBERS: &[&str] = &["it_*", "should_*", "test*"];

static ENTRY_BASES: &[EntryBase] = &[
    base("AppCompatActivity", "lifecycle", &[]),
    base("Application", "lifecycle", &[]),
    base("BaseCommand", "cli", COMMAND_MEMBERS),
    base("BroadcastReceiver", "lifecycle", &[]),
    base("ComponentActivity", "lifecycle", &[]),
    base("Fragment", "lifecycle", &[]),
    base("Mutation", "graphql", GRAPHQL_MEMBERS),
    base("ObjectType", "graphql", GRAPHQL_MEMBERS),
    base("Subscription", "graphql", GRAPHQL_MEMBERS),
    base("TestCase", "test", CASE_MEMBERS),
    base("Worker", "lifecycle", &[]),
];

fn matches_member(pattern: &str, name: &str) -> bool {
    match pattern.strip_suffix('*') {
        Some(prefix) => name.starts_with(prefix) && name.len() > prefix.len(),
        None => pattern == name,
    }
}

fn entry_base(name: &str) -> Option<&'static EntryBase> {
    let leaf = names::leaf(name);
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
    "aggregate", "begin", "begintx", "createquerybuilder", "deletefrom", "deletemany",
    "deleteone", "exec", "execcontext", "execute", "executetakefirst",
    "executetakefirstorthrow", "findmany", "findone", "insertinto", "insertmany", "insertone",
    "prepare", "preparecontext", "query", "querycontext", "queryrow", "queryrowcontext",
    "selectfrom", "transaction", "updatemany", "updateone", "updatetable", "upsert",
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
    classify_reached(binding, origin, member, None)
}

static SAID_BY_THE_MODULE: &[&str] = &["read", "write"];

fn reaching(kinds: &[&'static str], operation: &str) -> Option<&'static str> {
    kinds.iter().copied().find(|kind| {
        let operations = match *kind {
            "file" => FILE_OPERATIONS,
            "api" => NETWORK_OPERATIONS,
            "process" => PROCESS_OPERATIONS,
            _ => DATABASE_OPERATIONS,
        };
        operations.binary_search(&operation).is_ok()
            || (*kind == "file" && SAID_BY_THE_MODULE.contains(&operation))
    })
}

fn classify_reached(
    binding: &str,
    origin: &str,
    member: &str,
    standing: Option<&[&'static str]>,
) -> Option<&'static str> {
    let operation = names::leaf(member).to_ascii_lowercase();
    let operation = operation.as_str();
    if CLIENT_STORAGE_GLOBALS.binary_search(&binding).is_ok() {
        return Some("client_storage");
    }
    if let Some(reaches) = module_kind(origin) {
        return reaching(reaches, operation);
    }
    if let Some(reaches) = standing {
        return reaching(reaches, operation);
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

static ROUTER_CONSTRUCTORS: &[&str] = &["APIRouter", "Blueprint", "Router"];

fn constructs_a_router(callee: &str) -> bool {
    ROUTER_CONSTRUCTORS.contains(&names::leaf(callee))
}

fn mounts_at(literal: &str) -> Option<&str> {
    let held = literal.trim();
    let value = match held.split_once('=') {
        Some((named, value)) => {
            matches!(named.trim(), "prefix" | "url_prefix").then_some(value)?
        }
        None => held,
    };
    let value = value.trim().trim_matches(|held| held == '"' || held == '\'');
    looks_like_route(value).then_some(value)
}

fn mounted_under(calls: &[CallFact]) -> HashMap<u32, String> {
    let mut held: HashMap<u32, Vec<&str>> = HashMap::new();
    for call in calls {
        if !constructs_a_router(&call.callee) {
            continue;
        }
        for literal in &call.literals {
            if let Some(under) = mounts_at(literal) {
                held.entry(call.file).or_default().push(under);
            }
        }
    }
    held.into_iter()
        .filter_map(|(file, mut under)| {
            under.sort_unstable();
            under.dedup();
            match under.as_slice() {
                [only] => Some((file, (*only).to_string())),
                _ => None,
            }
        })
        .collect()
}

fn join_paths(base: &str, path: &str) -> String {
    let base = base.trim_end_matches('/');
    let path = path.trim_start_matches('/');
    if path.is_empty() {
        return base.to_string();
    }
    format!("{base}/{path}")
}

static KEPT_OPERATIONS: &[&str] = &[
    "all", "count", "create", "delete", "destroy", "exists", "find", "findorfail", "first",
    "firstorcreate", "firstorfail", "forcedelete", "get", "increment", "insert", "paginate",
    "restore", "save", "update", "updateorcreate", "upsert", "where",
];

pub fn kept_by_a_model(
    calls: &[CallFact],
    files: &[String],
    nodes: &[IndexNode],
    roles: &crate::roles::Roles,
) -> Vec<ExitPoint> {
    let modelled: HashSet<&str> = roles
        .roles
        .iter()
        .filter(|role| role.role == "model" && !role.from.starts_with("name:"))
        .filter_map(|role| nodes.iter().find(|node| node.id == role.node))
        .map(|node| node.name.as_str())
        .collect();
    if modelled.is_empty() {
        return Vec::new();
    }
    let mut found = Vec::new();
    for (position, call) in calls.iter().enumerate() {
        let Some(receiver) = call.receiver.as_deref() else { continue };
        let named = names::root(receiver);
        if !modelled.contains(named) {
            continue;
        }
        let operation = names::leaf(&call.callee);
        let lowered = operation.to_ascii_lowercase();
        if KEPT_OPERATIONS.binary_search(&lowered.as_str()).is_err() {
            continue;
        }
        let Some(source) = call.caller.clone() else { continue };
        found.push(ExitPoint {
            id: format!("exit:{}:{}:model", files[call.file as usize], position),
            kind: "database",
            name: format!("{named}.{operation}"),
            source,
            target: named.to_string(),
            operation: operation.to_string(),
            file: call.file,
            line: call.line,
            awaited: call.context.awaited,
            addressed: addressed_at(call),
        });
    }
    found
}

static SESSION_OPERATIONS: &[&str] = &[
    "add", "add_all", "bulk_save_objects", "commit", "delete", "exec", "execute", "flush", "get",
    "merge", "query", "refresh", "rollback", "scalar", "scalars",
];

static REPOSITORY_OPERATIONS: &[&str] = &[
    "aggregate", "all", "delete", "delete_all", "get", "get_by", "insert", "insert_all",
    "insert_or_update", "one", "preload", "reload", "stream", "transaction", "update",
    "update_all",
];

static STORE_OPERATIONS: &[&str] = &[
    "createquerybuilder", "deletefrom", "executetakefirst", "executetakefirstorthrow",
    "insertinto", "selectfrom", "updatetable",
];

fn names_a_store(operation: &str) -> bool {
    STORE_OPERATIONS.binary_search(&operation.to_ascii_lowercase().as_str()).is_ok()
}

fn addressed_through(dotted: &str) -> Option<(&str, &str)> {
    let mut held = dotted.rsplit('.');
    let verb = held.next()?;
    let owner = held.next()?;
    Some((owner, verb))
}

fn kept_by_a_repository(owner: &str, verb: &str) -> bool {
    owner.eq_ignore_ascii_case("repo")
        && REPOSITORY_OPERATIONS
            .binary_search(&verb.trim_end_matches(['!', '?']).to_ascii_lowercase().as_str())
            .is_ok()
}

fn manager_exit(receiver: &str, operation: &str) -> Option<&'static str> {
    let manager = names::leaf(receiver).trim();
    if manager == "objects" {
        return Some("database");
    }
    if kept_by_a_repository(manager, operation) {
        return Some("database");
    }
    if let Some((owner, verb)) = addressed_through(receiver)
        && kept_by_a_repository(owner, verb)
    {
        return Some("database");
    }
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

static DATA_MEMBERS: &[&str] = &[
    "body", "cookies", "form", "header", "headers", "multipartform", "params", "postform",
    "query", "request", "response", "tls", "trailer", "url",
];

fn reads_a_data_member(receiver: &str) -> bool {
    let member = names::leaf(receiver);
    let member = member.split(['(', '[']).next().unwrap_or(member).trim();
    DATA_MEMBERS.binary_search(&member.to_ascii_lowercase().as_str()).is_ok()
}

fn same_language(left: &str, right: &str) -> bool {
    fn suffix(path: &str) -> &str {
        match path.rsplit_once('.') {
            Some((_, extension)) if !extension.contains('/') => extension,
            _ => "",
        }
    }
    let left = suffix(left);
    !left.is_empty() && left == suffix(right)
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

fn a_path(held: &str) -> bool {
    held.starts_with('/') && !held.starts_with("//")
}

fn plainly_written(held: &str) -> &str {
    let held = held.trim().trim_matches(['"', '\'']);
    let end = held.find(['"', '\'', ' ', ')', ',']).unwrap_or(held.len());
    held[..end].trim_end_matches('/')
}

fn addressed_at(call: &CallFact) -> Option<String> {
    for held in call.literals.iter() {
        let held = plainly_written(held);
        if let Some(at) = held.find("://") {
            let rest = &held[at + 3..];
            let path = rest.find('/').map(|at| &rest[at..])?;
            if path.len() > 1 {
                return Some(path.to_string());
            }
            continue;
        }
        if a_path(held) && held.len() > 1 {
            return Some(held.to_string());
        }
        if let Some(at) = held.find("}/") {
            let path = &held[at + 1..];
            if path.len() > 1 && path.matches('/').count() >= 1 {
                return Some(path.to_string());
            }
        }
    }
    None
}

static BUILT_INTO_PHP: &[(&str, &str)] = &[
    ("copy", "file"),
    ("exec", "process"),
    ("fgets", "file"),
    ("file", "file"),
    ("file_exists", "file"),
    ("file_get_contents", "file"),
    ("file_put_contents", "file"),
    ("fopen", "file"),
    ("fputs", "file"),
    ("fread", "file"),
    ("fwrite", "file"),
    ("glob", "file"),
    ("is_dir", "file"),
    ("is_file", "file"),
    ("mkdir", "file"),
    ("move_uploaded_file", "file"),
    ("parse_ini_file", "file"),
    ("passthru", "process"),
    ("popen", "process"),
    ("proc_open", "process"),
    ("readfile", "file"),
    ("rename", "file"),
    ("rmdir", "file"),
    ("scandir", "file"),
    ("shell_exec", "process"),
    ("system", "process"),
    ("touch", "file"),
    ("unlink", "file"),
];

fn built_into_the_language(call: &CallFact, path: &str) -> Option<&'static str> {
    if !path.ends_with(".php") {
        return None;
    }
    let spoken = call.callee.trim_start_matches('\\');
    BUILT_INTO_PHP
        .binary_search_by(|(named, _)| named.cmp(&spoken))
        .ok()
        .map(|at| BUILT_INTO_PHP[at].1)
}

static WRITES_A_COOKIE: &[&str] = &["clearcookie", "cookie", "deletecookie", "setcookie"];
static READS_A_COOKIE: &[&str] = &["getcookie", "getcookies"];
static ASKED_OF_THE_COOKIES: &[(&str, &str)] =
    &[("delete", "write"), ("get", "read"), ("getall", "read"), ("remove", "write"), ("set", "write")];

fn a_cookie_kept(call: &CallFact) -> Option<&'static str> {
    let spoken = names::leaf(&call.callee).to_ascii_lowercase();
    let held = call.receiver.as_deref().map(|within| names::leaf(within).to_ascii_lowercase());
    if held.as_deref() == Some("cookies") {
        return ASKED_OF_THE_COOKIES
            .iter()
            .find(|(asked, _)| *asked == spoken)
            .map(|(_, operation)| *operation);
    }
    let answering = held.as_deref().is_none_or(|within| {
        matches!(within, "res" | "response" | "reply" | "ctx" | "context" | "c" | "event")
    });
    if !answering || call.literals.is_empty() && call.argument_count == 0 {
        return None;
    }
    if WRITES_A_COOKIE.contains(&spoken.as_str()) && (spoken != "cookie" || held.is_some()) {
        return Some("write");
    }
    READS_A_COOKIE.contains(&spoken.as_str()).then_some("read")
}

static OPENS_A_CONNECTION: &[&str] = &["EventSource", "WebSocket"];
static SAID_OVER_A_CONNECTION: &[&str] = &["close", "send"];

fn opens_a_connection(named: &str) -> bool {
    OPENS_A_CONNECTION.contains(&named)
}

fn over_a_connection<'a>(
    call: &'a CallFact,
    source: &str,
    connected: &HashMap<(u32, &str, &str), &'a str>,
) -> Option<(&'static str, &'a str)> {
    let within = call.receiver.as_deref().map(|held| held.strip_prefix("window.").unwrap_or(held));
    let opened = names::leaf(&call.callee);
    if opens_a_connection(opened) && within.is_none_or(|held| held == "window") {
        return Some(("connect", opened));
    }
    let over = *connected.get(&(call.file, source, names::root(within?)))?;
    let said = SAID_OVER_A_CONNECTION.iter().find(|said| **said == call.callee)?;
    Some((said, over))
}

static WHERE_FETCH_IS_THE_WEB: &[&str] =
    &["astro", "cjs", "cts", "js", "jsx", "mjs", "mts", "svelte", "ts", "tsx", "vue"];

fn fetch_is_the_web(path: &str) -> bool {
    path.rsplit_once('.')
        .is_some_and(|(_, spoken)| WHERE_FETCH_IS_THE_WEB.binary_search(&spoken).is_ok())
}

fn bare_exit(
    call: &CallFact,
    modules: &HashMap<(u32, String), String>,
    path: &str,
) -> Option<&'static str> {
    if call.callee == "fetch" {
        return fetch_is_the_web(path).then_some("api");
    }
    if let Some(specifier) = modules.get(&(call.file, call.callee.clone())) {
        return classify_exit(&call.callee, specifier, &call.callee);
    }
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
        None => module_kind(path).and(classify_exit(root, path, operation)),
    }
}

fn words_of(written: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut held = String::new();
    let mut before: Option<char> = None;
    for letter in written.chars() {
        let starts = letter.is_uppercase() && before.is_some_and(|was| was.is_lowercase());
        if !letter.is_alphanumeric() || starts {
            if !held.is_empty() {
                words.push(std::mem::take(&mut held));
            }
        }
        if letter.is_alphanumeric() {
            held.push(letter.to_ascii_lowercase());
        }
        before = Some(letter);
    }
    if !held.is_empty() {
        words.push(held);
    }
    words
}

static SAYS_WHO_YOU_ARE: &[&str] = &[
    "auth", "authed", "authenticate", "authenticated", "authentication", "authorize", "authorized", "jwt",
    "login", "oauth", "signin",
];
static SAYS_WHAT_YOU_MAY_DO: &[&str] = &[
    "acl", "admin", "authorization", "granted", "permission", "permissions", "policies", "policy",
    "preauthorize", "rbac", "role", "roles", "rolesallowed", "secured", "superuser",
];
static SAYS_HOW_OFTEN: &[&str] = &["limiter", "ratelimit", "throttle", "throttled", "throttler"];
static LETS_ANYONE_IN: &[&str] = &["allowanonymous", "anonymous", "public", "skipauth"];

fn guarding(written: &str) -> Option<&'static str> {
    let words = words_of(written);
    let has = |held: &[&str]| words.iter().any(|word| held.contains(&word.as_str()));
    let pair = |first: &str, second: &str| words.windows(2).any(|two| two[0] == first && two[1] == second);
    if has(SAYS_WHAT_YOU_MAY_DO) {
        return Some("authorization");
    }
    if has(SAYS_WHO_YOU_ARE) || pair("current", "user") || pair("logged", "in") || pair("signed", "in") {
        return Some("authentication");
    }
    if has(SAYS_HOW_OFTEN) || pair("rate", "limit") {
        return Some("rate_limiting");
    }
    None
}

static CARRIES_GUARDS: &[&str] = &["middleware", "useguards", "useinterceptors", "usemiddleware"];
static HANDS_OVER_A_GUARD: &[&str] = &["dependencies", "depends", "security"];

static NAMES_THE_PRINCIPAL: &[&str] = &["auth", "authed", "authenticated", "claims", "principal"];

fn names_the_principal(written: &str) -> bool {
    let words = words_of(written);
    words.iter().any(|word| NAMES_THE_PRINCIPAL.contains(&word.as_str()))
        || words.windows(2).any(|two| two[0] == "current" && matches!(two[1].as_str(), "user" | "account"))
}

fn declares_it_open(written: &str) -> bool {
    let words = words_of(written);
    words.windows(2).any(|two| two[0] == "public" && two[1] == "true")
        || words.iter().any(|word| LETS_ANYONE_IN.contains(&word.as_str()) && word != "public")
}

fn carries_guards(named: &str) -> bool {
    let spoken = names::leaf(named).to_ascii_lowercase();
    CARRIES_GUARDS.contains(&spoken.as_str())
}

fn hands_over_a_guard(written: &str) -> bool {
    words_of(written).first().is_some_and(|first| HANDS_OVER_A_GUARD.contains(&first.as_str()))
}

fn guards_written_on(node: &IndexNode, via: &'static str, found: &mut Vec<Guard>) {
    for decorator in &node.decorators {
        if decorator.arguments.iter().any(|held| declares_it_open(&held.value)) {
            continue;
        }
        let carries = guarding(&decorator.name).is_some() || carries_guards(&decorator.name);
        let mut spoken: Vec<&str> = vec![decorator.name.as_str()];
        spoken.extend(
            decorator
                .arguments
                .iter()
                .filter(|held| carries || (!held.literal && hands_over_a_guard(&held.value)))
                .map(|held| held.value.as_str()),
        );
        for written in spoken {
            if let Some(kind) = guarding(written) {
                found.push(Guard { name: written.to_string(), kind, via });
            }
        }
    }
    let Some(signature) = node.signature.as_ref() else { return };
    for parameter in &signature.parameters {
        if let Some(written) = parameter.type_annotation.as_deref()
            && names_the_principal(written)
        {
            found.push(Guard { name: written.to_string(), kind: "authentication", via: "parameter" });
        }
        if let Some(written) = parameter.default_value.as_deref().filter(|held| hands_over_a_guard(held))
            && let Some(kind) = guarding(written)
        {
            found.push(Guard { name: written.to_string(), kind, via: "parameter" });
        }
    }
}

fn lets_anyone_in(node: &IndexNode) -> bool {
    node.decorators.iter().any(|decorator| {
        let spoken = decorator.name.to_ascii_lowercase().replace(['_', '-'], "");
        LETS_ANYONE_IN.iter().any(|open| names::leaf(&spoken) == *open)
    })
}

pub fn guard(entry_points: &mut [EntryPoint], nodes: &[IndexNode]) {
    let by_id: HashMap<&str, &IndexNode> = nodes.iter().map(|node| (node.id.as_str(), node)).collect();
    for entry in entry_points.iter_mut() {
        let Some(handler) = by_id.get(entry.handler.as_str()) else { continue };
        let mut found = Vec::new();
        guards_written_on(handler, "decorator", &mut found);
        if let Some(owner) = handler.parent.as_deref().and_then(|parent| by_id.get(parent))
            && owner.kind.is_type()
        {
            let mut inherited = Vec::new();
            guards_written_on(owner, "owner", &mut inherited);
            if lets_anyone_in(handler) {
                inherited.retain(|held| held.kind == "rate_limiting");
            }
            found.extend(inherited);
        }
        found.dedup();
        entry.guards = found;
    }
}

pub fn kept_by_the_browser(kept: &[crate::model::Kept], files: &[String]) -> Vec<ExitPoint> {
    kept.iter()
        .enumerate()
        .map(|(position, held)| {
            let operation = if held.writes { "write" } else { "read" };
            ExitPoint {
                id: format!("exit:{}:{}:kept", files[held.file as usize], position),
                kind: "client_storage",
                name: format!("{operation} {}", held.place),
                source: held.unit.clone(),
                target: held.place.clone(),
                operation: operation.to_string(),
                file: held.file,
                line: held.line,
                awaited: false,
                addressed: None,
            }
        })
        .collect()
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
    locals: &[crate::model::LocalBinding],
) -> Derived {
    let connected: HashMap<(u32, &str, &str), &str> = locals
        .iter()
        .filter_map(|held| {
            let built = names::leaf(held.constructed.as_deref()?);
            opens_a_connection(built)
                .then_some(((held.file, held.unit.as_str(), held.name.as_str()), built))
        })
        .collect();
    let Resolution { modules, local, unique_units, call_origins, through, .. } = resolution;
    let known: HashSet<&str> = nodes.iter().map(|node| node.id.as_str()).collect();
    let mut stands_in: HashMap<&str, Vec<&'static str>> = HashMap::new();
    for ((file, _), specifier) in modules {
        let Some(kinds) = module_kind(specifier) else { continue };
        let holding = stands_in.entry(files[*file as usize].as_str()).or_default();
        for kind in kinds {
            if !holding.contains(kind) {
                holding.push(kind);
            }
        }
    }
    let mut entry_points = Vec::new();
    let mounted = mounted_under(calls);
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

    let named_of: HashMap<&str, &IndexNode> =
        nodes.iter().map(|node| (node.id.as_str(), node)).collect();
    for node in nodes {
        if let Some(registrar) = &node.callback_of {
            let label = node.registration_label.as_deref();
            if let Some(kind) = classify_registration(registrar, label) {
                let verb = names::leaf(registrar);
                let spoken = match (label, kind) {
                    (_, "schedule") => running_within(node, &named_of)
                        .unwrap_or(registrar.as_str())
                        .to_string(),
                    (Some(label), _) => label.to_string(),
                    (None, _) => registrar.clone(),
                };
                entry_points.push(EntryPoint {
                    id: format!("entry:{}", node.id),
                    kind,
                    name: spoken,
                    method: if kind == "http" {
                        Some(verb.to_ascii_uppercase())
                    } else {
                        None
                    },
                    path: if kind == "http" {
                        let base = registered_on_a_router(registrar)
                            .then(|| mounted.get(&node.file))
                            .flatten();
                        match (base, label) {
                            (Some(base), Some(label)) => Some(join_paths(base, label)),
                            (Some(base), None) => Some(base.clone()),
                            (None, label) => label.map(str::to_string),
                        }
                    } else {
                        None
                    },
                    handler: node.id.clone(),
                    file: node.file,
                    line: node.span.line,
                    guards: Vec::new(),
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
                    .and_then(|parent| base_paths.get(parent))
                    .or_else(|| {
                        registered_on_a_router(&decorator.name)
                            .then(|| mounted.get(&node.file))
                            .flatten()
                    });
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
                    guards: Vec::new(),
                    registrar: decorator.name.clone(),
                });
            }
        }
    }

    let mut by_name: HashMap<&str, Vec<&IndexNode>> = HashMap::new();
    let mut above: HashMap<&str, Vec<&str>> = HashMap::new();
    for node in nodes {
        if node.kind.is_type() {
            by_name.entry(node.name.as_str()).or_default().push(node);
        }
    }
    let unique_type: HashMap<&str, &IndexNode> = by_name
        .iter()
        .filter(|(_, found)| found.len() == 1)
        .map(|(name, found)| (*name, found[0]))
        .collect();
    for fact in type_references {
        if !matches!(fact.kind, EdgeKind::Extends | EdgeKind::Implements) {
            continue;
        }
        above.entry(fact.source.as_str()).or_default().push(fact.name.as_str());
    }
    fn supertype_base(
        name: &str,
        reaches: &HashMap<&str, &'static EntryBase>,
    ) -> Option<&'static EntryBase> {
        entry_base(name)
            .or_else(|| reaches.get(names::leaf(name)).copied())
    }
    let mut reaches: HashMap<&str, &'static EntryBase> = HashMap::new();
    loop {
        let mut settled = false;
        for node in nodes {
            if !node.kind.is_type() || reaches.contains_key(node.name.as_str()) {
                continue;
            }
            let found = above
                .get(node.id.as_str())
                .into_iter()
                .flatten()
                .find_map(|name| supertype_base(name, &reaches));
            if let Some(found) = found {
                reaches.insert(node.name.as_str(), found);
                settled = true;
            }
        }
        if !settled {
            break;
        }
    }
    let inherits = |node: &IndexNode| -> Option<&'static EntryBase> {
        above
            .get(node.id.as_str())
            .into_iter()
            .flatten()
            .find_map(|name| supertype_base(name, &reaches))
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
                guards: Vec::new(),
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
                guards: Vec::new(),
                registrar: found.base.to_string(),
            });
        }
    }

    let declared: HashSet<&str> = nodes
        .iter()
        .filter(|node| node.kind.is_type() || matches!(node.kind, NodeKind::Function | NodeKind::Method))
        .flat_map(|node| [node.name.as_str(), names::leaf(&node.name)])
        .collect();
    let mut owning: HashMap<(u32, u32), &str> = HashMap::new();
    let mut acting: HashMap<(u32, u32), &str> = HashMap::new();
    for registration in registrations {
        let at = (registration.file, registration.line);
        match registration.handler.strip_prefix(':') {
            Some(action) if !action.is_empty() => {
                acting.insert(at, action);
            }
            _ if registration
                .handler
                .chars()
                .next()
                .is_some_and(|held| held.is_ascii_uppercase()) =>
            {
                owning.insert(at, registration.handler.as_str());
            }
            _ => {}
        }
    }
    let acted: HashMap<(u32, u32), String> = acting
        .into_iter()
        .filter_map(|(at, action)| {
            let owner = owning.get(&at)?;
            let owner = names::leaf(owner);
            let held = members.get(
                nodes
                    .iter()
                    .find(|node| node.kind.is_type() && names::leaf(&node.name) == owner)?
                    .id
                    .as_str(),
            )?;
            let member = held.iter().find(|member| member.name == action)?;
            Some((at, member.id.clone()))
        })
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
        let Some(handler) = acted
            .get(&(registration.file, registration.line))
            .cloned()
            .or_else(|| known
            .contains(registration.handler.as_str())
            .then(|| registration.handler.clone()))
            .or_else(|| local
            .get(&(registration.file, registration.handler.clone()))
            .or_else(|| local.get(&(registration.file, leaf.to_string())))
            .or_else(|| unique_units.get(leaf))
            .cloned()
            .or_else(|| {
                unique_type
                    .get(leaf)
                    .filter(|found| {
                        same_language(
                            &files[registration.file as usize],
                            &files[found.file as usize],
                        )
                    })
                    .map(|found| found.id.clone())
            })
            .or_else(|| {
                declared.contains(leaf).then(|| files[registration.file as usize].clone())
            }))
        else {
            continue;
        };
        if !registered.insert((registration.file, registration.line)) {
            continue;
        }
        let verb = names::leaf(&registration.registrar);
        let (label_method, path) = split_label(&registration.label);
        let path = match registered_on_a_router(&registration.registrar)
            .then(|| mounted.get(&registration.file))
            .flatten()
        {
            Some(base) => join_paths(base, &path),
            None => path,
        };
        if kind == "http" && handler == files[registration.file as usize] {
            let stands_for_itself = entry_points.iter().any(|entry| {
                entry.kind == "http"
                    && entry.file == registration.file
                    && entry.path.as_deref() == Some(path.as_str())
            });
            if stands_for_itself {
                continue;
            }
        }
        let spoken = match kind == "schedule" {
            true => named_of
                .get(handler.as_str())
                .and_then(|node| running_within(node, &named_of))
                .unwrap_or(registration.label.as_str())
                .to_string(),
            false => registration.label.clone(),
        };
        entry_points.push(EntryPoint {
            id: format!("entry:{handler}:{}", registration.label),
            kind,
            name: spoken,
            method: match kind == "http" {
                true => label_method
                    .or_else(|| mapped_method(verb))
                    .or_else(|| {
                        HTTP_METHODS
                            .binary_search(&verb.to_ascii_lowercase().as_str())
                            .is_ok()
                            .then(|| verb.to_ascii_uppercase())
                    }),
                false => None,
            },
            path: if kind == "http" { Some(path) } else { None },
            handler,
            file: registration.file,
            line: registration.line,
            guards: Vec::new(),
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
                guards: Vec::new(),
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
            guards: Vec::new(),
            registrar: node.name.clone(),
        });
    }

    let mut exit_points = Vec::new();
    let mut reached_through: Vec<String> = Vec::new();
    for (position, call) in calls.iter().enumerate() {
        let Some(source) = &call.caller else { continue };
        if let Some((operation, table)) = asked_of_a_table(call) {
            reached_through.push(call.receiver.clone().unwrap_or_default());
            exit_points.push(ExitPoint {
                id: format!("exit:{}:{}:sql", files[call.file as usize], position),
                kind: "database",
                name: format!("{operation} {table}"),
                source: source.clone(),
                target: table,
                operation,
                file: call.file,
                line: call.line,
                awaited: call.context.awaited,
                addressed: None,
            });
        }
        if let Some(operation) = a_cookie_kept(call) {
            reached_through.push(call.receiver.clone().unwrap_or_default());
            exit_points.push(ExitPoint {
                id: format!("exit:{}:{}:cookie", files[call.file as usize], position),
                kind: "client_storage",
                name: format!("{operation} cookie"),
                source: source.clone(),
                target: "cookie".to_string(),
                operation: operation.to_string(),
                file: call.file,
                line: call.line,
                awaited: call.context.awaited,
                addressed: None,
            });
            continue;
        }
        if let Some((operation, over)) = over_a_connection(call, source, &connected) {
            reached_through.push(call.receiver.clone().unwrap_or_default());
            exit_points.push(ExitPoint {
                id: format!("exit:{}:{}:connection", files[call.file as usize], position),
                kind: "network",
                name: format!("{operation} {}", call.callee),
                source: source.clone(),
                target: over.to_string(),
                operation: operation.to_string(),
                file: call.file,
                line: call.line,
                awaited: call.context.awaited,
                addressed: addressed_at(call),
            });
            continue;
        }
        let Some(receiver) = call.receiver.as_deref() else {
            let Some(kind) = bare_exit(call, modules, &files[call.file as usize])
                .or_else(|| built_into_the_language(call, &files[call.file as usize]))
            else {
                continue;
            };
            let origin = modules
                .get(&(call.file, call.callee.clone()))
                .cloned()
                .unwrap_or_else(|| call.callee.clone());
            reached_through.push(String::new());
            exit_points.push(ExitPoint {
                id: format!("exit:{}:{}", files[call.file as usize], position),
                kind,
                name: call.callee.clone(),
                source: source.clone(),
                target: origin,
                operation: call.callee.trim_start_matches('\\').to_string(),
                file: call.file,
                line: call.line,
                awaited: call.context.awaited,
            addressed: addressed_at(call),
            });
            continue;
        };
        let binding = names::root(receiver);
        if receiver.contains('.') && reads_a_data_member(receiver) {
            continue;
        }
        if let Some(kind) = manager_exit(receiver, names::leaf(&call.callee))
            .or_else(|| names_a_store(names::leaf(&call.callee)).then_some("database"))
        {
            let operation = names::leaf(&call.callee);
            reached_through.push(receiver.to_string());
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
            addressed: addressed_at(call),
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
            None if module_kind(binding).is_some() => binding,
            None => match through
                .get(&(call.file, receiver.to_string()))
                .or_else(|| through.get(&(call.file, binding.to_string())))
                .and_then(|held| stands_in.get(held.as_str()))
                .and_then(|kinds| reaching(kinds, &names::leaf(&call.callee).to_ascii_lowercase()))
            {
                Some(kind) => {
                    let operation = names::leaf(&call.callee);
                    reached_through.push(receiver.to_string());
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
            addressed: addressed_at(call),
                    });
                    continue;
                }
                None => continue,
            },
        };
        let Some(kind) =
            classify_reached(binding, origin, &call.callee, stands_in.get(origin).map(Vec::as_slice))
        else {
            continue;
        };
        let receiver = receiver.to_string();
        let operation = names::leaf(&call.callee);
        reached_through.push(receiver.to_string());
        exit_points.push(ExitPoint {
            id: format!("exit:{}:{}", files[call.file as usize], position),
            kind,
            name: format!("{receiver}.{operation}"),
            source: source.clone(),
            target: origin.to_string(),
            operation: operation.to_string(),
            file: call.file,
            line: call.line,
            awaited: call.context.awaited,
            addressed: addressed_at(call),
        });
    }

    entry_points.sort_by(|left, right| left.id.cmp(&right.id));
    entry_points.dedup_by(|left, right| left.id == right.id);
    let mut at_site: HashMap<(u32, u32), Vec<usize>> = HashMap::new();
    for (at, exit) in exit_points.iter().enumerate() {
        at_site.entry((exit.file, exit.line)).or_default().push(at);
    }
    let mut counted = Vec::with_capacity(exit_points.len());
    for (at, exit) in exit_points.iter().enumerate() {
        let receiver = reached_through[at].as_str();
        let chained = receiver.contains('(')
            && at_site
                .get(&(exit.file, exit.line))
                .into_iter()
                .flatten()
                .any(|other| {
                    *other != at
                        && !reached_through[*other].is_empty()
                        && reached_through[*other].len() < receiver.len()
                        && receiver.starts_with(reached_through[*other].as_str())
                });
        counted.push(!chained);
    }
    let mut keep = counted.iter();
    exit_points.retain(|_| *keep.next().unwrap_or(&true));

    exit_points.sort_by(|left, right| left.id.cmp(&right.id));
    entry_points.retain(|entry| entry.kind != "http" || !is_test(&files[entry.file as usize]));
    for entry in entry_points.iter_mut() {
        if entry.kind != "http" {
            continue;
        }
        if let Some(path) = entry.path.as_mut()
            && !path.starts_with('/')
        {
            path.insert(0, '/');
        }
        if !entry.name.starts_with('/') && entry.name.contains('/') {
            entry.name.insert(0, '/');
        }
    }
    Derived { entry_points, exit_points }
}

#[cfg(test)]
mod tests {
    use super::*;

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
            ("KEPT_OPERATIONS", KEPT_OPERATIONS),
            ("PROCEDURE_REGISTRARS", PROCEDURE_REGISTRARS),
            ("RECURRING", RECURRING),
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

    #[test]
    fn a_method_is_a_method_however_the_language_spells_it() {
        assert_eq!(classify_registration("app.Get", Some("/users")), Some("http"));
        assert_eq!(classify_registration("app.get", Some("/users")), Some("http"));
        assert_eq!(classify_registration("e.GET", Some("/users")), Some("http"));
        assert_eq!(classify_registration("api.MapPost", Some("/items")), Some("http"));
    }

    #[test]
    fn a_module_that_wraps_another_reaches_what_it_wraps() {
        assert_eq!(
            classify_reached("prisma", "packages/prisma/index.ts", "booking.findMany", Some(DATABASE)),
            Some("database")
        );
        assert_eq!(
            classify_reached("prisma", "packages/prisma/index.ts", "format", Some(DATABASE)),
            None
        );
    }

    #[test]
    fn fetch_is_the_web_only_where_the_web_is_written() {
        assert!(super::WHERE_FETCH_IS_THE_WEB.windows(2).all(|held| held[0] < held[1]));
        assert!(super::fetch_is_the_web("src/api.ts"));
        assert!(super::fetch_is_the_web("app/components/Feed.svelte"));
        assert!(!super::fetch_is_the_web("app/models/account.rb"));
        assert!(!super::fetch_is_the_web("lib/client.py"));
    }

    #[test]
    fn what_php_builds_in_is_sorted() {
        assert!(super::BUILT_INTO_PHP.windows(2).all(|held| held[0].0 < held[1].0));
    }

    #[test]
    fn what_is_never_a_table_is_sorted() {
        assert!(super::NEVER_A_TABLE.windows(2).all(|held| held[0] < held[1]));
        assert!(super::SAID_BY_A_CLAUSE.windows(2).all(|held| held[0] < held[1]));
    }

    #[test]
    fn a_sentence_that_opens_like_sql_is_not_sql() {
        use super::a_statement_about;
        assert_eq!(a_statement_about("Update the user profile before saving"), None);
        assert_eq!(a_statement_about("Select a table from FCC filings"), None);
        assert_eq!(a_statement_about("Delete this row"), None);
    }

    #[test]
    fn a_statement_names_the_table_it_asks_of() {
        use super::a_statement_about;
        let said = |held: &str| a_statement_about(held).map(|(verb, named)| (verb, named));
        assert_eq!(
            said("SELECT id, name FROM token_metrics WHERE id = $1"),
            Some(("select".to_string(), "token_metrics".to_string()))
        );
        assert_eq!(
            said("INSERT INTO public.chat_sessions (id) VALUES ($1)"),
            Some(("insert".to_string(), "chat_sessions".to_string()))
        );
        assert_eq!(
            said("UPDATE sync_status SET ran_at = now()"),
            Some(("update".to_string(), "sync_status".to_string()))
        );
        assert_eq!(
            said("DELETE FROM whale_transactions WHERE id = $1"),
            Some(("delete".to_string(), "whale_transactions".to_string()))
        );
        assert_eq!(
            said("SELECT row_to_json(x)\n  FROM\n  discovered_tokens x"),
            Some(("select".to_string(), "discovered_tokens".to_string()))
        );
    }

    #[test]
    fn a_statement_reads_past_what_it_cannot_name() {
        use super::a_statement_about;
        assert_eq!(a_statement_about("SELECT 1 FROM public.${table} LIMIT 1"), None);
        assert_eq!(
            a_statement_about("SELECT count(*) FROM (SELECT 1 FROM orders) t"),
            Some(("select".to_string(), "orders".to_string()))
        );
        assert_eq!(a_statement_about("node"), None);
        assert_eq!(a_statement_about("https://api.example.com/v1/prices"), None);
    }
}
