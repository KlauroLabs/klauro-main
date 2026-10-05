use rayon::prelude::*;
use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};

use serde::Serialize;

use crate::model::*;
use crate::names;
use crate::resolve::Resolution;
use crate::paths::{is_test, is_unambiguously_test};

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Unshipped {
    pub role: &'static str,
    pub basis: &'static str,
    pub evidence: String,
}

#[derive(Debug, Clone, Serialize)]
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unshipped: Option<Unshipped>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service: Option<String>,
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

fn registered_on_a_router_like(registrar: &str) -> bool {
    let Some(at) = registrar.rfind('.') else { return false };
    let receiver = &registrar[..at];
    if ROUTERS.binary_search(&receiver).is_ok() {
        return true;
    }
    let root = receiver.split(['.', '(']).next().unwrap_or(receiver).trim();
    root.to_ascii_lowercase().contains("router")
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

static STARTS_A_CONTINUATION: &[&str] = &[
    "connect",
    "create_subprocess_exec",
    "create_subprocess_shell",
    "createconnection",
    "createreadstream",
    "createwritestream",
    "eventsource",
    "execfile",
    "execfilesync",
    "fork",
    "open_connection",
    "popen",
    "request",
    "spawn",
    "spawnsync",
    "websocket",
    "worker",
];

fn starts_a_continuation(named: &str) -> bool {
    STARTS_A_CONTINUATION.binary_search(&names::leaf(named).to_ascii_lowercase().as_str()).is_ok()
}

fn continues_a_started_operation(
    registrar: &str,
    file: u32,
    unit: &str,
    locals_by_unit: &HashMap<(u32, &str, &str), &crate::model::LocalBinding>,
) -> bool {
    let Some(at) = registrar.rfind('.') else { return false };
    let receiver = &registrar[..at];
    let root = names::root(receiver);
    let called_inline = root.len() < receiver.len() && receiver[root.len()..].starts_with('(');
    if called_inline && starts_a_continuation(root) {
        return true;
    }
    locals_by_unit
        .get(&(file, unit, root))
        .and_then(|local| local.from_call.as_deref().or(local.constructed.as_deref()))
        .is_some_and(starts_a_continuation)
}

fn running_within<'a>(node: &'a IndexNode, named_of: &HashMap<&str, &'a IndexNode>) -> Option<&'a str> {
    let runs = |held: &IndexNode| {
        matches!(
            held.kind,
            NodeKind::Function | NodeKind::Method | NodeKind::Constructor | NodeKind::Class
        ) && !held.name.contains('#')
    };
    let mut climbed: HashSet<&str> = HashSet::from_iter([node.id.as_str()]);
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

pub(crate) const DISPATCH_CONST_MARKER: &str = "\u{1}const:";

static MCP_TOOL_REGISTRARS: &[&str] = &["addtool", "registertool", "tool"];

fn named_by_an_mcp_sdk(specifier: &str) -> bool {
    let specifier = specifier.trim_start_matches("./").trim_start_matches("node:");
    specifier == "@modelcontextprotocol/sdk"
        || specifier.starts_with("@modelcontextprotocol/sdk/")
        || specifier == "mcp"
        || specifier.starts_with("mcp.")
        || specifier == "fastmcp"
        || specifier.starts_with("fastmcp.")
        || specifier == "rmcp"
        || specifier.starts_with("rmcp::")
        || specifier.contains("mark3labs/mcp-go")
        || specifier == "ModelContextProtocol"
        || specifier.starts_with("ModelContextProtocol.")
}

fn files_that_speak_the_mcp_sdk(imports: &[crate::model::ImportFact]) -> HashSet<u32> {
    imports
        .iter()
        .filter(|import| named_by_an_mcp_sdk(&import.specifier))
        .map(|import| import.file)
        .collect()
}

fn named_by_an_mcp_tool_decorator(decorator: &Decorator) -> bool {
    let leaf = names::leaf(&decorator.name).to_ascii_lowercase();
    matches!(leaf.as_str(), "tool" | "mcpservertool" | "call_tool" | "calltool")
}

fn overridden_by_the_decorator(decorator: &Decorator) -> Option<String> {
    decorator
        .arguments
        .iter()
        .find(|argument| argument.literal)
        .map(|argument| argument.value.clone())
}

fn classify_registration(registrar: &str, label: Option<&str>, speaks_the_mcp_sdk: bool) -> Option<&'static str> {
    match registrar.strip_prefix("dispatch:") {
        Some("ui") => return Some("ui"),
        Some("event") => return Some("event"),
        Some("ipc") => return Some("ipc"),
        Some("tool") => return Some("tool"),
        Some("cli") => return Some("cli"),
        _ => {}
    }
    if speaks_the_mcp_sdk && MCP_TOOL_REGISTRARS.contains(&names::leaf(registrar).to_ascii_lowercase().as_str()) {
        return Some("tool");
    }
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

pub(crate) const HAND_ROLLED_DISPATCH_REGISTRAR: &str = "dispatch:ipc";
pub(crate) const HAND_ROLLED_CLI_REGISTRAR: &str = "dispatch:cli";

fn rust_module_of(path: &str) -> &str {
    let mut segments: Vec<&str> = path.split('/').collect();
    let Some(file) = segments.pop() else { return path };
    let stem = file.strip_suffix(".rs").unwrap_or(file);
    match stem {
        "mod" | "lib" | "main" => segments.last().copied().unwrap_or(stem),
        _ => stem,
    }
}

fn called_unit<'a>(
    call: &'a CallFact,
    known: &HashSet<&str>,
    unique_units: &'a HashMap<String, String>,
    by_file_and_name: &HashMap<(u32, &'a str), &'a str>,
    by_module_and_name: &HashMap<(&'a str, &'a str), &'a str>,
) -> Option<&'a str> {
    if call.receiver.is_some() {
        return None;
    }
    if known.contains(call.callee.as_str()) {
        return Some(call.callee.as_str());
    }
    match call.callee.rsplit_once("::") {
        None => {
            if let Some(found) = by_file_and_name.get(&(call.file, call.callee.as_str())) {
                return Some(*found);
            }
        }
        Some((held, leaf)) => {
            let module = held.rsplit("::").next().filter(|held| !matches!(*held, "crate" | "self" | "super"));
            if let Some(module) = module
                && let Some(found) = by_module_and_name.get(&(module, leaf))
            {
                return Some(*found);
            }
        }
    }
    unique_units.get(names::leaf(&call.callee)).map(String::as_str)
}

fn keep_hand_rolled_dispatch_only_when_served(
    entry_points: &mut Vec<EntryPoint>,
    calls: &[CallFact],
    nodes: &[IndexNode],
    files: &[String],
    known: &HashSet<&str>,
    unique_units: &HashMap<String, String>,
) {
    if !entry_points.iter().any(|entry| entry.registrar == HAND_ROLLED_DISPATCH_REGISTRAR) {
        return;
    }
    let module_of: Vec<&str> = files.iter().map(|path| rust_module_of(path)).collect();
    let mut by_module_and_name: HashMap<(&str, &str), &str> = HashMap::default();
    let mut by_file_and_name: HashMap<(u32, &str), &str> = HashMap::default();
    for node in nodes {
        if matches!(node.kind, NodeKind::Function | NodeKind::Method) {
            by_module_and_name.entry((module_of[node.file as usize], node.name.as_str())).or_insert(node.id.as_str());
            by_file_and_name.entry((node.file, node.name.as_str())).or_insert(node.id.as_str());
        }
    }
    let mut calls_from: HashMap<&str, Vec<&str>> = HashMap::default();
    for call in calls {
        let Some(caller) = call.caller.as_deref() else { continue };
        let Some(target) = called_unit(call, known, unique_units, &by_file_and_name, &by_module_and_name) else { continue };
        calls_from.entry(caller).or_default().push(target);
    }
    let mut children_of: HashMap<&str, Vec<&str>> = HashMap::default();
    for node in nodes {
        if let Some(parent) = node.parent.as_deref() {
            children_of.entry(parent).or_default().push(node.id.as_str());
        }
    }
    let seeds: Vec<String> = entry_points
        .iter()
        .filter(|entry| {
            entry.registrar != HAND_ROLLED_DISPATCH_REGISTRAR && matches!(entry.kind, "http" | "ipc")
        })
        .map(|entry| entry.handler.clone())
        .collect();
    let mut frontier: Vec<&str> = seeds.iter().map(String::as_str).collect();
    let mut served: HashSet<&str> = frontier.iter().copied().collect();
    while let Some(current) = frontier.pop() {
        let reached = calls_from.get(current).into_iter().flatten().chain(children_of.get(current).into_iter().flatten());
        for callee in reached {
            if served.insert(*callee) {
                frontier.push(*callee);
            }
        }
    }
    entry_points
        .retain(|entry| entry.registrar != HAND_ROLLED_DISPATCH_REGISTRAR || served.contains(entry.handler.as_str()));
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
    if lowered == "path" && (verb != "Path" || (qualified && !decorator.name.contains("ws.rs"))) {
        return None;
    }
    if matches!(lowered.as_str(), "controller" | "path" | "request" | "route") {
        let method = decorator
            .arguments
            .iter()
            .map(|argument| argument.value.trim().trim_matches(['"', '\'']).to_ascii_uppercase())
            .find(|value| HTTP_METHODS.binary_search(&value.to_ascii_lowercase().as_str()).is_ok())
            .unwrap_or_else(|| "ANY".to_string());
        return Some(("http", method, path));
    }
    if verb == "expose" {
        let method = decorator
            .arguments
            .iter()
            .map(|argument| argument.value.trim().trim_matches(['"', '\'']).to_ascii_uppercase())
            .find(|value| HTTP_METHODS.binary_search(&value.to_ascii_lowercase().as_str()).is_ok())
            .unwrap_or_else(|| "GET".to_string());
        return path.map(|path| ("http", method, Some(path)));
    }
    if HTTP_METHODS.binary_search(&lowered.as_str()).is_ok() {
        if !qualified && verb.starts_with(char::is_lowercase) {
            return None;
        }
        return Some(("http", lowered.to_ascii_uppercase(), path));
    }
    if lowered == "command" && decorator.name.to_ascii_lowercase().contains("tauri") {
        return Some(("ipc", "IPC".to_string(), None));
    }
    match lowered.as_str() {
        "eventpattern" | "onevent" | "subscribe" | "eventlistener" | "kafkalistener"
        | "rabbitlistener" | "streamlistener" => Some(("event", lowered, None)),
        "messagepattern" | "jmslistener" | "sqslistener" => Some(("message", lowered, None)),
        "cron" | "interval" | "timeout" | "scheduled" => Some(("schedule", lowered, None)),
        "sharedtask" | "shared_task" | "periodictask" | "periodic_task" => Some(("background", lowered, None)),
        "task" | "actor" if qualified => Some(("background", lowered, None)),
        "resolvefield" | "schemamapping" | "querymapping" | "mutationmapping"
        | "subscriptionmapping" => Some(("graphql", lowered, None)),
        "grpcmethod" | "grpcstreammethod" | "grpcservice" => Some(("rpc", lowered, None)),
        "command" | "consolecommand" => Some(("cli", lowered, None)),
        "fact" | "theory" | "test" | "testcase" | "testmethod" | "parameterizedtest"
        | "benchmark" => Some(("test", lowered, None)),
        _ => None,
    }
}

fn exposed_under(class: &IndexNode, written_in: &HashMap<&str, Vec<&crate::model::LocalBinding>>) -> Option<String> {
    let held = written_in.get(class.id.as_str())?;
    let named = |wanted: &str| held.iter().find(|local| local.name == wanted).and_then(|local| local.written.clone());
    named("route_base")
        .filter(|base| base.starts_with('/'))
        .or_else(|| named("resource_name").map(|resource| format!("/api/v1/{resource}")))
}

static ROUTES_BY_CONVENTION: &[&str] = &[
    "MapControllerRoute", "MapDefaultControllerRoute", "MapRoute", "UseMvcWithDefaultRoute",
];
static RETURNS_AN_ACTION: &[&str] = &["ActionResult", "IActionResult", "ViewResult", "RedirectResult"];

fn controller_stem(node: &IndexNode, named_of: &HashMap<&str, &IndexNode>) -> Option<String> {
    let owner = node.parent.as_deref().and_then(|parent| named_of.get(parent))?;
    let stem = owner.name.strip_suffix("Controller").filter(|stem| !stem.is_empty())?;
    Some(stem.to_string())
}

fn conventional_path(node: &IndexNode, named_of: &HashMap<&str, &IndexNode>) -> Option<String> {
    let stem = controller_stem(node, named_of)?;
    let action = node
        .decorators
        .iter()
        .find(|decorator| names::leaf(&decorator.name) == "ActionName")
        .and_then(|decorator| decorator.arguments.first())
        .map(|argument| argument.value.clone())
        .unwrap_or_else(|| node.name.trim_end_matches("Async").to_string());
    Some(format!("/{stem}/{action}"))
}

fn conventional_actions(
    nodes: &[IndexNode],
    named_of: &HashMap<&str, &IndexNode>,
    found: &[EntryPoint],
) -> Vec<EntryPoint> {
    let served: HashSet<&str> = found.iter().map(|entry| entry.handler.as_str()).collect();
    nodes
        .iter()
        .filter(|node| node.kind == NodeKind::Method && node.modifiers.exported && !node.modifiers.is_static)
        .filter(|node| !served.contains(node.id.as_str()))
        .filter(|node| !node.decorators.iter().any(|decorator| names::leaf(&decorator.name) == "NonAction"))
        .filter(|node| {
            node.signature
                .as_ref()
                .and_then(|signature| signature.return_type.as_deref())
                .is_some_and(|returned| RETURNS_AN_ACTION.iter().any(|action| returned.contains(action)))
        })
        .filter_map(|node| {
            let path = conventional_path(node, named_of)?;
            Some(EntryPoint {
                id: format!("entry:{}:convention", node.id),
                kind: "http",
                name: path.clone(),
                method: Some("GET".to_string()),
                path: Some(path),
                handler: node.id.clone(),
                file: node.file,
                line: node.span.line,
                guards: Vec::new(),
                registrar: "convention".to_string(),
                unshipped: None,
            })
        })
        .collect()
}

fn implements_a_generated_service<'n>(base: &'n str) -> Option<&'n str> {
    let base = names::leaf(base);
    base.strip_prefix("Unimplemented")
        .and_then(|held| held.strip_suffix("Server"))
        .or_else(|| base.strip_suffix("ImplBase"))
        .or_else(|| base.strip_suffix("Servicer"))
        .or_else(|| base.strip_suffix("Base"))
        .filter(|held| !held.is_empty())
}

fn served_over_grpc(nodes: &[IndexNode], type_references: &[TypeReferenceFact], files: &[String]) -> Vec<EntryPoint> {
    let mut declared: HashMap<&str, HashSet<String>> = HashMap::default();
    let mut members: HashMap<&str, Vec<&IndexNode>> = HashMap::default();
    for node in nodes {
        if let Some(parent) = node.parent.as_deref() {
            members.entry(parent).or_default().push(node);
        }
    }
    for node in nodes {
        let in_a_contract = files.get(node.file as usize).is_some_and(|path| path.ends_with(".proto"));
        if !in_a_contract || node.kind != NodeKind::Interface {
            continue;
        }
        let rpcs = members
            .get(node.id.as_str())
            .into_iter()
            .flatten()
            .map(|member| member.name.to_ascii_lowercase())
            .collect();
        declared.insert(node.name.as_str(), rpcs);
    }
    if declared.is_empty() {
        return Vec::new();
    }
    let mut found = Vec::new();
    for reference in type_references.iter().filter(|reference| matches!(reference.kind, EdgeKind::Extends | EdgeKind::Implements)) {
        let Some(service) = implements_a_generated_service(&reference.name) else { continue };
        let Some(rpcs) = declared.get(service) else { continue };
        for member in members.get(reference.source.as_str()).into_iter().flatten() {
            if !member.kind.is_unit() {
                continue;
            }
            let spoken = member.name.trim_end_matches("Async").to_ascii_lowercase();
            if !rpcs.contains(&spoken) {
                continue;
            }
            let path = format!("/{service}/{}", member.name.trim_end_matches("Async"));
            found.push(EntryPoint {
                id: format!("entry:{}:grpc", member.id),
                kind: "rpc",
                name: path.clone(),
                method: None,
                path: Some(path),
                handler: member.id.clone(),
                file: member.file,
                line: member.span.line,
                guards: Vec::new(),
                registrar: reference.name.clone(),
                unshipped: None,
            });
        }
    }
    found
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
static WORK_MEMBERS: &[&str] = &["createWork", "doWork"];
static JOB_MEMBERS: &[&str] = &["perform"];
static MIXES_IN: &[&str] = &["extend", "include", "prepend"];

static ENTRY_BASES: &[EntryBase] = &[
    base("ActiveJob::Base", "background", JOB_MEMBERS),
    base("AppCompatActivity", "lifecycle", &[]),
    base("ApplicationJob", "background", JOB_MEMBERS),
    base("Application", "lifecycle", &[]),
    base("BackgroundService", "background", &["ExecuteAsync"]),
    base("BaseCommand", "cli", COMMAND_MEMBERS),
    base("BroadcastReceiver", "lifecycle", &[]),
    base("ComponentActivity", "lifecycle", &[]),
    base("CoroutineWorker", "background", WORK_MEMBERS),
    base("Fragment", "lifecycle", &[]),
    base("IHostedService", "background", &["StartAsync"]),
    base("ListenableWorker", "background", WORK_MEMBERS),
    base("Mutation", "graphql", GRAPHQL_MEMBERS),
    base("ObjectType", "graphql", GRAPHQL_MEMBERS),
    base("RxWorker", "background", WORK_MEMBERS),
    base("Sidekiq::Job", "background", JOB_MEMBERS),
    base("Sidekiq::Worker", "background", JOB_MEMBERS),
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
    let written = name.trim().replace('=', "::");
    if let Some(found) = ENTRY_BASES.iter().find(|entry| entry.base.contains("::") && entry.base == written) {
        return Some(found);
    }
    let leaf = names::leaf(name);
    ENTRY_BASES.iter().find(|entry| !entry.base.contains("::") && entry.base == leaf)
}

static FILE_OPERATIONS: &[&str] = &[
    "appendalltext", "appendfile", "appendfilesync", "canonicalize", "contentsofdirectory",
    "copy", "copyfile", "copyitem", "copysync", "create", "create_dir", "create_dir_all",
    "createdirectory", "createreadstream", "createwritestream", "delete", "deletefile",
    "emptydir", "ensuredir", "ensurefile", "enumeratefiles", "exists", "exists_sync",
    "existssync", "getdirectories", "getfiles", "hard_link", "lstat", "metadata", "mkdir",
    "mkdirall", "move", "open", "openfile", "openread", "openwrite", "outputfile", "outputjson",
    "outputjsonsync", "pathexists", "read_dir", "read_link", "read_to_end", "read_to_string",
    "readall", "readallbytes", "readalllines", "readalltext", "readalltextasync", "readdir",
    "readfile", "readfilesync", "readjson", "readjsonsync", "readlink", "remove", "remove_dir",
    "remove_dir_all", "remove_file", "removeall", "removeitem", "rename", "rm", "rmdir",
    "set_permissions", "stat", "symlink_metadata", "unlink", "write_all", "writeallbytes",
    "writealltext", "writealltextasync", "writefile", "writefilesync", "writejson",
    "writejsonsync",
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
static KEPT_ON_THE_DEVICE: &[&str] = &[
    "AsyncStorage", "DataStore", "FlowSettings", "NSUserDefaults", "ObservableSettings", "SharedPreferences",
    "SuspendSettings", "UserDefaults",
];
static KEEPS_A_VALUE: &[&str] = &["apply", "clear", "commit", "edit", "put", "remove", "removeitem", "removeobject", "set", "setitem", "setvalue"];

static DEVICE_STORAGE_PACKAGES: &[&str] = &[
    "@react-native-async-storage/async-storage", "android.content.SharedPreferences", "androidx.datastore",
    "androidx.preference", "com.russhwolf.settings", "shared_preferences",
];

fn kept_on_the_device(origin: &str, operation: &str) -> bool {
    let typed = origin.rsplit(['.', '/', ':']).next().unwrap_or(origin);
    let stored = KEPT_ON_THE_DEVICE.contains(&typed)
        || DEVICE_STORAGE_PACKAGES.iter().any(|package| origin == *package || origin.starts_with(&format!("{package}.")) || origin.starts_with(&format!("{package}/")));
    stored
        && (KEEPS_A_VALUE.contains(&operation) || operation.starts_with("put") || operation.starts_with("set") || operation.starts_with("get"))
}
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

static NEVER_REACHES_THE_SERVICE: &[&str] = &[
    "addlistener", "configure", "createbatch", "createclient", "createcommand", "createconnection", "getcollection",
    "getdatabase", "getservice", "init", "off", "on", "once", "removealllisteners", "removelistener", "setup",
];

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
    if CLIENT_STORAGE_GLOBALS.binary_search(&binding).is_ok() || kept_on_the_device(origin, operation) {
        return Some("client_storage");
    }
    if let Some(reaches) = module_kind(origin) {
        return reaching(reaches, operation);
    }
    if let Some(known) = crate::service_catalog::by_package(origin) {
        let constructs_the_client = operation.eq_ignore_ascii_case(binding);
        let reaches = !constructs_the_client && !NEVER_REACHES_THE_SERVICE.contains(&operation);
        return reaches.then(|| known.reached_as());
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
    let mut held: HashMap<u32, Vec<&str>> = HashMap::default();
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
    let named_of: HashMap<&str, &str> =
        nodes.iter().map(|node| (node.id.as_str(), node.name.as_str())).collect();
    let modelled: HashSet<&str> = roles
        .roles
        .iter()
        .filter(|role| role.role == "model" && !role.from.starts_with("name:"))
        .filter_map(|role| named_of.get(role.node.as_str()).copied())
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
            service: None,
        });
    }
    found
}

struct StoreBase {
    named: &'static str,
    every_call: bool,
}

const fn store(named: &'static str, every_call: bool) -> StoreBase {
    StoreBase { named, every_call }
}

static STORE_BASES: &[StoreBase] = &[
    store("CrudRepository", true),
    store("DbConnection", false),
    store("DbContext", false),
    store("DbSet", false),
    store("DocumentClient", false),
    store("ElasticsearchRepository", true),
    store("EntityManager", false),
    store("IDbConnection", false),
    store("IdentityDbContext", false),
    store("JdbcTemplate", false),
    store("JpaRepository", true),
    store("ListCrudRepository", true),
    store("MongoRepository", true),
    store("MongoTemplate", false),
    store("NamedParameterJdbcTemplate", false),
    store("ObjectContext", false),
    store("PagingAndSortingRepository", true),
    store("R2dbcRepository", true),
    store("ReactiveCrudRepository", true),
    store("ReactiveMongoRepository", true),
    store("SqlConnection", false),
];

static SPEAKS_HTTP: &[&str] = &[
    "AsyncClient", "ClientSession", "HttpClient", "IHttpClientFactory", "OkHttpClient", "RestClient", "RestTemplate",
    "WebClient",
];

static SENDS_A_REQUEST: &[&str] = &[
    "delete", "deleteasync", "deleteforentity", "exchange", "execute", "executeasync", "get", "getasync",
    "getbytearrayasync", "getforentity", "getforobject", "getfromjsonasync", "getstreamasync", "getstringasync",
    "patch", "patchasjsonasync", "patchasync", "post", "postasjsonasync", "postasync", "postforentity",
    "postforobject", "put", "putasjsonasync", "putasync", "request", "send", "sendasync",
];

static EXECUTES_AGAINST_A_STORE: &[&str] = &[
    "add", "addasync", "addrange", "addrangeasync", "all", "allasync", "any", "anyasync", "attach", "average",
    "averageasync", "batchupdate", "contains", "containsasync", "count", "countasync", "createquery", "delete",
    "execute", "executeasync", "executedelete", "executedeleteasync", "executenonquery", "executenonqueryasync",
    "executereader", "executereaderasync", "executescalar", "executescalarasync", "executesqlinterpolated",
    "executesqlinterpolatedasync", "executesqlraw", "executesqlrawasync", "executeupdate", "executeupdateasync",
    "find", "findasync", "first", "firstasync", "firstordefault", "firstordefaultasync", "fromsql",
    "fromsqlinterpolated", "fromsqlraw", "insert", "last", "lastasync", "lastordefault", "lastordefaultasync",
    "load", "loadasync", "longcount", "longcountasync", "max", "maxasync", "merge", "min", "minasync", "persist",
    "query", "queryasync", "queryfirst", "queryfirstordefault", "queryforlist", "queryforobject", "querysingle",
    "remove", "removerange", "save", "savechanges", "savechangesasync", "single", "singleasync",
    "singleordefault", "singleordefaultasync", "sum", "sumasync", "toarray", "toarrayasync", "todictionary",
    "todictionaryasync", "tolist", "tolistasync", "update", "updaterange",
];

fn plain_type(annotation: &str) -> &str {
    let annotation = annotation.trim().trim_end_matches('?');
    let annotation = annotation.split('<').next().unwrap_or(annotation);
    names::leaf(annotation.trim())
}

pub fn kept_by_a_store(
    calls: &[CallFact],
    files: &[String],
    nodes: &[IndexNode],
    edges: &[IndexEdge],
    type_references: &[TypeReferenceFact],
    locals: &[LocalBinding],
) -> Vec<ExitPoint> {
    let position: HashMap<&str, usize> =
        nodes.iter().enumerate().map(|(at, node)| (node.id.as_str(), at)).collect();
    let mut bases_of: HashMap<&str, Vec<&str>> = HashMap::default();
    for edge in edges.iter().filter(|edge| matches!(edge.kind, EdgeKind::Extends | EdgeKind::Implements)) {
        if let Some(target) = position.get(edge.target.as_str()) {
            bases_of.entry(nodes[position[edge.source.as_str()]].name.as_str())
                .or_default()
                .push(nodes[*target].name.as_str());
        }
    }
    for reference in type_references.iter().filter(|reference| matches!(reference.kind, EdgeKind::Extends | EdgeKind::Implements)) {
        if let Some(source) = position.get(reference.source.as_str()) {
            bases_of.entry(nodes[*source].name.as_str()).or_default().push(plain_type(&reference.name));
        }
    }
    let store_of = |named: &str| -> Option<&'static StoreBase> {
        let mut seen: HashSet<&str> = HashSet::default();
        let mut frontier = vec![named];
        while let Some(current) = frontier.pop() {
            if !seen.insert(current) {
                continue;
            }
            if let Some(base) = STORE_BASES.iter().find(|base| base.named == current) {
                return Some(base);
            }
            frontier.extend(bases_of.get(current).into_iter().flatten().copied());
        }
        None
    };
    let mut typed_member: HashMap<(&str, &str), &str> = HashMap::default();
    let mut typed_member_of: HashMap<(&str, &str), &str> = HashMap::default();
    for node in nodes.iter().filter(|node| node.kind == NodeKind::Property) {
        if let (Some(parent), Some(annotation)) = (node.parent.as_deref(), node.type_annotation.as_deref()) {
            typed_member.insert((parent, node.name.as_str()), plain_type(annotation));
            if let Some(owner) = position.get(parent).map(|at| nodes[*at].name.as_str()) {
                typed_member_of.insert((owner, node.name.as_str()), plain_type(annotation));
            }
        }
    }
    for node in nodes.iter().filter(|node| node.kind.is_type()) {
        for parameter in node.signature.iter().flat_map(|signature| signature.parameters.iter()) {
            if let Some(annotation) = parameter.type_annotation.as_deref() {
                typed_member.entry((node.id.as_str(), parameter.name.as_str())).or_insert(plain_type(annotation));
            }
        }
    }
    let mut typed_local: HashMap<(&str, &str), &str> = HashMap::default();
    for local in locals {
        if let Some(annotation) = local.annotation.as_deref().or(local.constructed.as_deref()) {
            typed_local.insert((local.unit.as_str(), local.name.as_str()), plain_type(annotation));
        }
    }
    let mut found = Vec::new();
    for (at, call) in calls.iter().enumerate() {
        let (Some(receiver), Some(caller)) = (call.receiver.as_deref(), call.caller.as_deref()) else { continue };
        let Some(unit) = position.get(caller).map(|at| &nodes[*at]) else { continue };
        let rooted = names::root(receiver);
        let rooted = rooted.strip_prefix("this.").unwrap_or(rooted);
        let held = match rooted {
            "this" | "self" => receiver.strip_prefix("this.").or_else(|| receiver.strip_prefix("self.")).map(names::root),
            _ => Some(rooted),
        };
        let Some(held) = held.map(|held| held.trim_start_matches('$')) else { continue };
        let owner = unit.parent.as_deref();
        let typed = typed_local
            .get(&(caller, held))
            .copied()
            .or_else(|| {
                unit.signature.iter().flat_map(|signature| signature.parameters.iter()).find_map(|parameter| {
                    (parameter.name == held).then(|| parameter.type_annotation.as_deref().map(plain_type)).flatten()
                })
            })
            .or_else(|| owner.and_then(|owner| typed_member.get(&(owner, held)).copied()));
        let mut reached = typed.and_then(|typed| store_of(typed));
        if reached.is_none()
            && let Some(mut current) = typed
        {
            for segment in receiver.split('.').skip(1).take(3) {
                let segment = segment.trim();
                let end = segment.find(|letter: char| !(letter.is_alphanumeric() || letter == '_')).unwrap_or(segment.len());
                let Some(next) = typed_member_of.get(&(current, &segment[..end])).copied() else { break };
                current = next;
                if let Some(base) = store_of(current) {
                    reached = Some(base);
                    break;
                }
            }
        }
        if reached.is_none()
            && let Some(client) = typed.filter(|typed| SPEAKS_HTTP.contains(typed))
        {
            let operation = names::leaf(&call.callee);
            let verb = operation.split('<').next().unwrap_or(operation).to_ascii_lowercase();
            if SENDS_A_REQUEST.iter().any(|held| verb == *held) {
                found.push(ExitPoint {
                    id: format!("exit:{}:{}:http", files[call.file as usize], at),
                    kind: "api",
                    name: format!("{receiver}.{operation}"),
                    source: caller.to_string(),
                    target: client.to_string(),
                    operation: operation.to_string(),
                    file: call.file,
                    line: call.line,
                    awaited: call.context.awaited,
                    addressed: addressed_at(call),
                    service: None,
                });
            }
            continue;
        }
        let Some(base) = reached else { continue };
        let operation = names::leaf(&call.callee);
        let lowered = operation.to_ascii_lowercase();
        if !base.every_call && EXECUTES_AGAINST_A_STORE.binary_search(&lowered.as_str()).is_err() {
            continue;
        }
        found.push(ExitPoint {
            id: format!("exit:{}:{}:store", files[call.file as usize], at),
            kind: "database",
            name: format!("{receiver}.{operation}"),
            source: caller.to_string(),
            target: base.named.to_string(),
            operation: operation.to_string(),
            file: call.file,
            line: call.line,
            awaited: call.context.awaited,
            addressed: addressed_at(call),
            service: None,
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

static TOUCAN_NAMESPACES: &[&str] = &["t2", "toucan2.core"];

fn sqldelight_queries(receiver: &str) -> Option<&str> {
    let held = receiver.rsplit('.').next().unwrap_or(receiver);
    held.strip_suffix("Queries")
        .filter(|stem| stem.chars().next().is_some_and(|letter| letter.is_ascii_lowercase()))
}

fn kept_by_toucan(call: &CallFact) -> Option<&'static str> {
    let (space, operation) = call.callee.rsplit_once('/')?;
    (TOUCAN_NAMESPACES.contains(&space) && !operation.is_empty() && operation != "table-name").then_some("database")
}

fn toucan_model(call: &CallFact) -> Option<String> {
    kept_by_toucan(call)?;
    call.literals.iter().find_map(|held| held.trim().strip_prefix(":model/").map(str::to_string))
}

fn spoken_label(label: &str) -> String {
    if let Some(at) = label.find(".command(") {
        let rest = &label[at + ".command(".len()..];
        let quoted = rest.trim_start();
        if let Some(quote) = quoted.chars().next().filter(|letter| matches!(letter, '\'' | '"' | '`')) {
            if let Some(end) = quoted[1..].find(quote) {
                let command = quoted[1..1 + end].split_whitespace().next().unwrap_or_default();
                if !command.is_empty() {
                    return command.to_string();
                }
            }
        }
    }
    label.lines().next().unwrap_or(label).trim().to_string()
}

static REQUEST_VERBS: &[&str] = &["delete", "get", "head", "patch", "post", "put", "request"];

static ADDRESS_KEYS: &[&str] = &["endpoint", "path", "url"];

fn keyed_address(held: &str) -> Option<&str> {
    let (key, value) = held.split_once('=')?;
    ADDRESS_KEYS.contains(&key.trim()).then(|| value.trim())
}

fn requested_by_url(call: &CallFact) -> Option<&'static str> {
    let verb = names::leaf(&call.callee).to_ascii_lowercase();
    (REQUEST_VERBS.contains(&verb.as_str())
        && call.literals.iter().any(|held| keyed_address(held).is_some_and(|value| a_path(plainly_written(value)))))
    .then_some("api")
}

fn addressed_at(call: &CallFact) -> Option<String> {
    for held in call.literals.iter() {
        let held = plainly_written(keyed_address(held).unwrap_or(held));
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

static GATHERS_ROUTES: &[&str] = &["basepath", "group", "mapgroup", "prefix"];

type Groups<'a> = HashMap<(u32, &'a str, &'a str), (String, Option<&'a str>)>;

fn a_route_prefix(literal: &str) -> Option<String> {
    let bare = literal.trim().trim_end_matches('/');
    let spoken = bare
        .chars()
        .all(|letter| letter.is_alphanumeric() || matches!(letter, '/' | '-' | '_' | '.' | '{' | '}' | ':'));
    (spoken && !bare.is_empty()).then(|| match bare.starts_with('/') {
        true => bare.to_string(),
        false => format!("/{bare}"),
    })
}

fn groups_of<'a>(calls: &'a [CallFact], locals: &'a [crate::model::LocalBinding]) -> Groups<'a> {
    let mut on_line: HashMap<(u32, u32), Vec<&CallFact>> = HashMap::default();
    for call in calls {
        if GATHERS_ROUTES.contains(&names::leaf(&call.callee).to_ascii_lowercase().as_str()) {
            on_line.entry((call.file, call.line)).or_default().push(call);
        }
    }
    let mut groups: Groups = HashMap::default();
    for held in locals {
        let Some(found) = on_line.get(&(held.file, held.line)) else { continue };
        let Some((call, prefix)) = found
            .iter()
            .find_map(|call| call.literals.iter().find_map(|literal| a_route_prefix(literal)).map(|prefix| (call, prefix)))
        else {
            continue;
        };
        let within = call.receiver.as_deref().map(names::root);
        groups.insert((held.file, held.unit.as_str(), held.name.as_str()), (prefix, within));
    }
    groups
}

fn prefix_of(groups: &Groups, file: u32, unit: &str, name: &str, depth: u8) -> Option<String> {
    let (prefix, within) = groups.get(&(file, unit, name))?;
    let above = match (within, depth) {
        (Some(parent), 0..8) => prefix_of(groups, file, unit, parent, depth + 1),
        _ => None,
    };
    Some(match above {
        Some(above) => join_paths(&above, prefix),
        None => prefix.clone(),
    })
}

type CallsByLine<'a> = HashMap<(u32, u32, String), &'a CallFact>;

fn calls_by_line(calls: &[CallFact]) -> CallsByLine<'_> {
    let mut held: CallsByLine = HashMap::default();
    for call in calls {
        held.entry((call.file, call.line, names::leaf(&call.callee).to_ascii_lowercase()))
            .or_insert(call);
    }
    held
}

fn grouped_under(registration: &RegistrationFact, by_line: &CallsByLine, groups: &Groups) -> Option<String> {
    let verb = names::leaf(&registration.registrar).to_ascii_lowercase();
    let call = by_line.get(&(registration.file, registration.line, verb))?;
    let unit = call.caller.as_deref()?;
    let receiver = names::root(call.receiver.as_deref()?);
    prefix_of(groups, registration.file, unit, receiver, 0)
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
    modules: &rustc_hash::FxHashMap<(u32, String), String>,
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
                service: None,
            }
        })
        .collect()
}

pub struct Derived {
    pub entry_points: Vec<EntryPoint>,
    pub exit_points: Vec<ExitPoint>,
    pub continued: Vec<String>,
}

pub fn derive(
    nodes: &[IndexNode],
    calls: &[CallFact],
    files: &[String],
    registrations: &[RegistrationFact],
    type_references: &[TypeReferenceFact],
    resolution: &Resolution,
    locals: &[crate::model::LocalBinding],
    imports: &[crate::model::ImportFact],
) -> Derived {
    let timing = std::env::var("KLAURO_TIME_EXITS").is_ok();
    let started = std::time::Instant::now();
    let lap = |label: &str| {
        if timing {
            eprintln!("    entry and exit {label} {:?}", started.elapsed());
        }
    };
    let connected: HashMap<(u32, &str, &str), &str> = locals
        .iter()
        .filter_map(|held| {
            let built = names::leaf(held.constructed.as_deref()?);
            opens_a_connection(built)
                .then_some(((held.file, held.unit.as_str(), held.name.as_str()), built))
        })
        .collect();
    let locals_by_unit: HashMap<(u32, &str, &str), &crate::model::LocalBinding> = locals
        .iter()
        .map(|held| ((held.file, held.unit.as_str(), held.name.as_str()), held))
        .collect();
    let Resolution { modules, local, unique_units, call_origins, through, imported, .. } = resolution;
    let known: HashSet<&str> = nodes.iter().map(|node| node.id.as_str()).collect();
    let mut stands_in: HashMap<&str, Vec<&'static str>> = HashMap::default();
    for ((file, _), specifier) in modules {
        let Some(kinds) = module_kind(specifier) else { continue };
        let holding = stands_in.entry(files[*file as usize].as_str()).or_default();
        for kind in kinds {
            if !holding.contains(kind) {
                holding.push(kind);
            }
        }
    }
    let mcp_files = files_that_speak_the_mcp_sdk(imports);
    lap("setup");
    let mut entry_points = Vec::new();
    let mut continued: Vec<String> = Vec::new();
    let mounts = crate::mounts::composed(mounted_under(calls), calls, locals, files, nodes, through, imported);
    let mounted = &mounts.files;
    let parent_of: HashMap<&str, &str> =
        nodes.iter().filter_map(|node| Some((node.id.as_str(), node.parent.as_deref()?))).collect();
    let prefix_for = |registrar: &str, file: u32, unit: Option<&str>| -> Option<String> {
        let of_the_file = (registered_on_a_router_like(registrar) || mounts.children.contains(&file))
            .then(|| mounted.get(&file).cloned())
            .flatten();
        let of_the_unit = unit.and_then(|unit| mounts.within(unit, &parent_of));
        match (of_the_file, of_the_unit) {
            (Some(file), Some(unit)) => Some(join_paths(&file, &unit)),
            (file, None) => file,
            (None, unit) => unit,
        }
    };
    let mut base_paths: HashMap<&str, String> = HashMap::default();
    let mut written_in: HashMap<&str, Vec<&crate::model::LocalBinding>> = HashMap::default();
    for local in locals.iter().filter(|local| local.written.is_some() && !local.unit.is_empty()) {
        written_in.entry(local.unit.as_str()).or_default().push(local);
    }
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
        if !base_paths.contains_key(node.id.as_str())
            && let Some(base) = exposed_under(node, &written_in)
        {
            base_paths.insert(node.id.as_str(), base);
        }
    }

    let named_of: HashMap<&str, &IndexNode> =
        nodes.iter().map(|node| (node.id.as_str(), node)).collect();
    let spoken_as_dotnet = |file: u32| files.get(file as usize).is_some_and(|path| path.ends_with(".cs"));
    let routed_by_convention = calls
        .iter()
        .any(|call| spoken_as_dotnet(call.file) && ROUTES_BY_CONVENTION.contains(&names::leaf(&call.callee)));
    for node in nodes {
        if let Some(registrar) = &node.callback_of {
            let label = node.registration_label.as_deref();
            let continuation = classify_registration(registrar, label, mcp_files.contains(&node.file)) == Some("event")
                && continues_a_started_operation(
                    registrar,
                    node.file,
                    node.parent.as_deref().unwrap_or(""),
                    &locals_by_unit,
                );
            if continuation {
                continued.push(node.id.clone());
            }
            if let Some(kind) = classify_registration(registrar, label, mcp_files.contains(&node.file)).filter(|_| !continuation) {
                let verb = names::leaf(registrar);
                let spoken = match (label, kind) {
                    (_, "schedule") => running_within(node, &named_of)
                        .unwrap_or(registrar.as_str())
                        .to_string(),
                    (None, "tool") => node.name.clone(),
                    (Some(label), _) => spoken_label(label),
                    (None, _) => registrar.clone(),
                };
                entry_points.push(EntryPoint {
                    id: format!("entry:{}", node.id),
                    kind,
                    name: spoken,
                    method: if kind == "http" {
                        Some(mapped_method(verb).unwrap_or_else(|| verb.to_ascii_uppercase()))
                    } else {
                        None
                    },
                    path: if kind == "http" {
                        let base = prefix_for(registrar, node.file, node.parent.as_deref());
                        let label = label.map(|held| split_label(held).1);
                        match (base, label) {
                            (Some(base), Some(label)) => Some(join_paths(&base, &label)),
                            (Some(base), None) => Some(base),
                            (None, label) => label,
                        }
                    } else {
                        None
                    },
                    handler: node.id.clone(),
                    file: node.file,
                    line: node.span.line,
                    guards: Vec::new(),
                    registrar: registrar.clone(),
                    unshipped: None,
                });
            }
        }
        let names_its_path = |decorator: &Decorator| normalize_annotation(&decorator.name) == "path";
        let own_path: Option<String> = node.decorators.iter().filter(|decorator| names_its_path(decorator)).find_map(|decorator| {
            decorator.arguments.iter().find(|argument| argument.literal).map(|argument| argument.value.clone())
        });
        let has_a_verb = node
            .decorators
            .iter()
            .any(|decorator| matches!(decorator_entry(decorator), Some(("http", method, _)) if method != "ANY"));
        for (position, decorator) in node.decorators.iter().enumerate() {
            if mcp_files.contains(&node.file)
                && matches!(node.kind, NodeKind::Function | NodeKind::Method)
                && named_by_an_mcp_tool_decorator(decorator)
            {
                let name = overridden_by_the_decorator(decorator).unwrap_or_else(|| node.name.clone());
                entry_points.push(EntryPoint {
                    id: format!("entry:{}:{}:{}", node.id, decorator.name, position),
                    kind: "tool",
                    name,
                    method: None,
                    path: None,
                    handler: node.id.clone(),
                    file: node.file,
                    line: node.span.line,
                    guards: Vec::new(),
                    registrar: decorator.name.clone(),
                    unshipped: None,
                });
                continue;
            }
            if has_a_verb && names_its_path(decorator) {
                continue;
            }
            if let Some((kind, method, path)) = decorator_entry(decorator) {
                if method == "ANY" && matches!(node.kind, NodeKind::Class | NodeKind::Interface) {
                    continue;
                }
                let path = match (kind, path) {
                    ("http", None) => own_path.clone(),
                    (_, path) => path,
                };
                let base = node
                    .parent
                    .as_deref()
                    .and_then(|parent| base_paths.get(parent))
                    .or_else(|| {
                        (registered_on_a_router_like(&decorator.name) || mounts.children.contains(&node.file))
                            .then(|| mounted.get(&node.file))
                            .flatten()
                    });
                let path = match (base, path) {
                    (Some(base), Some(path)) => Some(join_paths(base, &path)),
                    (Some(base), None) => Some(base.clone()),
                    (None, path) => path,
                };
                let path = match (kind, path) {
                    ("http", None) if routed_by_convention && spoken_as_dotnet(node.file) => {
                        conventional_path(node, &named_of)
                    }
                    (_, path) => path,
                };
                if kind == "http" && path.is_none() {
                    continue;
                }
                entry_points.push(EntryPoint {
                    id: format!("entry:{}:{}:{}", node.id, decorator.name, position),
                    kind,
                    name: path.clone().unwrap_or_else(|| node.name.clone()),
                    method: Some(method),
                    path,
                    handler: node.id.clone(),
                    file: node.file,
                    line: node.span.line,
                    guards: Vec::new(),
                    registrar: decorator.name.clone(),
                    unshipped: None,
                });
            }
        }
    }

    if routed_by_convention {
        let found = conventional_actions(nodes, &named_of, &entry_points);
        entry_points.extend(found.into_iter().filter(|entry| spoken_as_dotnet(entry.file)));
    }
    entry_points.extend(served_over_grpc(nodes, type_references, files));
    let drawn = crate::rails_routes::derive(nodes, calls, files);
    if !drawn.is_empty() {
        entry_points.retain(|entry| {
            entry.kind != "http" || !crate::rails_routes::draws_routes(entry.handler.split(':').next().unwrap_or_default())
        });
        entry_points.extend(drawn);
    }
    lap("decorated entries");
    let mut by_name: HashMap<&str, Vec<&IndexNode>> = HashMap::default();
    let mut above: HashMap<&str, Vec<&str>> = HashMap::default();
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
    let type_ids: HashSet<&str> = nodes.iter().filter(|node| node.kind.is_type()).map(|node| node.id.as_str()).collect();
    for call in calls.iter().filter(|call| call.receiver.is_none() && MIXES_IN.contains(&call.callee.as_str())) {
        let Some(caller) = call.caller.as_deref().filter(|caller| type_ids.contains(caller)) else { continue };
        for literal in &call.literals {
            above.entry(caller).or_default().push(literal.as_str());
        }
    }
    fn supertype_base(
        name: &str,
        reaches: &HashMap<&str, &'static EntryBase>,
    ) -> Option<&'static EntryBase> {
        entry_base(name)
            .or_else(|| reaches.get(names::leaf(name)).copied())
    }
    let mut reaches: HashMap<&str, &'static EntryBase> = HashMap::default();
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

    let mut members: HashMap<&str, Vec<&IndexNode>> = HashMap::default();
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
                unshipped: None,
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
                unshipped: None,
            });
        }
    }

    lap("inherited entries");
    let declared: HashSet<&str> = nodes
        .iter()
        .filter(|node| node.kind.is_type() || matches!(node.kind, NodeKind::Function | NodeKind::Method))
        .flat_map(|node| [node.name.as_str(), names::leaf(&node.name)])
        .collect();
    let mut owning: HashMap<(u32, u32), &str> = HashMap::default();
    let mut acting: HashMap<(u32, u32), &str> = HashMap::default();
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

    lap("registrations owned");
    let groups = groups_of(calls, locals);
    let by_line = if groups.is_empty() { HashMap::default() } else { calls_by_line(calls) };
    let calls_by_registration = if mounts.units.is_empty() { HashMap::default() } else { calls_by_line(calls) };
    let mut units_in_file: HashMap<(u32, &str), Vec<&str>> = HashMap::default();
    for node in nodes.iter().filter(|node| node.kind.is_unit()) {
        units_in_file.entry((node.file, node.name.as_str())).or_default().push(node.id.as_str());
    }
    let mut registered: HashSet<(u32, u32, String)> = HashSet::default();
    let const_values: HashMap<&str, &str> = locals
        .iter()
        .filter(|local| local.unit.is_empty())
        .filter_map(|local| Some((local.name.as_str(), local.written.as_deref()?)))
        .collect();
    for registration in registrations {
        let label: std::borrow::Cow<str> = match registration.label.strip_prefix(DISPATCH_CONST_MARKER) {
            Some(leaf) => match const_values.get(leaf) {
                Some(value) => std::borrow::Cow::Borrowed(*value),
                None => continue,
            },
            None => std::borrow::Cow::Borrowed(registration.label.as_str()),
        };
        let Some(kind) = classify_registration(&registration.registrar, Some(&label), mcp_files.contains(&registration.file)) else {
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
            .cloned())
            .or_else(|| match units_in_file.get(&(registration.file, leaf)).map(Vec::as_slice) {
                Some([only]) => Some((*only).to_string()),
                _ => None,
            })
            .or_else(|| unique_units.get(leaf)
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
        if !registered.insert((registration.file, registration.line, label.to_string())) {
            continue;
        }
        let verb = names::leaf(&registration.registrar);
        let (label_method, path) = split_label(&label);
        let path = match grouped_under(registration, &by_line, &groups) {
            Some(prefix) => join_paths(&prefix, &path),
            None => path,
        };
        let called_from = calls_by_registration
            .get(&(registration.file, registration.line, verb.to_ascii_lowercase()))
            .and_then(|call| call.caller.as_deref());
        let path = match prefix_for(&registration.registrar, registration.file, called_from) {
            Some(base) => join_paths(&base, &path),
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
                .unwrap_or(label.as_ref())
                .to_string(),
            false => label.to_string(),
        };
        entry_points.push(EntryPoint {
            id: format!("entry:{handler}:{}", label),
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
            unshipped: None,
        });
    }

    lap("registered routes");
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
                unshipped: None,
            });
        }
    }

    for node in nodes {
        let named_main = matches!(node.kind, NodeKind::Function | NodeKind::Method)
            && LIFECYCLE_NAMES.binary_search(&node.name.as_str()).is_ok();
        let marked_main = node.kind.is_type() && node.decorators.iter().any(|held| held.name == "main");
        if !named_main && !marked_main {
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
            unshipped: None,
        });
    }

    let held_at: HashMap<&str, &IndexNode> = nodes.iter().map(|node| (node.id.as_str(), node)).collect();
    let mut opened: HashSet<&str> = HashSet::default();
    for arm in nodes.iter().filter(|node| node.callback_of.as_deref() == Some("dispatch:ui")) {
        let Some(family) = arm.registration_label.as_deref().and_then(|label| label.split_once('.')).map(|(family, _)| family) else {
            continue;
        };
        let mut holder = arm.parent.as_deref().and_then(|parent| held_at.get(parent).copied());
        for _ in 0..8 {
            match holder {
                Some(held) if held.id.contains(":callback:") => holder = held.parent.as_deref().and_then(|parent| held_at.get(parent).copied()),
                _ => break,
            }
        }
        let Some(screen) = holder.filter(|held| held.kind.is_unit()) else { continue };
        if !opened.insert(screen.id.as_str()) {
            continue;
        }
        entry_points.push(EntryPoint {
            id: format!("entry:{}:opened", screen.id),
            kind: "ui",
            name: format!("{family}.Open"),
            method: None,
            path: None,
            handler: screen.id.clone(),
            file: screen.file,
            line: screen.span.line,
            guards: Vec::new(),
            registrar: "dispatch:ui".to_string(),
            unshipped: None,
        });
    }

    lap("conventional entries");
    let exits_of = |(position, call): (usize, &CallFact)| -> (Vec<ExitPoint>, Vec<String>) {
        let mut found: Vec<ExitPoint> = Vec::new();
        let mut reach: Vec<String> = Vec::new();
        let Some(source) = &call.caller else { return (found, reach) };
        if let Some((operation, table)) = asked_of_a_table(call) {
            reach.push(call.receiver.clone().unwrap_or_default());
            found.push(ExitPoint {
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
                service: None,
            });
        }
        if let Some(operation) = a_cookie_kept(call) {
            reach.push(call.receiver.clone().unwrap_or_default());
            found.push(ExitPoint {
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
                service: None,
            });
            return (found, reach);
        }
        if let Some((operation, over)) = over_a_connection(call, source, &connected) {
            reach.push(call.receiver.clone().unwrap_or_default());
            found.push(ExitPoint {
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
                service: None,
            });
            return (found, reach);
        }
        if call.receiver.is_some()
            && let Some(kind) = requested_by_url(call)
        {
            reach.push(String::new());
            found.push(ExitPoint {
                id: format!("exit:{}:{}", files[call.file as usize], position),
                kind,
                name: call.callee.clone(),
                source: source.clone(),
                target: call.receiver.clone().unwrap_or_default(),
                operation: call.callee.clone(),
                file: call.file,
                line: call.line,
                awaited: call.context.awaited,
                addressed: addressed_at(call),
                service: None,
            });
            return (found, reach);
        }
        let Some(receiver) = call.receiver.as_deref() else {
            let Some(kind) = bare_exit(call, modules, &files[call.file as usize])
                .or_else(|| built_into_the_language(call, &files[call.file as usize]))
                .or_else(|| requested_by_url(call))
                .or_else(|| kept_by_toucan(call))
            else {
                return (found, reach);
            };
            let origin = modules
                .get(&(call.file, call.callee.clone()))
                .cloned()
                .unwrap_or_else(|| call.callee.clone());
            reach.push(String::new());
            found.push(ExitPoint {
                id: format!("exit:{}:{}", files[call.file as usize], position),
                kind,
                name: call.callee.clone(),
                source: source.clone(),
                target: origin,
                operation: call.callee.trim_start_matches('\\').to_string(),
                file: call.file,
                line: call.line,
                awaited: call.context.awaited,
            addressed: toucan_model(call).or_else(|| addressed_at(call)),
            service: None,
            });
            return (found, reach);
        };
        let binding = names::root(receiver);
        if receiver.contains('.') && reads_a_data_member(receiver) {
            return (found, reach);
        }
        if let Some(kind) = manager_exit(receiver, names::leaf(&call.callee))
            .or_else(|| names_a_store(names::leaf(&call.callee)).then_some("database"))
        {
            let operation = names::leaf(&call.callee);
            reach.push(receiver.to_string());
            found.push(ExitPoint {
                id: format!("exit:{}:{}", files[call.file as usize], position),
                kind,
                name: format!("{receiver}.{operation}"),
                source: source.clone(),
                target: binding.to_string(),
                operation: operation.to_string(),
                file: call.file,
                line: call.line,
                awaited: call.context.awaited,
            addressed: addressed_at(call).or_else(|| sqldelight_queries(receiver).map(str::to_string)),
            service: None,
            });
            return (found, reach);
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
                    reach.push(receiver.to_string());
                    found.push(ExitPoint {
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
            service: None,
                    });
                    return (found, reach);
                }
                None => return (found, reach),
            },
        };
        let Some(kind) =
            classify_reached(binding, origin, &call.callee, stands_in.get(origin).map(Vec::as_slice))
        else {
            return (found, reach);
        };
        let receiver = receiver.to_string();
        let operation = names::leaf(&call.callee);
        reach.push(receiver.to_string());
        found.push(ExitPoint {
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
            service: None,
        });
            (found, reach)
    };
    let mut exit_points = Vec::new();
    let mut reached_through: Vec<String> = Vec::new();
    let classified: Vec<(Vec<ExitPoint>, Vec<String>)> = calls.par_iter().enumerate().map(exits_of).collect();
    for (found, reach) in classified {
        exit_points.extend(found);
        reached_through.extend(reach);
    }
    entry_points.sort_by(|left, right| left.id.cmp(&right.id));
    entry_points.dedup_by(|left, right| left.id == right.id);
    keep_hand_rolled_dispatch_only_when_served(&mut entry_points, calls, nodes, files, &known, unique_units);
    let mut at_site: HashMap<(u32, u32), Vec<usize>> = HashMap::default();
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
    entry_points.retain(|entry| {
        if entry.kind == "test" {
            return true;
        }
        let path = &files[entry.file as usize];
        let survives_test_screen = match entry.kind {
            "http" => !is_test(path),
            _ => !is_unambiguously_test(path),
        };
        let recurs = entry.kind != "schedule" || recurring(&entry.registrar);
        if !recurs {
            continued.push(entry.handler.clone());
        }
        survives_test_screen && recurs
    });
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
    lap("exits");
    Derived { entry_points, exit_points, continued }
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
            ("STARTS_A_CONTINUATION", STARTS_A_CONTINUATION),
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
        assert_eq!(classify_exit("stripe", "stripe", "subscriptions.expire"), Some("api"));
        assert_eq!(classify_exit("posthog", "posthog-node", "capture"), Some("api"));
        assert_eq!(classify_exit("redis", "ioredis", "get"), Some("cache"));
        assert_eq!(classify_exit("redis", "ioredis", "on"), None);
        assert_eq!(classify_exit("Sentry", "@sentry/node", "init"), None);
        assert_eq!(classify_exit("Stripe", "stripe", "Stripe"), None);
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
        assert_eq!(classify_registration("app.Get", Some("/users"), false), Some("http"));
        assert_eq!(classify_registration("app.get", Some("/users"), false), Some("http"));
        assert_eq!(classify_registration("e.GET", Some("/users"), false), Some("http"));
        assert_eq!(classify_registration("api.MapPost", Some("/items"), false), Some("http"));
    }

    #[test]
    fn a_bare_tool_verb_is_only_an_mcp_tool_when_the_file_speaks_the_sdk() {
        assert_eq!(classify_registration("server.tool", Some("find_tests"), false), None);
        assert_eq!(classify_registration("server.tool", Some("find_tests"), true), Some("tool"));
        assert_eq!(classify_registration("server.registerTool", Some("find_tests"), true), Some("tool"));
        assert_eq!(classify_registration("dispatch:tool", Some("find_tests"), false), Some("tool"));
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
