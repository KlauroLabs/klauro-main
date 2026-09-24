use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};
use serde::{Deserialize, Serialize};

use crate::entry_exit::{EntryPoint, ExitPoint};
use crate::model::*;

const DEEPEST: u32 = 14;
const ACTIONS_AT_MOST: usize = 240;
const STEPS_AT_MOST: usize = 24;
const SHARED_BY: u32 = 6;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Region {
    pub unit: String,
    pub file: u32,
    pub start_line: u32,
    pub end_line: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct LogicalStep {
    pub id: String,
    pub kind: &'static str,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub object: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doing: Option<String>,
    pub when: &'static str,
    pub regions: Vec<Region>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct StepEdge {
    pub from: String,
    pub to: String,
    pub kind: &'static str,
}

#[derive(Clone)]
struct Action {
    kind: &'static str,
    object: Option<String>,
    doing: Option<String>,
    when: &'static str,
    unit: u32,
    line: u32,
}

pub struct Reader<'a> {
    nodes: &'a [IndexNode],
    position_of: &'a HashMap<&'a str, u32>,
    next: &'a HashMap<u32, Vec<u32>>,
    calls_of: HashMap<&'a str, Vec<&'a CallFact>>,
    leaving: HashMap<&'a str, Vec<&'a ExitPoint>>,
    exit_records: &'a HashMap<&'a str, Vec<&'a str>>,
    held: &'a HashSet<&'a str>,
    writes_fields: HashSet<&'a str>,
    events: &'a HashSet<&'a str>,
    member_of: HashMap<(&'a str, &'a str), u32>,
    callers: HashMap<u32, u32>,
}

static HANDS_ON: &[&str] = &["dispatch", "emit", "execute", "handle", "invoke", "publish", "raise", "send", "sendasync", "publishasync", "dispatchasync", "trigger"];

static READS_A_RECORD: &[&str] = &[
    "all", "count", "exists", "fetch", "find", "find_by", "findorfail", "first", "firstorfail", "get", "includes",
    "joins", "last", "limit", "order", "paginate", "pluck", "select", "take", "where",
];
static CHANGES_A_RECORD: &[&str] = &[
    "create", "create!", "decrement", "find_or_create_by", "firstorcreate", "firstornew", "increment", "insert",
    "save", "save!", "touch", "update", "update!", "update_all", "updateorcreate", "upsert",
];
static REMOVES_A_RECORD: &[&str] = &["delete", "delete_all", "destroy", "destroy_all", "forcedelete"];

fn by_its_class(verb: &str) -> Option<&'static str> {
    let verb = verb.trim_end_matches(['!', '?']).to_ascii_lowercase();
    let verb = verb.as_str();
    if REMOVES_A_RECORD.contains(&verb) {
        return Some("remove");
    }
    if CHANGES_A_RECORD.contains(&verb) {
        return Some("change");
    }
    READS_A_RECORD.contains(&verb).then_some("read")
}

static RUNS_FIRST: &[&str] = &["append_before_action", "before_action", "before_filter", "prepend_before_action"];

fn singular(word: &str) -> String {
    if let Some(stem) = word.strip_suffix("ies") {
        return format!("{stem}y");
    }
    for ending in ["sses", "shes", "ches", "xes", "uses", "ases"] {
        if let Some(stem) = word.strip_suffix(ending) {
            return format!("{stem}{}", &ending[..ending.len() - 2]);
        }
    }
    word.strip_suffix('s').filter(|stem| !stem.ends_with('s')).unwrap_or(word).to_string()
}

static ACTS_THROUGH_A_LIBRARY: &[&str] = &[
    "accept", "approve", "authenticate", "cancel", "challenge", "charge", "confirm", "consent", "create", "decline",
    "deny", "enqueue", "export", "grant", "import", "invite", "issue", "login", "logout", "notify", "pay", "publish",
    "redeem", "refund", "register", "reject", "reset", "revoke", "schedule", "send", "sign", "subscribe", "unsubscribe",
    "upload",
];

fn acted_through_a_library(member: &str) -> Option<String> {
    let bare = member.split('<').next().unwrap_or(member).trim_end_matches("Async");
    let said = spoken(bare);
    let lowered = said.to_ascii_lowercase();
    let first = lowered.split_whitespace().next()?;
    let acting = ACTS_THROUGH_A_LIBRARY.iter().any(|verb| {
        lowered.split_whitespace().any(|word| word == *verb || word.strip_suffix("in") == Some(verb) || word == format!("{verb}s"))
    });
    (acting && !matches!(first, "get" | "is" | "has" | "to" | "try" | "find" | "on" | "log")).then_some(said)
}

static CHECKS_BY_NAME: &[&str] = &["assert", "authorize", "check", "guard", "validate", "verify"];

fn a_check(callee: &str) -> bool {
    let named = crate::names::leaf(callee).split('<').next().unwrap_or_default().to_ascii_lowercase();
    CHECKS_BY_NAME.iter().any(|word| named.starts_with(word)) && named.len() > 4
}

fn when_of(context: &CallContext) -> &'static str {
    match (context.in_catch, context.conditional_depth > 0) {
        (true, _) => "on_failure",
        (false, true) => "conditionally",
        _ => "always",
    }
}

fn inherited(outer: &'static str, inner: &'static str) -> &'static str {
    match (outer, inner) {
        ("on_failure", _) | (_, "on_failure") => "on_failure",
        ("conditionally", _) | (_, "conditionally") => "conditionally",
        _ => "always",
    }
}

fn plain_type(written: &str) -> Option<String> {
    let mut held = written.trim();
    for wrapper in ["Task<", "ValueTask<", "Promise<", "Observable<", "Mono<", "Flux<", "Future<", "Optional<", "Result<", "Ok<", "IActionResult<", "ActionResult<"] {
        if let Some(inner) = held.strip_prefix(wrapper) {
            held = inner.strip_suffix('>').unwrap_or(inner);
        }
    }
    let named: String = held
        .split(['<', ',', '>', '|', ' ', '[', '('])
        .find(|part| !part.is_empty())
        .unwrap_or_default()
        .to_string();
    let lowered = named.to_ascii_lowercase();
    let says_nothing = named.is_empty()
        || matches!(
            lowered.as_str(),
            "void" | "task" | "valuetask" | "promise" | "iresult" | "iactionresult" | "actionresult" | "results"
                | "any" | "unit" | "none" | "object" | "response" | "httpresponse" | "jsonresult" | "ok"
        );
    (!says_nothing).then_some(named)
}

fn spoken(named: &str) -> String {
    let mut words: Vec<String> = Vec::new();
    let mut held = String::new();
    let mut before: Option<char> = None;
    for letter in named.trim_start_matches('_').chars() {
        let starts = letter.is_uppercase() && before.is_some_and(|was| was.is_lowercase() || was.is_ascii_digit());
        if letter == '_' || starts {
            if !held.is_empty() {
                words.push(std::mem::take(&mut held));
            }
        }
        if letter != '_' {
            held.push(letter.to_ascii_lowercase());
        }
        before = Some(letter);
    }
    if !held.is_empty() {
        words.push(held);
    }
    let mut said = words.join(" ");
    if let Some(first) = said.get_mut(0..1) {
        first.make_ascii_uppercase();
    }
    said
}

fn labelled(kind: &str, object: Option<&str>) -> String {
    let verb = match kind {
        "create" => "Create",
        "raise" => "Raise",
        "check" => "Check",
        "read" => "Read",
        "change" => "Change",
        "remove" => "Remove",
        "hand_off" => "Hand off",
        "call" => "Call",
        "keep" => "Keep",
        "respond" => "Respond with",
        _ => "Do",
    };
    match object {
        Some(object) if kind == "check" && a_check(object.split_whitespace().next().unwrap_or_default()) => object.to_string(),
        Some(object) => format!("{verb} {object}"),
        None => match kind {
            "respond" => "Respond".to_string(),
            _ => verb.to_string(),
        },
    }
}

static REMOVES: &[&str] = &["delete", "destroy", "drop", "purge", "remove", "unlink"];

impl<'a> Reader<'a> {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        nodes: &'a [IndexNode],
        position_of: &'a HashMap<&'a str, u32>,
        next: &'a HashMap<u32, Vec<u32>>,
        calls: &'a [CallFact],
        exits: &'a [ExitPoint],
        exit_records: &'a HashMap<&'a str, Vec<&'a str>>,
        held: &'a HashSet<&'a str>,
        metrics: &'a [UnitMetricsEntry],
        events: &'a HashSet<&'a str>,
    ) -> Self {
        let writes_fields: HashSet<&str> = metrics
            .iter()
            .filter(|entry| !entry.metrics.writes.is_empty())
            .map(|entry| entry.unit.as_str())
            .collect();
        let mut calls_of: HashMap<&str, Vec<&CallFact>> = HashMap::default();
        for call in calls {
            if let Some(caller) = call.caller.as_deref() {
                calls_of.entry(caller).or_default().push(call);
            }
        }
        for held in calls_of.values_mut() {
            held.sort_by_key(|call| (call.line, call.column));
        }
        let mut leaving: HashMap<&str, Vec<&ExitPoint>> = HashMap::default();
        for exit in exits {
            leaving.entry(exit.source.as_str()).or_default().push(exit);
        }
        for held in leaving.values_mut() {
            held.sort_by_key(|exit| exit.line);
        }
        let mut member_of: HashMap<(&str, &str), u32> = HashMap::default();
        for (at, node) in nodes.iter().enumerate() {
            if let Some(parent) = node.parent.as_deref().filter(|_| node.kind.is_unit()) {
                member_of.entry((parent, node.name.as_str())).or_insert(at as u32);
            }
        }
        let mut callers: HashMap<u32, u32> = HashMap::default();
        for targets in next.values() {
            let mut seen: HashSet<u32> = HashSet::default();
            for target in targets {
                if seen.insert(*target) {
                    *callers.entry(*target).or_default() += 1;
                }
            }
        }
        Reader { nodes, position_of, next, calls_of, leaving, exit_records, held, writes_fields, events, member_of, callers }
    }

    fn records_touched(&self, exit: &ExitPoint) -> Option<String> {
        let named = crate::names::root(exit.addressed.as_deref().unwrap_or(&exit.target));
        if self.held.contains(named) {
            return Some(named.to_string());
        }
        let typed = || {
            self.calls_of.get(exit.source.as_str())?.iter().find(|call| call.line == exit.line).and_then(|call| {
                call.type_arguments.first().map(|argument| crate::names::leaf(argument.trim()).to_string())
            })
        };
        let Some(within) = self.exit_records.get(exit.id.as_str()) else { return typed() };
        match within.as_slice() {
            [] => typed(),
            [only] => Some((*only).to_string()),
            many => Some(many.join(" and ")),
        }
    }

    fn action_of(&self, exit: &ExitPoint) -> Option<(&'static str, Option<String>)> {
        let changing = crate::comprehend::changes_something(exit);
        let operation = exit.operation.to_ascii_lowercase();
        let removing = REMOVES.iter().any(|word| operation.contains(word));
        let service = exit.service.clone();
        match exit.kind {
            "database" => {
                let record = self.records_touched(exit).or(service);
                Some(match (changing, removing) {
                    (true, true) => ("remove", record),
                    (true, false) => ("change", record),
                    _ => ("read", record),
                })
            }
            "message" => Some(("hand_off", Some(exit.addressed.clone().unwrap_or_else(|| exit.name.clone())).filter(|held| !held.is_empty()).or(service))),
            "api" | "network" => Some(("call", service.or_else(|| exit.addressed.clone()).or_else(|| Some(exit.target.clone())))),
            "cache" | "client_storage" | "file" => Some((
                if changing { "keep" } else { "read" },
                service.or_else(|| Some(match exit.kind {
                    "client_storage" => "the device".to_string(),
                    "file" => "a file".to_string(),
                    _ => "the cache".to_string(),
                })),
            )),
            "process" => Some(("call", Some(exit.target.clone()))),
            _ => None,
        }
    }

    fn on_a_record_class(&self, call: &CallFact) -> Option<(&'static str, &'a str)> {
        let receiver = call.receiver.as_deref()?;
        let kind = by_its_class(crate::names::leaf(&call.callee))?;
        let named = receiver.trim_start_matches(['$', '@', '\\']).rsplit(['\\', ':']).next().unwrap_or(receiver);
        if let Some(record) = self.held.get(named).copied() {
            return Some((kind, record));
        }
        let first = receiver.split('.').next().unwrap_or(receiver).trim_start_matches(['$', '@', '_']);
        receiver.split('.').skip(1).chain(std::iter::once(first)).find_map(|segment| {
            let segment = segment.trim();
            let end = segment.find(|letter: char| !(letter.is_alphanumeric() || letter == '_')).unwrap_or(segment.len());
            let written = &segment[..end];
            [written.to_string(), singular(written)].into_iter().find_map(|word| {
                let spoken: String = word
                    .split('_')
                    .map(|part| {
                        let mut part = part.to_string();
                        if let Some(first) = part.get_mut(0..1) {
                            first.make_ascii_uppercase();
                        }
                        part
                    })
                    .collect();
                if spoken.is_empty() {
                    return None;
                }
                self.held
                    .get(spoken.as_str())
                    .copied()
                    .or_else(|| self.held.iter().find(|record| record.eq_ignore_ascii_case(&spoken)).copied())
            })
        }).map(|record| (kind, record))
    }

    fn called_before(&self, handler: u32) -> Vec<u32> {
        let node = &self.nodes[handler as usize];
        let Some(owner) = node.parent.as_deref() else { return Vec::new() };
        let Some(owner_at) = self.position_of.get(owner).copied() else { return Vec::new() };
        let mut found = Vec::new();
        for call in self.calls_of.get(owner).into_iter().flatten() {
            if !RUNS_FIRST.contains(&call.callee.as_str()) {
                continue;
            }
            for literal in &call.literals {
                let named = literal.trim().trim_start_matches(':');
                if let Some(at) = self.member_named(owner_at, named) {
                    found.push(at);
                }
            }
        }
        found
    }

    fn member_named(&self, owner: u32, named: &str) -> Option<u32> {
        let owner_id = self.nodes[owner as usize].id.as_str();
        self.member_of.get(&(owner_id, named)).copied()
    }

    fn record_owning(&self, unit: u32) -> Option<&'a str> {
        let node = &self.nodes[unit as usize];
        let parent = self.position_of.get(node.parent.as_deref()?)?;
        let owner = &self.nodes[*parent as usize];
        (owner.kind.is_type()).then_some(())?;
        self.held.get(owner.name.as_str()).copied()
    }

    fn operating_on_a_record(&self, target: u32, when: &'static str, line: u32, unit: u32) -> Option<Action> {
        let node = &self.nodes[target as usize];
        if node.kind.is_type() && self.events.contains(node.name.as_str()) {
            return Some(Action { kind: "raise", object: Some(node.name.clone()), doing: None, when, unit, line });
        }
        if node.kind.is_type() {
            let record = self.held.get(node.name.as_str()).copied()?;
            return Some(Action { kind: "create", object: Some(record.to_string()), doing: None, when, unit, line });
        }
        let record = self.record_owning(target)?;
        if node.name == record {
            return Some(Action { kind: "create", object: Some(record.to_string()), doing: None, when, unit, line });
        }
        if !self.writes_fields.contains(node.id.as_str()) {
            return None;
        }
        Some(Action { kind: "change", object: Some(record.to_string()), doing: Some(spoken(&node.name)), when, unit, line })
    }

    fn walk(&self, unit: u32, depth: u32, when: &'static str, visited: &mut HashSet<u32>, actions: &mut Vec<Action>) {
        if actions.len() >= ACTIONS_AT_MOST || depth > DEEPEST {
            return;
        }
        let node = &self.nodes[unit as usize];
        let id = node.id.as_str();
        let calls = self.calls_of.get(id).map(Vec::as_slice).unwrap_or_default();
        let exits = self.leaving.get(id).map(Vec::as_slice).unwrap_or_default();
        let mut targets: Vec<u32> = self.next.get(&unit).cloned().unwrap_or_default();
        targets.retain(|target| !visited.contains(target));
        let mut at_line: Vec<(u32, u32, Option<u32>, &'static str, Option<&ExitPoint>, Option<&CallFact>)> = Vec::new();
        for exit in exits {
            let context = calls.iter().find(|call| call.line == exit.line).map(|call| when_of(&call.context)).unwrap_or("always");
            at_line.push((exit.line, 0, None, context, Some(exit), None));
        }
        let mut handing_on: Vec<&CallFact> = Vec::new();
        let mut class_calls: Vec<(u32, u32, &'static str, &'a str)> = Vec::new();
        let mut library_calls: Vec<(u32, u32, String)> = Vec::new();
        for call in calls {
            let named = crate::names::leaf(&call.callee).split('<').next().unwrap_or_default();
            if let Some(at) = targets.iter().position(|target| self.nodes[*target as usize].name == named) {
                let target = targets.remove(at);
                at_line.push((call.line, call.column, Some(target), when_of(&call.context), None, Some(call)));
            } else if a_check(&call.callee) {
                at_line.push((call.line, call.column, None, when_of(&call.context), None, Some(call)));
            } else if HANDS_ON.contains(&named.to_ascii_lowercase().as_str()) {
                handing_on.push(call);
            } else if let Some((kind, record)) = self.on_a_record_class(call) {
                at_line.push((call.line, call.column, None, when_of(&call.context), None, Some(call)));
                class_calls.push((call.line, call.column, kind, record));
            } else if depth <= 2
                && call.receiver.is_some()
                && !exits.iter().any(|exit| exit.line == call.line)
                && let Some(doing) = acted_through_a_library(named)
            {
                at_line.push((call.line, call.column, None, when_of(&call.context), None, Some(call)));
                library_calls.push((call.line, call.column, doing));
            }
        }
        for call in handing_on {
            if targets.is_empty() {
                break;
            }
            let target = targets.remove(0);
            at_line.push((call.line, call.column, Some(target), when_of(&call.context), None, Some(call)));
        }
        for target in targets {
            at_line.push((u32::MAX, 0, Some(target), "always", None, None));
        }
        at_line.sort_by_key(|(line, column, ..)| (*line, *column));
        let shown_line = |line: u32| if line == u32::MAX { node.span.end_line } else { line };
        for (line, _, target, context, exit, call) in at_line {
            let context = inherited(when, context);
            if let Some(exit) = exit {
                if let Some((kind, object)) = self.action_of(exit) {
                    actions.push(Action { kind, object, doing: None, when: context, unit, line: shown_line(line) });
                }
                continue;
            }
            match target {
                Some(target) => {
                    let reached = &self.nodes[target as usize];
                    if depth <= 3
                        && reached.id.starts_with("package:")
                        && let Some(doing) = acted_through_a_library(crate::names::leaf(&reached.name))
                    {
                        actions.push(Action { kind: "do", object: None, doing: Some(doing), when: context, unit, line: shown_line(line) });
                        continue;
                    }
                    if let Some(action) = self.operating_on_a_record(target, context, shown_line(line), unit) {
                        actions.push(action);
                    }
                    if visited.insert(target) {
                        let shared = self.callers.get(&target).copied().unwrap_or(0) >= SHARED_BY;
                        let named = self.nodes[target as usize].name.as_str();
                        if shared {
                            let mut within: Vec<Action> = Vec::new();
                            self.walk(target, depth + 1, context, visited, &mut within);
                            let checking = a_check(named);
                            let matters = within.iter().any(|action| match action.kind {
                                "hand_off" | "raise" => true,
                                "change" | "remove" | "create" => {
                                    action.object.as_deref().is_some_and(|object| self.held.contains(object))
                                }
                                "call" => true,
                                "read" | "check" => false,
                                _ => false,
                            });
                            match (matters, within.is_empty()) {
                                (true, _) => actions.extend(within),
                                (false, true) => {}
                                (false, false) => actions.push(Action {
                                    kind: if checking { "check" } else { "do" },
                                    object: checking.then(|| spoken(named)),
                                    doing: (!checking).then(|| spoken(named)),
                                    when: context,
                                    unit,
                                    line: shown_line(line),
                                }),
                            }
                        } else {
                            self.walk(target, depth + 1, context, visited, actions);
                        }
                    }
                }
                None => {
                    if let Some(call) = call {
                        if let Some((_, _, doing)) =
                            library_calls.iter().find(|(held_line, held_column, _)| *held_line == call.line && *held_column == call.column)
                        {
                            actions.push(Action { kind: "do", object: None, doing: Some(doing.clone()), when: context, unit, line: shown_line(line) });
                            continue;
                        }
                        if let Some((_, _, kind, record)) =
                            class_calls.iter().find(|(held_line, held_column, ..)| *held_line == call.line && *held_column == call.column)
                        {
                            if !exits.iter().any(|exit| exit.line == call.line) {
                                actions.push(Action { kind, object: Some(record.to_string()), doing: None, when: context, unit, line: shown_line(line) });
                            }
                            continue;
                        }
                        let named = crate::names::leaf(&call.callee).split('<').next().unwrap_or_default().to_string();
                        actions.push(Action { kind: "check", object: Some(named), doing: None, when: context, unit, line: shown_line(line) });
                    }
                }
            }
        }
    }

    pub fn read(&self, entry: &EntryPoint) -> (Vec<LogicalStep>, Vec<StepEdge>) {
        let Some(start) = self.position_of.get(entry.handler.as_str()).copied() else {
            return (Vec::new(), Vec::new());
        };
        let mut actions: Vec<Action> = Vec::new();
        let first_line = self.nodes[start as usize].span.line;
        if !entry.guards.is_empty() {
            let guarded: Vec<&str> = entry.guards.iter().map(|guard| guard.name.as_str()).collect();
            actions.push(Action {
                kind: "check",
                object: Some(guarded.join(", ")),
                doing: None,
                when: "always",
                unit: start,
                line: first_line,
            });
        }
        let mut visited: HashSet<u32> = HashSet::from_iter([start]);
        for first in self.called_before(start) {
            if visited.insert(first) {
                self.walk(first, 1, "always", &mut visited, &mut actions);
            }
        }
        self.walk(start, 0, "always", &mut visited, &mut actions);
        if matches!(entry.kind, "http" | "rpc" | "graphql") {
            let returned = self.nodes[start as usize]
                .signature
                .as_ref()
                .and_then(|signature| signature.return_type.as_deref())
                .and_then(plain_type);
            actions.push(Action {
                kind: "respond",
                object: returned,
                doing: None,
                when: "always",
                unit: start,
                line: self.nodes[start as usize].span.end_line,
            });
        }
        let mut steps: Vec<LogicalStep> = Vec::new();
        let mut last_when: Vec<&'static str> = Vec::new();
        for action in actions {
            let node = &self.nodes[action.unit as usize];
            let region = Region { unit: node.id.clone(), file: node.file, start_line: action.line, end_line: action.line };
            if let Some(last) = steps.last_mut()
                && last.kind == action.kind
                && last.object == action.object
                && last.doing == action.doing
                && last.when == action.when
            {
                match last.regions.iter_mut().find(|held| held.unit == region.unit) {
                    Some(held) => {
                        held.start_line = held.start_line.min(region.start_line);
                        held.end_line = held.end_line.max(region.end_line);
                    }
                    None => last.regions.push(region),
                }
                continue;
            }
            if steps.len() >= STEPS_AT_MOST {
                break;
            }
            last_when.push(action.when);
            steps.push(LogicalStep {
                id: format!("s{}", steps.len() + 1),
                kind: action.kind,
                label: match (&action.doing, &action.object) {
                    (Some(doing), Some(object)) => format!("{object}: {doing}"),
                    (Some(doing), None) => doing.clone(),
                    _ => labelled(action.kind, action.object.as_deref()),
                },
                object: action.object,
                doing: action.doing,
                when: action.when,
                regions: vec![region],
                description: None,
            });
        }
        let edges = steps
            .windows(2)
            .map(|pair| StepEdge {
                from: pair[0].id.clone(),
                to: pair[1].id.clone(),
                kind: match pair[1].when {
                    "on_failure" => "on_failure",
                    "conditionally" => "when",
                    _ => "then",
                },
            })
            .collect();
        (steps, edges)
    }
}

#[cfg(test)]
mod reading {
    use super::acted_through_a_library;

    #[test]
    fn an_action_taken_through_a_library_is_a_step_and_a_lookup_is_not() {
        assert_eq!(acted_through_a_library("PasswordSignInAsync").as_deref(), Some("Password sign in"));
        assert_eq!(acted_through_a_library("GrantConsentAsync").as_deref(), Some("Grant consent"));
        assert_eq!(acted_through_a_library("RevokeUserConsentAsync").as_deref(), Some("Revoke user consent"));
        assert_eq!(acted_through_a_library("GetAuthorizationContextAsync"), None);
        assert_eq!(acted_through_a_library("ToString"), None);
        assert_eq!(acted_through_a_library("LogInformation"), None);
    }
}
