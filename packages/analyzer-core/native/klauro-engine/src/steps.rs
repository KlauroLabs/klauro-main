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
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub arms: Vec<String>,
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
    arms: Vec<(u64, u16)>,
    writes: bool,
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
    throws: HashMap<&'a str, &'a [String]>,
    events: &'a HashSet<&'a str>,
    requests: &'a HashMap<&'a str, Vec<&'a str>>,
    raised: &'a HashMap<&'a str, Vec<&'a str>>,
    keepers: &'a HashSet<&'a str>,
    member_of: HashMap<(&'a str, &'a str), u32>,
    callers: HashMap<u32, u32>,
    constructors: HashMap<u32, Vec<u32>>,
    kept_in: HashMap<&'a str, Option<&'a str>>,
    carrying: std::cell::RefCell<Vec<(Option<&'a str>, u32)>>,
    depth_now: std::cell::Cell<u32>,
    cut: std::cell::Cell<bool>,
    home: std::cell::RefCell<Option<String>>,
}

const CARRIED_AT_MOST: u32 = 1;

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
    let object: Vec<&str> = lowered.split_whitespace().skip(1).collect();
    let plumbing = object.iter().any(|word| TECHNICAL_OBJECTS.contains(word));
    (acting && !object.is_empty() && !plumbing && !matches!(first, "get" | "is" | "has" | "to" | "try" | "find" | "on" | "log"))
        .then_some(said)
}

static TECHNICAL_OBJECTS: &[&str] = &[
    "builder", "callback", "channel", "client", "command", "connection", "context", "factory", "handler", "listener",
    "logger", "pool", "provider", "reader", "scope", "session", "socket", "stream", "task", "thread", "token", "transaction",
    "writer",
];

static CHECKS_BY_NAME: &[&str] = &["authorize", "check", "guard", "validate", "verify"];

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

fn keeping_verb(method: &str) -> &'static str {
    let words = crate::effects::words_of(method);
    match crate::effects::by_words(method) {
        Some("delete") => "remove",
        Some("write") if words.iter().any(|word| matches!(word.as_str(), "update" | "set" | "patch" | "replace" | "merge")) => "change",
        Some("write" | "send") => "keep",
        _ => "read",
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

pub(crate) fn labelled(kind: &str, object: Option<&str>) -> String {
    let verb = match kind {
        "create" => "Create",
        "raise" => "Raise",
        "check" => "Check",
        "read" => "Read",
        "change" => "Change",
        "remove" => "Remove",
        "hand_off" => "Hand off",
        "send" => "Send",
        "notify" => "Notify",
        "refuse" => "Refuse",
        "navigate" => "Go to",
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

static PLUMBING: &str = include_str!("../data/plumbing_calls.tsv");
static NAVIGATION: &str = include_str!("../data/navigation_calls.tsv");

fn navigates(call: &CallFact) -> bool {
    let named = crate::names::leaf(&call.callee);
    let held = |kind: &'static str| NAVIGATION.lines().filter_map(move |line| line.strip_prefix(kind).and_then(|rest| rest.strip_prefix('\t')));
    let routed = |receiver: &str| {
        let lowered = receiver.to_ascii_lowercase();
        held("receiver").any(|word| lowered.contains(word))
    };
    held("call").any(|call| call == named) && call.receiver.as_deref().is_some_and(routed)
}

fn plumbing(named: &str) -> bool {
    PLUMBING.lines().any(|held| held == named)
}

static COMMITS: &[&str] = &["commit", "commitasync", "flush", "save", "savechanges", "savechangesasync", "saveentitiesasync", "save_changes"];

static REFRESHES: &[&str] = &["refresh", "reload", "refresh_from_db"];

fn guard_named(written: &str) -> String {
    let Some(at) = written.find("Depends(") else { return written.to_string() };
    let inner: String = written[at + "Depends(".len()..].chars().take_while(|letter| letter.is_alphanumeric() || *letter == '_' || *letter == '.').collect();
    let inner = crate::names::leaf(&inner);
    let inner = inner.strip_prefix("get_").unwrap_or(inner);
    match inner.is_empty() {
        true => written.to_string(),
        false => spoken(inner).to_lowercase(),
    }
}


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
        requests: &'a HashMap<&'a str, Vec<&'a str>>,
        raised: &'a HashMap<&'a str, Vec<&'a str>>,
        keepers: &'a HashSet<&'a str>,
        writing_in: &'a HashMap<&'a str, Vec<&'a str>>,
        reading_in: &'a HashMap<&'a str, Vec<&'a str>>,
    ) -> Self {
        let writes_fields: HashSet<&str> = metrics
            .iter()
            .filter(|entry| !entry.metrics.writes.is_empty())
            .map(|entry| entry.unit.as_str())
            .collect();
        let throws: HashMap<&str, &[String]> = metrics
            .iter()
            .filter(|entry| !entry.metrics.throws.is_empty())
            .map(|entry| (entry.unit.as_str(), entry.metrics.throws.as_slice()))
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
        let mut constructors: HashMap<u32, Vec<u32>> = HashMap::default();
        for (at, node) in nodes.iter().enumerate().filter(|(_, node)| node.kind == crate::model::NodeKind::Constructor) {
            if let Some(owner) = node.parent.as_deref().and_then(|parent| position_of.get(parent)) {
                constructors.entry(*owner).or_default().push(at as u32);
            }
        }
        let mut touched_in: HashMap<&str, Vec<&str>> = HashMap::default();
        for (unit, records) in writing_in.iter().chain(reading_in.iter()) {
            let held = touched_in.entry(*unit).or_default();
            for record in records {
                if !held.contains(record) {
                    held.push(record);
                }
            }
        }
        let kept_in: HashMap<&str, Option<&str>> = touched_in
            .into_iter()
            .filter(|(_, records)| !records.is_empty())
            .map(|(unit, records)| match records.as_slice() {
                [only] => (unit, Some(*only)),
                _ => (unit, None),
            })
            .collect();
        Reader { nodes, position_of, next, calls_of, leaving, exit_records, held, writes_fields, throws, events, requests, raised, keepers, member_of, callers, constructors, kept_in, carrying: std::cell::RefCell::new(Vec::new()), depth_now: std::cell::Cell::new(0), cut: std::cell::Cell::new(false), home: std::cell::RefCell::new(None) }
    }

    fn records_touched(&self, exit: &ExitPoint) -> Option<String> {
        let named = crate::names::root(exit.addressed.as_deref().unwrap_or(&exit.target));
        if self.held.contains(named) {
            return Some(named.to_string());
        }
        let typed = || {
            let calls = self.calls_of.get(exit.source.as_str())?;
            calls
                .iter()
                .find(|call| call.line == exit.line)
                .and_then(|call| call.type_arguments.first().map(|argument| crate::names::leaf(argument.trim()).to_string()))
                .or_else(|| {
                    calls
                        .iter()
                        .filter(|call| call.constructs && call.line <= exit.line)
                        .map(|call| crate::names::leaf(&call.callee))
                        .find(|made| self.held.contains(made))
                        .map(str::to_string)
                })
        };
        let Some(within) = self.exit_records.get(exit.id.as_str()) else { return typed() };
        match within.as_slice() {
            [] => typed(),
            [only] => Some((*only).to_string()),
            many => Some(many.join(" and ")),
        }
    }

    fn carried(&self) -> Option<String> {
        self.carrying
            .borrow()
            .last()
            .filter(|(_, at)| self.depth_now.get() <= at + CARRIED_AT_MOST)
            .and_then(|(record, _)| *record)
            .map(str::to_string)
    }

    fn action_of(&self, exit: &ExitPoint) -> Option<(&'static str, Option<String>)> {
        let does = exit.does.unwrap_or_else(|| crate::effects::does(exit));
        let service = exit.service.clone();
        match exit.kind {
            "database" => {
                let record = self.records_touched(exit).or(service);
                match does {
                    "prepare" => None,
                    "delete" => Some(("remove", record)),
                    "write" | "send" | "start" => Some(("change", record)),
                    _ => Some(("read", record)),
                }
            }
            "message" => Some(("hand_off", Some(exit.addressed.clone().unwrap_or_else(|| exit.name.clone())).filter(|held| !held.is_empty()).or(service))),
            "api" | "network" => Some(("call", service.or_else(|| exit.addressed.clone()).or_else(|| Some(exit.target.clone())))),
            "cache" | "client_storage" | "file" => {
                let carried = self.carried();
                let own = self.exit_records.get(exit.id.as_str()).and_then(|within| match within.as_slice() {
                    [only] => Some((*only).to_string()),
                    _ => None,
                });
                let place = own.or(carried).or(service).or_else(|| Some(match exit.kind {
                    "client_storage" => "the device".to_string(),
                    "file" => "a file".to_string(),
                    _ => "the cache".to_string(),
                }));
                match does {
                    "prepare" => None,
                    "delete" => Some(("remove", place)),
                    "write" | "send" | "start" => Some(("keep", place)),
                    _ => Some(("read", place)),
                }
            }
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

    fn keeps(&self, target: u32) -> bool {
        let owner_keeps = |unit: u32| {
            self.nodes[unit as usize]
                .parent
                .as_deref()
                .is_some_and(|parent| self.keepers.contains(parent))
        };
        let declared_only = self.nodes[target as usize]
            .parent
            .as_deref()
            .and_then(|parent| self.position_of.get(parent))
            .is_some_and(|owner| self.nodes[*owner as usize].kind == crate::model::NodeKind::Interface);
        owner_keeps(target) || (declared_only && self.next.get(&target).into_iter().flatten().any(|inner| owner_keeps(*inner)))
    }

    fn kept_by(&self, call: &CallFact, calls: &[&CallFact]) -> Option<String> {
        let held = |named: &str| self.held.get(crate::names::leaf(named).split('<').next().unwrap_or_default()).map(|record| record.to_string());
        calls
            .iter()
            .filter(|other| other.line == call.line && other.constructs)
            .find_map(|other| held(&other.callee))
            .or_else(|| call.type_arguments.iter().find_map(|argument| held(argument)))
            .or_else(|| {
                call.literals.iter().find_map(|literal| {
                    let bare = literal.trim().trim_start_matches(['_', '@', '$']);
                    self.held.iter().copied().filter(|record| record.starts_with(char::is_uppercase)).find(|record| record.eq_ignore_ascii_case(bare)).map(str::to_string)
                })
            })
            .or_else(|| self.named_within(crate::names::leaf(&call.callee)))
            .or_else(|| self.named_within(crate::names::leaf(call.receiver.as_deref()?)))
    }

    fn named_within(&self, written: &str) -> Option<String> {
        let words: String = crate::effects::words_of(written).concat();
        let mut named: Vec<&str> = self
            .held
            .iter()
            .copied()
            .filter(|record| record.starts_with(char::is_uppercase))
            .filter(|record| {
                let spoken = record.to_ascii_lowercase();
                words.contains(&spoken) || words.contains(&singular(&spoken))
            })
            .collect();
        if named.is_empty() {
            named = self
                .held
                .iter()
                .copied()
                .filter(|record| record.starts_with(char::is_uppercase))
                .filter(|record| {
                    let last = crate::effects::words_of(record).pop().unwrap_or_default();
                    last.len() > 3 && words.contains(&last)
                })
                .collect();
        }
        named.sort_by_key(|record| std::cmp::Reverse(record.len()));
        named.first().map(|record| record.to_string())
    }

    fn operating_on_a_record(&self, target: u32, when: &'static str, line: u32, unit: u32) -> Option<Action> {
        let node = &self.nodes[target as usize];
        if self.events.contains(node.name.as_str()) && (node.kind.is_type() || self.record_owning(target).is_none()) {
            return Some(Action { kind: "raise", object: Some(node.name.clone()), doing: None, when, arms: Vec::new(), writes: false, unit, line });
        }
        if node.kind.is_type() {
            let record = self.held.get(node.name.as_str()).copied()?;
            return Some(Action { kind: "create", object: Some(record.to_string()), doing: None, when, arms: Vec::new(), writes: false, unit, line });
        }
        let record = self.record_owning(target)?;
        if node.name == record {
            return Some(Action { kind: "create", object: Some(record.to_string()), doing: None, when, arms: Vec::new(), writes: false, unit, line });
        }
        if !self.writes_fields.contains(node.id.as_str()) {
            return None;
        }
        Some(Action { kind: "change", object: Some(record.to_string()), doing: Some(spoken(&node.name)), when, arms: Vec::new(), writes: false, unit, line })
    }

    fn walk(&self, unit: u32, depth: u32, when: &'static str, arms: &[(u64, u16)], visited: &mut HashSet<u32>, actions: &mut Vec<Action>) {
        if actions.len() >= ACTIONS_AT_MOST || depth > DEEPEST {
            self.cut.set(true);
            return;
        }
        let node = &self.nodes[unit as usize];
        let id = node.id.as_str();
        let carried = self.kept_in.get(id).copied();
        if let Some(record) = carried {
            self.carrying.borrow_mut().push((record, depth));
        }
        let was = self.depth_now.replace(depth);
        self.walking(unit, depth, when, arms, visited, actions);
        self.depth_now.set(was);
        if carried.is_some() {
            self.carrying.borrow_mut().pop();
        }
    }

    fn walking(&self, unit: u32, depth: u32, when: &'static str, arms: &[(u64, u16)], visited: &mut HashSet<u32>, actions: &mut Vec<Action>) {
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
        let mut request_calls: Vec<(u32, u32, &'a str)> = Vec::new();
        let mut keeping_calls: Vec<(u32, &'static str, Option<String>)> = Vec::new();
        let mut requesting_lines: HashSet<u32> = HashSet::default();
        let mut sent_to: HashSet<u32> = HashSet::default();
        for call in calls.iter().filter(|call| call.constructs) {
            let named = crate::names::leaf(&call.callee).split('<').next().unwrap_or_default();
            if let Some((message, handlers)) = self.requests.get_key_value(named) {
                requesting_lines.insert(call.line);
                request_calls.push((call.line, call.column, message));
                at_line.push((call.line, call.column, None, when_of(&call.context), None, Some(call)));
                for handler in handlers {
                    let Some(position) = self.position_of.get(handler).copied() else { continue };
                    if let Some(at) = targets.iter().position(|target| *target == position) {
                        targets.remove(at);
                        sent_to.insert(position);
                        at_line.push((call.line, call.column + 1, Some(position), when_of(&call.context), None, None));
                    }
                }
            }
        }
        for call in calls.iter().filter(|call| call.constructs) {
            let named = crate::names::leaf(&call.callee).split('<').next().unwrap_or_default();
            for handler in self.raised.get(named).into_iter().flatten() {
                let Some(position) = self.position_of.get(handler).copied() else { continue };
                if visited.contains(&position) || !sent_to.insert(position) {
                    continue;
                }
                if let Some(at) = targets.iter().position(|target| *target == position) {
                    targets.remove(at);
                }
                at_line.push((call.line, call.column + 1, Some(position), when_of(&call.context), None, None));
            }
        }
        let thrown_here: &[String] = self.throws.get(id).copied().unwrap_or_default();
        let mut refusals: Vec<(u32, u32, String, Option<String>)> = Vec::new();
        let mut navigations: Vec<(u32, u32, Option<String>)> = Vec::new();
        for call in calls {
            let named = crate::names::leaf(&call.callee).split('<').next().unwrap_or_default();
            if call.constructs && self.requests.contains_key(named) {
                continue;
            }
            if navigates(call) {
                if let Some(at) = targets.iter().position(|target| self.nodes[*target as usize].name == named) {
                    targets.remove(at);
                }
                let place = call.literals.iter().find(|literal| literal.contains('/') || literal.starts_with('"')).map(|literal| literal.trim_matches(['"', '\'']).to_string());
                navigations.push((call.line, call.column, place));
                at_line.push((call.line, call.column, None, when_of(&call.context), None, Some(call)));
                continue;
            }
            if plumbing(named) {
                if let Some(at) = targets.iter().position(|target| self.nodes[*target as usize].name == named) {
                    targets.remove(at);
                }
                continue;
            }
            if call.constructs && thrown_here.iter().any(|thrown| crate::names::leaf(thrown) == named) {
                let at_home = *self.home.borrow() == node.project;
                if depth <= 1 && at_home && inherited(when, when_of(&call.context)) == "always" {
                    let said = call.literals.iter().find(|literal| literal.contains(' ')).map(|literal| literal.trim_matches(['"', '\'', '$']).to_string());
                    refusals.push((call.line, call.column, named.to_string(), said));
                    at_line.push((call.line, call.column, None, "always", None, Some(call)));
                }
                continue;
            }
            if requesting_lines.contains(&call.line) {
                if let Some(at) = targets
                    .iter()
                    .position(|target| crate::names::leaf(&self.nodes[*target as usize].name) == named)
                {
                    targets.remove(at);
                }
                continue;
            }
            if let Some(at) = targets.iter().position(|target| self.nodes[*target as usize].name == named) {
                let target = targets.remove(at);
                if self.keeps(target) {
                    keeping_calls.push((target, keeping_verb(named), self.kept_by(call, calls)));
                }
                at_line.push((call.line, call.column, Some(target), when_of(&call.context), None, Some(call)));
            } else if a_check(&call.callee) {
                at_line.push((call.line, call.column, None, when_of(&call.context), None, Some(call)));
            } else if HANDS_ON.contains(&named.to_ascii_lowercase().as_str()) {
                handing_on.push(call);
            } else if call.constructs && let Some(event) = self.events.get(named).copied() {
                at_line.push((call.line, call.column, None, when_of(&call.context), None, Some(call)));
                class_calls.push((call.line, call.column, "raise", event));
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
            let inner = &self.nodes[target as usize];
            let line = match inner.id.contains(":callback:") && inner.file == node.file {
                true => inner.span.line,
                false => u32::MAX,
            };
            at_line.push((line, 0, Some(target), "always", None, None));
        }
        at_line.sort_by_key(|(line, column, ..)| (*line, *column));
        let shown_line = |line: u32| if line == u32::MAX { node.span.end_line } else { line };
        for (line, _, target, context, exit, call) in at_line {
            let context = inherited(when, context);
            let here: Vec<(u64, u16)> = arms
                .iter()
                .copied()
                .chain(
                    call.or_else(|| exit.and_then(|exit| calls.iter().copied().find(|held| held.line == exit.line)))
                        .map(|held| held.context.arms.clone())
                        .unwrap_or_default(),
                )
                .collect();
            if let Some(exit) = exit {
                let operation = crate::names::leaf(&exit.operation).to_ascii_lowercase();
                if REFRESHES.contains(&operation.as_str()) {
                    continue;
                }
                if COMMITS.contains(&operation.as_str()) {
                    actions.push(Action { kind: "commit", object: exit.service.clone(), doing: None, when: context, arms: here.clone(), writes: true, unit, line: shown_line(line) });
                    continue;
                }
                if let Some((kind, object)) = self.action_of(exit) {
                    let writes = matches!(exit.does.unwrap_or_else(|| crate::effects::does(exit)), "write" | "delete" | "send" | "start");
                    actions.push(Action { kind, object, doing: None, when: context, arms: here.clone(), writes, unit, line: shown_line(line) });
                }
                continue;
            }
            if let Some(target) = target
                && !self.nodes[target as usize].id.starts_with("package:")
                && !self.nodes[target as usize].id.starts_with("runtime:")
                && matches!(self.nodes[target as usize].kind, crate::model::NodeKind::Function | crate::model::NodeKind::Method)
                && self.nodes[target as usize].project.is_some()
                && *self.home.borrow() != self.nodes[target as usize].project
                && !sent_to.contains(&target)
                && !keeping_calls.iter().any(|(held, ..)| *held == target)
            {
                let mut within: Vec<Action> = Vec::new();
                if visited.insert(target) {
                    self.walk(target, depth + 1, context, &here, visited, &mut within);
                }
                let (handing, rest): (Vec<Action>, Vec<Action>) =
                    within.into_iter().partition(|action| matches!(action.kind, "hand_off" | "send" | "notify"));
                let strongest = ["remove", "keep", "change", "call", "read"]
                    .into_iter()
                    .find(|kind| rest.iter().any(|action| action.kind == *kind));
                if let Some(kind) = strongest.filter(|_| handing.is_empty()) {
                    actions.push(Action {
                        kind,
                        object: None,
                        doing: Some(spoken(&self.nodes[target as usize].name)),
                        when: context,
                        arms: here.clone(),
                        writes: rest.iter().any(|action| action.writes),
                        unit,
                        line: shown_line(line),
                    });
                }
                actions.extend(handing);
                continue;
            }
            if let Some(target) = target
                && let Some((_, verb, kept)) = keeping_calls.iter().find(|(held, ..)| *held == target)
            {
                let mut within: Vec<Action> = Vec::new();
                if visited.insert(target) {
                    self.walk(target, depth + 1, context, &here, visited, &mut within);
                }
                let removes = within.iter().any(|action| action.kind == "remove");
                let stores = within.iter().any(|action| action.kind == "keep");
                let writes = within.iter().any(|action| matches!(action.kind, "change" | "commit"));
                let kind = match (removes, stores, writes, within.is_empty()) {
                    (true, ..) => "remove",
                    (false, true, ..) => "keep",
                    (false, false, true, _) if *verb != "read" => verb,
                    (false, false, true, _) => "change",
                    (false, false, false, true) => verb,
                    (false, false, false, false) => "read",
                };
                let object = kept.clone().or_else(|| {
                    within
                        .iter()
                        .filter_map(|action| action.object.clone())
                        .find(|object| self.held.contains(object.as_str()))
                        .or_else(|| within.iter().find_map(|action| action.object.clone()))
                });
                if object.is_some() {
                    actions.push(Action { kind, object, doing: None, when: context, arms: here.clone(), writes: kind != "read", unit, line: shown_line(line) });
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
                        actions.push(Action { kind: "do", object: None, doing: Some(doing), when: context, arms: here.clone(), writes: false, unit, line: shown_line(line) });
                        continue;
                    }
                    if let Some(mut action) = self.operating_on_a_record(target, context, shown_line(line), unit) {
                        action.arms = here.clone();
                        actions.push(action);
                    }
                    let before = actions.len();
                    let built = &self.nodes[target as usize];
                    if built.kind.is_type()
                        && let Some(made_by) = self.constructors.get(&target)
                        && visited.insert(target)
                    {
                        let own = built.name.as_str();
                        for constructor in made_by {
                            if !visited.insert(*constructor) {
                                continue;
                            }
                            let mut within: Vec<Action> = Vec::new();
                            self.walk(*constructor, depth + 1, context, &here, visited, &mut within);
                            actions.extend(within.into_iter().filter(|action| !(matches!(action.kind, "change" | "create" | "read") && action.object.as_deref() == Some(own))));
                        }
                        continue;
                    }
                    if visited.insert(target) {
                        let shared = self.callers.get(&target).copied().unwrap_or(0) >= SHARED_BY;
                        let named = self.nodes[target as usize].name.as_str();
                        if shared {
                            let mut within: Vec<Action> = Vec::new();
                            self.walk(target, depth + 1, context, &here, visited, &mut within);
                            let checking = a_check(named);
                            let persists = within.iter().any(|action| match action.kind {
                                "hand_off" | "raise" | "send" | "notify" | "keep" | "remove" | "commit" => true,
                                "change" => action.object.as_deref().is_some_and(|object| self.held.contains(object)) || action.writes,
                                "call" => action.writes,
                                _ => false,
                            });
                            let matters = persists;
                            let looked_up = within.iter().find_map(|action| {
                                (action.kind == "read").then_some(action.object.as_deref()).flatten().filter(|object| self.held.contains(object)).map(str::to_string)
                            });
                            match (matters, within.is_empty()) {
                                (true, _) => actions.extend(within),
                                (false, true) => {}
                                (false, false) if !checking && looked_up.is_some() => actions.push(Action {
                                    kind: "read",
                                    object: looked_up,
                                    doing: None,
                                    when: context,
                                    arms: here.clone(), writes: false,
                                    unit,
                                    line: shown_line(line),
                                }),
                                (false, false) => actions.push(Action {
                                    kind: if checking { "check" } else { "do" },
                                    object: checking.then(|| spoken(named)),
                                    doing: (!checking).then(|| spoken(named)),
                                    when: context,
                                    arms: here.clone(), writes: false,
                                    unit,
                                    line: shown_line(line),
                                }),
                            }
                        } else {
                            let mut within: Vec<Action> = Vec::new();
                            self.walk(target, depth + 1, context, &here, visited, &mut within);
                            let about_records = within.iter().any(|action| {
                                matches!(action.kind, "hand_off" | "raise" | "send" | "notify" | "refuse" | "respond")
                                    || (action.kind == "call" && action.writes)
                                    || action.object.as_deref().is_some_and(|object| self.held.contains(object))
                            });
                            let own = !reached.id.starts_with("package:") && !reached.id.starts_with("runtime:");
                            if about_records || !own || within.len() < 2 {
                                actions.extend(within);
                            } else {
                                let strongest = ["remove", "keep", "change", "create", "call", "read"]
                                    .into_iter()
                                    .find(|kind| within.iter().any(|action| action.kind == *kind))
                                    .unwrap_or("do");
                                actions.push(Action {
                                    kind: strongest,
                                    object: None,
                                    doing: Some(spoken(named)),
                                    when: context,
                                    arms: here.clone(),
                                    writes: within.iter().any(|action| action.writes),
                                    unit,
                                    line: shown_line(line),
                                });
                            }
                        }
                    }
                    let callee = self.nodes[target as usize].name.as_str();
                    let own = !self.nodes[target as usize].id.starts_with("package:") && !self.nodes[target as usize].id.starts_with("runtime:");
                    let awaited = call.is_some_and(|call| call.context.awaited);
                    if own && awaited && actions.len() == before && !callee.is_empty() && crate::effects::by_words(callee) == Some("send") {
                        actions.push(Action { kind: "notify", object: None, doing: Some(spoken(callee)), when: context, arms: here.clone(), writes: true, unit, line: shown_line(line) });
                    }
                }
                None => {
                    if let Some(call) = call {
                        if let Some((_, _, place)) = navigations.iter().find(|(held_line, held_column, _)| *held_line == call.line && *held_column == call.column) {
                            actions.push(Action { kind: "navigate", object: place.clone(), doing: None, when: context, arms: here.clone(), writes: false, unit, line: shown_line(line) });
                            continue;
                        }
                        if let Some((_, _, thrown, said)) =
                            refusals.iter().find(|(held_line, held_column, ..)| *held_line == call.line && *held_column == call.column)
                        {
                            actions.push(Action { kind: "refuse", object: Some(thrown.clone()), doing: said.clone(), when: context, arms: here.clone(), writes: false, unit, line: shown_line(line) });
                            continue;
                        }
                        if let Some((_, _, message)) =
                            request_calls.iter().find(|(held_line, held_column, _)| *held_line == call.line && *held_column == call.column)
                        {
                            actions.push(Action { kind: "send", object: Some(message.to_string()), doing: None, when: context, arms: here.clone(), writes: false, unit, line: shown_line(line) });
                            continue;
                        }
                        if let Some((_, _, doing)) =
                            library_calls.iter().find(|(held_line, held_column, _)| *held_line == call.line && *held_column == call.column)
                        {
                            actions.push(Action { kind: "do", object: None, doing: Some(doing.clone()), when: context, arms: here.clone(), writes: false, unit, line: shown_line(line) });
                            continue;
                        }
                        if let Some((_, _, kind, record)) =
                            class_calls.iter().find(|(held_line, held_column, ..)| *held_line == call.line && *held_column == call.column)
                        {
                            if !exits.iter().any(|exit| exit.line == call.line) {
                                actions.push(Action { kind, object: Some(record.to_string()), doing: None, when: context, arms: here.clone(), writes: false, unit, line: shown_line(line) });
                            }
                            continue;
                        }
                        let named = crate::names::leaf(&call.callee).split('<').next().unwrap_or_default().to_string();
                        actions.push(Action { kind: "check", object: Some(named), doing: None, when: context, arms: here.clone(), writes: false, unit, line: shown_line(line) });
                    }
                }
            }
        }
    }

    pub fn read(&self, entry: &EntryPoint) -> (Vec<LogicalStep>, Vec<StepEdge>, bool) {
        let Some(start) = self.position_of.get(entry.handler.as_str()).copied() else {
            return (Vec::new(), Vec::new(), false);
        };
        self.cut.set(false);
        *self.home.borrow_mut() = self.nodes[start as usize].project.clone();
        let mut actions: Vec<Action> = Vec::new();
        let first_line = self.nodes[start as usize].span.line;
        if !entry.guards.is_empty() {
            let guarded: Vec<String> = entry.guards.iter().map(|guard| guard_named(&guard.name)).collect();
            actions.push(Action {
                kind: "check",
                object: Some(guarded.join(", ")),
                doing: None,
                when: "always",
                arms: Vec::new(), writes: false,
                unit: start,
                line: first_line,
            });
        }
        let mut visited: HashSet<u32> = HashSet::from_iter([start]);
        for first in self.called_before(start) {
            if visited.insert(first) {
                self.walk(first, 1, "always", &[], &mut visited, &mut actions);
            }
        }
        self.walk(start, 0, "always", &[], &mut visited, &mut actions);
        if matches!(entry.kind, "http" | "rpc" | "graphql" | "export") {
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
                arms: Vec::new(), writes: false,
                unit: start,
                line: self.nodes[start as usize].span.end_line,
            });
        }
        let mut settled: Vec<Action> = Vec::new();
        for mut action in actions {
            let changed = settled.iter().any(|held| matches!(held.kind, "change" | "create" | "remove" | "keep"));
            if action.kind == "respond" && settled.iter().any(|held| held.kind == "refuse" && held.when == "always") {
                continue;
            }
            if action.kind == "notify"
                && settled.iter().rev().take_while(|last| last.unit == action.unit && last.line == action.line).any(|last| matches!(last.kind, "hand_off" | "send"))
            {
                continue;
            }
            match action.kind {
                "commit" if changed => continue,
                "commit" => action.kind = "change",
                "create" if settled.last().is_some_and(|last| last.kind == "keep" && last.object == action.object) => continue,
                "keep" if settled.last().is_some_and(|last| last.kind == "create" && last.object == action.object) => {
                    settled.pop();
                }
                "keep" | "read" if action.object.is_none() && settled.last().is_some_and(|last| last.line == action.line && last.unit == action.unit) => continue,
                "keep" | "read" if settled.iter().rev().take_while(|last| last.line == action.line && last.unit == action.unit).any(|last| matches!(last.kind, "hand_off" | "send")) => continue,
                "keep" | "read" if action.object.is_none() && action.doing.is_none() => continue,
                _ => {}
            }
            settled.push(action);
        }
        let mut steps: Vec<LogicalStep> = Vec::new();
        let mut last_when: Vec<&'static str> = Vec::new();
        for action in settled {
            let node = &self.nodes[action.unit as usize];
            let region = Region { unit: node.id.clone(), file: node.file, start_line: action.line, end_line: action.line };
            let armed: Vec<String> = action.arms.iter().map(|(branch, arm)| format!("{branch:x}.{arm}")).collect();
            if let Some(last) = steps.last_mut()
                && last.kind == action.kind
                && last.object == action.object
                && last.doing == action.doing
                && (last.arms == armed || action.kind == "read")
            {
                let shared = last.arms.iter().zip(armed.iter()).take_while(|(left, right)| left == right).count();
                last.arms.truncate(shared);
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
                self.cut.set(true);
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
                arms: armed,
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
        (steps, edges, self.cut.get())
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
