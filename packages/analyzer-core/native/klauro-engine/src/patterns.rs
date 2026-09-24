use std::collections::{BTreeMap, BTreeSet};
use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};

use serde::Serialize;

use crate::entry_exit::{EntryPoint, ExitPoint};
use crate::model::*;

#[derive(Debug, Serialize)]
pub struct Message {
    pub message: String,
    pub kind: &'static str,
    pub handlers: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub senders: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub through: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct Topic {
    pub topic: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub publishers: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub subscribers: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct Found {
    pub pattern: &'static str,
    pub family: &'static str,
    pub evidence: String,
    pub count: u32,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub examples: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub projects: Vec<String>,
}

pub fn found(pattern: &'static str, family: &'static str, evidence: &str, count: u32) -> Found {
    Found { pattern, family, evidence: evidence.to_string(), count, examples: Vec::new(), projects: Vec::new() }
}

#[derive(Debug, Serialize)]
pub struct Conformance {
    pub paradigm: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    pub population: u32,
    pub following: u32,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub departing: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct Patterns {
    pub found: Vec<Found>,
    pub messages: Vec<Message>,
    pub topics: Vec<Topic>,
    pub conformance: Vec<Conformance>,
}

pub struct Sources<'a> {
    pub graph: &'a crate::shared::Graph<'a>,
    pub nodes: &'a [IndexNode],
    pub edges: &'a [IndexEdge],
    pub calls: &'a [CallFact],
    pub type_references: &'a [TypeReferenceFact],
    pub locals: &'a [LocalBinding],
    pub entry_points: &'a [EntryPoint],
    pub exit_points: &'a [ExitPoint],
    pub roles: &'a crate::roles::Roles,
    pub paths: &'a [&'a str],
    pub imports: &'a [ImportFact],
    pub declared: &'a [&'a str],
    pub serving_projects: u32,
}

const KEPT: usize = 12;
const DEPARTING_SHOWN: usize = 12;
const CONVENTION_FLOOR: f64 = 0.6;

static HANDLES_A_MESSAGE: &[&str] = &["Consumer", "Handler", "Subscriber"];
static HANDLED_BY_DECORATION: &[&str] = &[
    "CommandHandler", "EventHandler", "EventListener", "EventPattern", "EventsHandler", "MessageHandler",
    "MessagePattern", "QueryHandler", "RabbitListener", "KafkaListener", "SqsListener",
];
static HANDLING_METHODS: &[&str] = &[
    "consume", "execute", "executeasync", "handle", "handleasync", "invoke", "invokeasync", "on", "process",
];
static DISPATCHES: &[&str] = &[
    "dispatch", "dispatchasync", "execute", "executeasync", "publish", "publishasync", "publishevent", "send",
    "sendasync", "sendcommand", "sendquery",
];
static MEDIATES: &[&str] = &["dispatcher", "mediator", "sender"];
static CARRIES_MESSAGES: &[&str] = &["bus", "broker", "publisher", "queue"];
static REGISTERS_A_DEPENDENCY: &[&str] = &[
    "addscoped", "addsingleton", "addtransient", "bind", "provide", "register", "registersingleton",
    "registertype", "tryaddscoped", "tryaddsingleton", "tryaddtransient",
];
static COMMITS_A_UNIT_OF_WORK: &[&str] = &["commit", "commitasync", "saveentitiesasync", "savechanges", "savechangesasync"];

fn plain(named: &str) -> &str {
    let named = named.trim();
    let named = named.split('<').next().unwrap_or(named);
    crate::names::leaf(named.trim())
}

fn kind_of(message: &str, through: &str) -> &'static str {
    let said = |held: &str, word: &str| held.contains(word);
    for held in [message, through] {
        if said(held, "Query") {
            return "query";
        }
        if said(held, "Command") {
            return "command";
        }
        if said(held, "Event") || said(held, "Notification") {
            return "event";
        }
    }
    "message"
}

pub struct Derived {
    pub patterns: Patterns,
    pub dispatched: Vec<IndexEdge>,
}

pub fn derive(sources: &Sources) -> Derived {
    let timing = std::env::var("KLAURO_TIME_PATTERNS").is_ok();
    let started = std::time::Instant::now();
    let lap = |label: &str| {
        if timing {
            eprintln!("    patterns {label} {:?}", started.elapsed());
        }
    };
    let nodes = sources.nodes;
    let graph = sources.graph;
    let position = &graph.position;
    let tested = |file: u32| graph.file_tested(file);
    let handling_method = |owner: &str| -> Option<usize> {
        let owner = graph.at(owner)?;
        graph.members[owner].iter().copied().find(|at| {
            nodes[*at].kind.is_unit() && crate::shared::named_one_of(&nodes[*at].name, HANDLING_METHODS)
        })
    };

    let mut handled: BTreeMap<String, (BTreeSet<String>, String)> = BTreeMap::new();
    for reference in sources
        .type_references
        .iter()
        .filter(|reference| matches!(reference.kind, EdgeKind::Implements | EdgeKind::Extends))
        .filter(|reference| !tested(reference.file))
    {
        let through = plain(&reference.name);
        if !HANDLES_A_MESSAGE.iter().any(|ending| through.ends_with(ending)) {
            continue;
        }
        let Some(message) = reference.arguments.first().map(String::as_str) else { continue };
        let Some(method) = handling_method(reference.source.as_str()) else { continue };
        let held = handled.entry(message.to_string()).or_insert_with(|| (BTreeSet::new(), through.to_string()));
        held.0.insert(nodes[method].id.clone());
    }
    for node in nodes.iter().filter(|node| !tested(node.file)) {
        for decorator in &node.decorators {
            let decorated = plain(&decorator.name);
            if !HANDLED_BY_DECORATION.contains(&decorated) {
                continue;
            }
            let message = decorator
                .arguments
                .iter()
                .find(|argument| !argument.literal)
                .map(|argument| plain(&argument.value).to_string())
                .or_else(|| {
                    node.signature
                        .as_ref()
                        .and_then(|signature| signature.parameters.first())
                        .and_then(|parameter| parameter.type_annotation.as_deref())
                        .map(|annotation| plain(annotation).to_string())
                });
            let Some(message) = message.filter(|message| message.chars().next().is_some_and(char::is_uppercase))
            else {
                continue;
            };
            let handler = match node.kind.is_type() {
                true => handling_method(node.id.as_str()).map(|at| nodes[at].id.clone()),
                false => Some(node.id.clone()),
            };
            let Some(handler) = handler else { continue };
            handled
                .entry(message)
                .or_insert_with(|| (BTreeSet::new(), decorated.to_string()))
                .0
                .insert(handler);
        }
    }

    lap("handlers");
    let mut constructed_at: HashMap<(u32, u32), Vec<&str>> = HashMap::default();
    for call in sources.calls.iter().filter(|call| call.constructs) {
        constructed_at.entry((call.file, call.line)).or_default().push(plain(&call.callee));
    }
    let mut typed_local: HashMap<(&str, &str), &str> = HashMap::default();
    let mut bound_at: HashMap<(&str, &str), (u32, u32)> = HashMap::default();
    for local in sources.locals {
        if let Some(typed) = local.constructed.as_deref().or(local.annotation.as_deref()) {
            typed_local.insert((local.unit.as_str(), local.name.as_str()), plain(typed));
        }
        bound_at.insert((local.unit.as_str(), local.name.as_str()), (local.file, local.line));
    }
    let mut constructing_at: HashMap<(u32, u32), Vec<&CallFact>> = HashMap::default();
    for call in sources.calls.iter().filter(|call| call.constructs) {
        constructing_at.entry((call.file, call.line)).or_default().push(call);
    }
    let mut senders: BTreeMap<String, (BTreeSet<String>, BTreeSet<String>)> = BTreeMap::new();
    let mut dispatched: Vec<IndexEdge> = Vec::new();
    let mut mediated = 0u32;
    let mut bussed = 0u32;
    for call in sources.calls.iter().filter(|call| !tested(call.file)) {
        if !crate::shared::named_one_of(crate::names::leaf(&call.callee), DISPATCHES) {
            continue;
        }
        let Some(caller) = call.caller.as_deref() else { continue };
        let unit = position.get(caller).map(|at| &nodes[*at]);
        let typed = |named: &str| -> Option<&str> {
            typed_local.get(&(caller, named)).copied().or_else(|| {
                unit.and_then(|unit| unit.signature.as_ref())
                    .and_then(|signature| signature.parameters.iter().find(|parameter| parameter.name == named))
                    .and_then(|parameter| parameter.type_annotation.as_deref())
                    .map(plain)
            })
        };
        let mut carried: Vec<&str> = constructed_at.get(&(call.file, call.line)).cloned().unwrap_or_default();
        let mut built_from: Vec<(u32, u32)> = vec![(call.file, call.line)];
        for literal in &call.literals {
            carried.extend(typed(literal));
            built_from.extend(bound_at.get(&(caller, literal.as_str())).copied());
        }
        for place in built_from {
            for construction in constructing_at.get(&place).into_iter().flatten() {
                carried.extend(construction.literals.iter().filter_map(|literal| typed(literal)));
            }
        }
        let receiver = call.receiver.as_deref().unwrap_or("").to_ascii_lowercase();
        for message in carried {
            let Some((handlers, _)) = handled.get(message) else { continue };
            if MEDIATES.iter().any(|word| receiver.contains(word)) {
                mediated += 1;
            } else if CARRIES_MESSAGES.iter().any(|word| receiver.contains(word)) {
                bussed += 1;
            }
            let held = senders.entry(message.to_string()).or_default();
            held.0.insert(caller.to_string());
            held.1.insert(crate::names::leaf(&call.callee).to_string());
            for handler in handlers {
                if handler != caller {
                    dispatched.push(IndexEdge {
                        source: caller.to_string(),
                        target: handler.clone(),
                        kind: EdgeKind::Calls,
                    });
                }
            }
        }
    }
    for (declared, implementations) in graph.overriding() {
        for implementation in implementations {
            dispatched.push(IndexEdge {
                source: nodes[declared].id.clone(),
                target: nodes[implementation].id.clone(),
                kind: EdgeKind::Calls,
            });
        }
    }
    dispatched.sort_by(|left, right| (&left.source, &left.target).cmp(&(&right.source, &right.target)));
    dispatched.dedup_by(|left, right| left.source == right.source && left.target == right.target);

    lap("dispatch");
    let messages: Vec<Message> = handled
        .iter()
        .map(|(message, (handlers, through))| {
            let (sent_by, via) = senders.remove(message).unwrap_or_default();
            Message {
                message: message.clone(),
                kind: kind_of(message, through),
                handlers: handlers.iter().take(KEPT).cloned().collect(),
                senders: sent_by.into_iter().take(KEPT).collect(),
                through: via.into_iter().collect(),
            }
        })
        .collect();

    let mut topics: BTreeMap<String, (BTreeSet<String>, BTreeSet<String>)> = BTreeMap::new();
    for exit in sources.exit_points.iter().filter(|exit| exit.kind == "message" && !tested(exit.file)) {
        if let Some(topic) = exit.addressed.as_deref() {
            topics.entry(topic.to_string()).or_default().0.insert(exit.source.clone());
        }
    }
    for entry in sources
        .entry_points
        .iter()
        .filter(|entry| matches!(entry.kind, "message" | "event") && !tested(entry.file))
    {
        if let Some(topic) = entry.path.as_deref() {
            topics.entry(topic.to_string()).or_default().1.insert(entry.handler.clone());
        }
    }
    let topics: Vec<Topic> = topics
        .into_iter()
        .map(|(topic, (publishers, subscribers))| Topic {
            topic,
            publishers: publishers.into_iter().take(KEPT).collect(),
            subscribers: subscribers.into_iter().take(KEPT).collect(),
        })
        .collect();

    let mut found_here: Vec<Found> = Vec::new();
    let commands = messages.iter().filter(|message| message.kind == "command").count() as u32;
    let queries = messages.iter().filter(|message| message.kind == "query").count() as u32;
    let events = messages.iter().filter(|message| message.kind == "event").count() as u32;
    if mediated > 0 {
        found_here.push(found("mediator", "messaging", "requests sent through a mediator to their one handler", mediated));
    }
    if bussed > 0 {
        found_here.push(found("message bus", "messaging", "messages published on a bus to their handlers", bussed));
    }
    if commands > 0 && queries > 0 {
        found_here.push(found("CQRS", "messaging", "commands and queries handled apart", commands + queries));
    }
    if events > 0 {
        found_here.push(found("event handlers", "messaging", "events handled by their own handlers", events));
    }
    let paired = topics.iter().filter(|topic| !topic.publishers.is_empty() && !topic.subscribers.is_empty()).count();
    let subscribed = topics.iter().filter(|topic| !topic.subscribers.is_empty()).count();
    if paired > 0 || subscribed > 0 {
        found_here.push(found("publish/subscribe", "messaging", "topics published and subscribed to", topics.len() as u32));
    }
    let repositories: HashSet<&str> = sources
        .roles
        .roles
        .iter()
        .filter(|role| role.role == "repository")
        .map(|role| role.node.as_str())
        .collect();
    if !repositories.is_empty() {
        found_here.push(found("repository", "data", "data kept behind repositories", repositories.len() as u32));
    }
    let committed = sources
        .calls
        .iter()
        .filter(|call| !tested(call.file))
        .filter(|call| crate::shared::named_one_of(crate::names::leaf(&call.callee), COMMITS_A_UNIT_OF_WORK))
        .filter(|call| call.receiver.as_deref().is_some_and(|within| within.to_ascii_lowercase().contains("unitofwork")))
        .count() as u32;
    if committed > 0 {
        found_here.push(found("unit of work", "data", "changes committed together through a unit of work", committed));
    }
    let registered = sources
        .calls
        .iter()
        .filter(|call| !tested(call.file))
        .filter(|call| crate::shared::named_one_of(crate::names::leaf(&call.callee), REGISTERS_A_DEPENDENCY))
        .filter(|call| call.callee.contains('<') || call.literals.len() >= 1 || call.argument_count >= 1)
        .filter(|call| call.receiver.as_deref().is_some_and(|within| {
            let lowered = within.to_ascii_lowercase();
            lowered.contains("service") || lowered.contains("container") || lowered.contains("builder")
        }))
        .count() as u32;
    let injected = sources
        .roles
        .roles
        .iter()
        .filter(|role| role.from.starts_with("annotation:") && matches!(role.role, "provider" | "service" | "repository"))
        .count() as u32;
    if registered + injected > 0 {
        found_here.push(found("dependency injection", "architecture", "collaborators registered with a container and injected", registered + injected));
    }

    lap("topics and found");
    found_here.extend(crate::design_patterns::derive(graph, sources.edges));
    lap("design");
    found_here.extend(crate::practices::derive(&crate::practices::Sources {
        graph,
        nodes,
        edges: sources.edges,
        imports: sources.imports,
        declared: sources.declared,
        type_references: sources.type_references,
        entry_points: sources.entry_points,
        exit_points: sources.exit_points,
        roles: sources.roles,
        paths: sources.paths,
        serving_projects: sources.serving_projects,
        messages: messages.len(),
        topics: topics.len(),
    }));
    let mut merged: Vec<Found> = Vec::new();
    for held in found_here {
        match merged.iter_mut().find(|known| known.pattern == held.pattern) {
            Some(known) => {
                known.count = known.count.max(held.count);
                for example in held.examples {
                    if known.examples.len() < 6 && !known.examples.contains(&example) {
                        known.examples.push(example);
                    }
                }
                for project in held.projects {
                    if !known.projects.contains(&project) {
                        known.projects.push(project);
                    }
                }
            }
            None => merged.push(held),
        }
    }
    merged.sort_by(|left, right| left.family.cmp(right.family).then(left.pattern.cmp(right.pattern)));
    let found_here = merged;
    lap("practices");
    let conformance = conforming(sources, position, &repositories);
    lap("conformance");
    Derived { patterns: Patterns { found: found_here, messages, topics, conformance }, dispatched }
}

fn conforming(sources: &Sources, position: &rustc_hash::FxHashMap<&str, usize>, repositories: &HashSet<&str>) -> Vec<Conformance> {
    let nodes = sources.nodes;
    let tested = |file: u32| sources.paths.get(file as usize).is_some_and(|path| crate::paths::is_test(path));
    let role_of: HashMap<&str, &str> = sources.roles.roles.iter().map(|role| (role.node.as_str(), role.role)).collect();
    let kept_behind = |unit: &str| -> bool {
        let Some(at) = position.get(unit) else { return false };
        let node = &nodes[*at];
        let holder = node.parent.as_deref();
        repositories.contains(unit)
            || holder.is_some_and(|holder| repositories.contains(holder))
            || holder.and_then(|holder| role_of.get(holder)).is_some_and(|role| *role == "model")
    };
    let mut conformance = Vec::new();

    let mut by_project: BTreeMap<Option<String>, (u32, u32, Vec<String>)> = BTreeMap::new();
    for exit in sources.exit_points.iter().filter(|exit| exit.kind == "database" && !tested(exit.file)) {
        let project = position.get(exit.source.as_str()).and_then(|at| nodes[*at].project.clone());
        let held = by_project.entry(project).or_default();
        held.0 += 1;
        if kept_behind(&exit.source) {
            held.1 += 1;
        } else if held.2.len() < DEPARTING_SHOWN {
            held.2.push(exit.source.clone());
        }
    }
    for (project, (population, following, departing)) in by_project {
        if following == 0 || (following as f64) < (population as f64) * CONVENTION_FLOOR {
            continue;
        }
        conformance.push(Conformance { paradigm: "data kept behind repositories", project, population, following, departing });
    }

    let mut by_project: BTreeMap<Option<String>, (u32, u32, Vec<String>)> = BTreeMap::new();
    for entry in sources.entry_points.iter().filter(|entry| entry.kind == "http" && !tested(entry.file)) {
        let project = position.get(entry.handler.as_str()).and_then(|at| nodes[*at].project.clone());
        let held = by_project.entry(project).or_default();
        held.0 += 1;
        let open = entry.guards.iter().any(|guard| guard.kind == "open");
        if !entry.guards.is_empty() && !open {
            held.1 += 1;
        } else if entry.guards.is_empty() && held.2.len() < DEPARTING_SHOWN {
            let named = format!("{} {}", entry.method.as_deref().unwrap_or(""), entry.path.as_deref().unwrap_or(&entry.name));
            held.2.push(named.trim().to_string());
        }
    }
    for (project, (population, following, departing)) in by_project {
        if following == 0 || (following as f64) < (population as f64) * CONVENTION_FLOOR {
            continue;
        }
        conformance.push(Conformance { paradigm: "requests pass a guard", project, population, following, departing });
    }
    conformance
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_handler_names_the_message_it_handles_first() {
        let arguments = crate::model::type_arguments;
        assert_eq!(arguments("IRequestHandler<CreateOrderCommand, bool>"), vec!["CreateOrderCommand", "bool"]);
        assert_eq!(arguments("INotificationHandler<Events.OrderShipped>"), vec!["OrderShipped"]);
        assert_eq!(arguments("IHandler<Map<string, int>, Result>"), vec!["Map", "Result"]);
        assert!(arguments("Handler").is_empty());
    }

    #[test]
    fn a_message_is_a_command_a_query_or_an_event_by_what_it_says() {
        assert_eq!(kind_of("GetOrdersQuery", "IRequestHandler"), "query");
        assert_eq!(kind_of("CreateOrderCommand", "IRequestHandler"), "command");
        assert_eq!(kind_of("OrderShipped", "INotificationHandler"), "event");
        assert_eq!(kind_of("Ping", "IRequestHandler"), "message");
    }
}

static SUBSCRIBES: &[&str] = &["addconsumer", "addsubscription", "subscribe", "subscribeasync"];

pub fn subscribed(messages: &[Message], calls: &[CallFact], graph: &crate::shared::Graph) -> Vec<crate::entry_exit::EntryPoint> {
    let mut named: HashSet<&str> = HashSet::default();
    let mut by: HashMap<&str, &str> = HashMap::default();
    for call in calls {
        if call.type_arguments.is_empty() {
            continue;
        }
        let verb = crate::names::leaf(&call.callee);
        let verb = verb.split('<').next().unwrap_or(verb);
        if !SUBSCRIBES.contains(&verb.to_ascii_lowercase().as_str()) {
            continue;
        }
        for argument in &call.type_arguments {
            let held = crate::names::leaf(argument.trim());
            named.insert(held);
            by.entry(held).or_insert(verb);
        }
    }
    if named.is_empty() {
        return Vec::new();
    }
    let mut found = Vec::new();
    for message in messages.iter().filter(|message| named.contains(message.message.as_str())) {
        for handler in &message.handlers {
            let Some(at) = graph.at(handler) else { continue };
            let owned_by_a_subscriber = graph
                .type_owner(at)
                .is_some_and(|owner| named.contains(graph.nodes[owner].name.as_str()));
            if !owned_by_a_subscriber {
                continue;
            }
            let node = &graph.nodes[at];
            found.push(crate::entry_exit::EntryPoint {
                id: format!("entry:{handler}:message"),
                kind: "message",
                name: message.message.clone(),
                method: None,
                path: None,
                handler: handler.clone(),
                file: node.file,
                line: node.span.line,
                guards: Vec::new(),
                registrar: by.get(message.message.as_str()).copied().unwrap_or("subscribe").to_string(),
            });
        }
    }
    found
}
