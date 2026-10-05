use std::sync::OnceLock;

use crate::names;

static REGISTRARS: &str = include_str!("../data/registrars.tsv");
static IPC_CALLS: &str = include_str!("../data/ipc_calls.tsv");
static EVENT_CALLS: &str = include_str!("../data/event_calls.tsv");

enum Fold {
    Lower,
    Exact,
    Mapped,
}

enum Receiver {
    Any,
    Named(String),
    LeafEndsWith(String),
    RootEndsWith(String),
}

enum Label {
    Any,
    Route,
    Path,
    RouteOrSlash,
}

struct Registrar {
    kind: &'static str,
    fold: Fold,
    verbs: Vec<String>,
    receivers: Vec<Receiver>,
    label: Label,
    stop: bool,
}

pub struct IpcCall {
    pub receiver: Option<String>,
    pub verbs: Vec<String>,
    pub imported_from: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Role {
    Send,
    Listen,
}

pub struct EventCall {
    pub role: Role,
    pub verbs: Vec<String>,
    pub receivers: Vec<String>,
    pub wrapped: bool,
}

fn fields(line: &str) -> Vec<&str> {
    line.split('\t').collect()
}

fn registrars() -> &'static [Registrar] {
    static HELD: OnceLock<Vec<Registrar>> = OnceLock::new();
    HELD.get_or_init(|| {
        REGISTRARS
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| {
                let held = fields(line);
                Registrar {
                    kind: Box::leak(held[0].to_string().into_boxed_str()),
                    fold: match held[1] {
                        "lower" => Fold::Lower,
                        "mapped" => Fold::Mapped,
                        _ => Fold::Exact,
                    },
                    verbs: held[2].split(',').filter(|verb| *verb != "-").map(str::to_string).collect(),
                    receivers: held[3]
                        .split(',')
                        .map(|token| match token {
                            "*" => Receiver::Any,
                            _ => match (token.strip_prefix('~'), token.strip_prefix('^')) {
                                (Some(ending), _) => Receiver::LeafEndsWith(ending.to_string()),
                                (_, Some(ending)) => Receiver::RootEndsWith(ending.to_string()),
                                _ => Receiver::Named(token.to_ascii_lowercase()),
                            },
                        })
                        .collect(),
                    label: match held[4] {
                        "route" => Label::Route,
                        "path" => Label::Path,
                        "route-or-slash" => Label::RouteOrSlash,
                        _ => Label::Any,
                    },
                    stop: held[5] == "stop",
                }
            })
            .collect()
    })
}

fn receiver_fits(receivers: &[Receiver], registrar: &str) -> bool {
    let receiver = registrar.rfind('.').map(|at| &registrar[..at]);
    receivers.iter().any(|wanted| match (wanted, receiver) {
        (Receiver::Any, _) => true,
        (_, None) => false,
        (Receiver::Named(name), Some(held)) => names::root(held).to_ascii_lowercase() == *name,
        (Receiver::LeafEndsWith(ending), Some(held)) => {
            held.rsplit(['.', ':']).next().unwrap_or(held).to_ascii_lowercase().ends_with(ending.as_str())
        }
        (Receiver::RootEndsWith(ending), Some(held)) => {
            names::root(held).to_ascii_lowercase().ends_with(ending.as_str())
        }
    })
}

fn label_fits(shape: &Label, registrar: &str, verb: &str, label: Option<&str>, in_a_routing_dsl: bool) -> bool {
    let route = |held: &str| crate::entry_exit::looks_like_route(&crate::entry_exit::split_label(held).1);
    match (shape, label) {
        (Label::Any, _) => true,
        (_, None) => false,
        (Label::Route, Some(held)) => route(held),
        (Label::Path, Some(held)) => crate::entry_exit::looks_like_path(held),
        (Label::RouteOrSlash, Some(held)) => {
            let through_receiver = verb.len() != registrar.len();
            let on_a_router = crate::entry_exit::registered_on_a_router(registrar);
            let path = crate::entry_exit::split_label(held).1;
            let addresses_a_path = match through_receiver {
                true => on_a_router || path.contains('/'),
                false => in_a_routing_dsl || path.contains('/'),
            };
            route(held) && addresses_a_path && spells_a_path(&path)
        }
    }
}

fn spells_a_path(path: &str) -> bool {
    !path.contains(['<', '>', '"', '\'', '\\', '`']) && !crate::entry_exit::names_an_http_method(path)
}

pub fn registrar_kind(registrar: &str, label: Option<&str>, in_a_routing_dsl: bool) -> Option<&'static str> {
    let verb = names::leaf(registrar);
    let lowered = verb.to_ascii_lowercase();
    for rule in registrars() {
        let verb_fits = match rule.fold {
            Fold::Lower => rule.verbs.iter().any(|held| *held == lowered),
            Fold::Exact => rule.verbs.iter().any(|held| held == verb),
            Fold::Mapped => crate::entry_exit::mapped_method(verb).is_some(),
        };
        if !verb_fits || !receiver_fits(&rule.receivers, registrar) {
            continue;
        }
        if label_fits(&rule.label, registrar, verb, label, in_a_routing_dsl) {
            return Some(rule.kind);
        }
        if rule.stop {
            return None;
        }
    }
    None
}

pub fn ipc_calls() -> &'static [IpcCall] {
    static HELD: OnceLock<Vec<IpcCall>> = OnceLock::new();
    HELD.get_or_init(|| {
        IPC_CALLS
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| {
                let held = fields(line);
                IpcCall {
                    receiver: Some(held[0].to_string()).filter(|named| named != "-"),
                    verbs: held[1].split(',').map(str::to_string).collect(),
                    imported_from: Some(held[2].to_string()).filter(|named| named != "-"),
                }
            })
            .collect()
    })
}

pub fn event_calls() -> &'static [EventCall] {
    static HELD: OnceLock<Vec<EventCall>> = OnceLock::new();
    HELD.get_or_init(|| {
        EVENT_CALLS
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| {
                let held = fields(line);
                EventCall {
                    role: if held[0] == "send" { Role::Send } else { Role::Listen },
                    verbs: held[1].split(',').map(str::to_string).collect(),
                    receivers: held[2].split(',').filter(|named| *named != "*").map(str::to_string).collect(),
                    wrapped: held[3] == "wrapped",
                }
            })
            .collect()
    })
}
