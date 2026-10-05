use std::collections::BTreeSet;

use rustc_hash::{FxHashMap as HashMap, FxHashSet as HashSet};
use serde::Serialize;

use crate::constants::{Constants, Standing};
use crate::entry_exit::{EntryPoint, ExitPoint, IPC_SCHEME};
use crate::messages::a_tag;
use crate::model::{CallFact, ImportFact, IndexNode, LocalBinding, MessageFact, Said};
use crate::names;
use crate::paths::is_test;
use crate::rules::{event_calls, EventCall, Role};

const MOST_PER_CHANNEL: usize = 24;
const TAGS_THAT_MAKE_A_PROTOCOL: usize = 2;
const WRAPPING_ROUNDS: usize = 3;

static CHANNEL_PARAMETERS: &[&str] = &["channel", "event", "eventName", "event_name", "topic", "topic_name"];

static SEPARATORS: [char; 4] = [':', '.', '-', '/'];

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct Crossing {
    pub kind: &'static str,
    pub communication: &'static str,
    pub channel: String,
    pub from: String,
    pub from_file: u32,
    pub from_line: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub through: Option<String>,
    pub to: String,
    pub to_file: u32,
    pub to_line: u32,
}

struct Site<'a> {
    unit: &'a str,
    file: u32,
    line: u32,
}

fn verb_of(callee: &str) -> &str {
    let spoken = names::leaf(callee);
    spoken.rsplit(' ').next().unwrap_or(spoken)
}

fn fits(rule: &EventCall, verb: &str, receiver: Option<&str>) -> bool {
    rule.verbs.iter().any(|held| held == verb)
        && (rule.receivers.is_empty()
            || receiver.is_some_and(|receiver| rule.receivers.iter().any(|named| named == names::leaf(receiver))))
}

fn roles_called(call: &CallFact) -> Option<Role> {
    let verb = verb_of(&call.callee);
    event_calls()
        .iter()
        .filter(|rule| !rule.wrapped && fits(rule, verb, call.receiver.as_deref()))
        .map(|rule| rule.role)
        .next()
}

fn wrappers(nodes: &[IndexNode], calls: &[CallFact]) -> HashMap<String, Role> {
    let takes_a_channel: HashSet<&str> = nodes
        .iter()
        .filter(|node| node.kind.is_unit())
        .filter(|node| {
            node.signature
                .as_ref()
                .is_some_and(|signature| signature.parameters.iter().any(|parameter| CHANNEL_PARAMETERS.contains(&parameter.name.as_str())))
        })
        .map(|node| node.id.as_str())
        .collect();
    let named: HashMap<&str, &str> = nodes.iter().map(|node| (node.id.as_str(), node.name.as_str())).collect();
    let mut held: HashMap<String, Role> = HashMap::default();
    for _ in 0..WRAPPING_ROUNDS {
        let before = held.len();
        for call in calls {
            let Some(caller) = call.caller.as_deref().filter(|caller| takes_a_channel.contains(caller)) else { continue };
            let verb = verb_of(&call.callee);
            let role = event_calls()
                .iter()
                .find(|rule| rule.wrapped && fits(rule, verb, call.receiver.as_deref()))
                .map(|rule| rule.role)
                .or_else(|| held.get(verb).copied());
            if let (Some(role), Some(name)) = (role, named.get(caller)) {
                held.entry((*name).to_string()).or_insert(role);
            }
        }
        if held.len() == before {
            break;
        }
    }
    held
}

fn channel_in(call: &CallFact, constants: &Constants) -> Vec<String> {
    let standing = Standing { file: call.file, unit: call.caller.as_deref().unwrap_or(""), owner: None, node: None };
    call.literals
        .iter()
        .filter_map(|held| {
            let written = held.split_once('=').map(|(_, value)| value).unwrap_or(held).trim();
            let leaf = written.rsplit("::").next().unwrap_or(written);
            let bare = !leaf.is_empty() && leaf.chars().all(|letter| letter.is_alphanumeric() || letter == '_' || letter == '.');
            let spelled = match bare {
                true => constants.value(&standing, leaf)?,
                false => written.to_string(),
            };
            let channel = a_tag(&spelled)?;
            channel.contains(SEPARATORS).then(|| channel.to_string())
        })
        .collect()
}

fn events(files: &[String], nodes: &[IndexNode], calls: &[CallFact], constants: &Constants) -> Vec<Crossing> {
    let relayed = wrappers(nodes, calls);
    let mut senders: HashMap<String, Vec<Site>> = HashMap::default();
    let mut listeners: HashMap<String, Vec<Site>> = HashMap::default();
    for call in calls {
        let Some(unit) = call.caller.as_deref() else { continue };
        if files.get(call.file as usize).is_none_or(|path| is_test(path)) {
            continue;
        }
        let Some(role) = roles_called(call).or_else(|| relayed.get(verb_of(&call.callee)).copied()) else { continue };
        let held = match role {
            Role::Send => &mut senders,
            Role::Listen => &mut listeners,
        };
        for channel in channel_in(call, constants) {
            held.entry(channel).or_default().push(Site { unit, file: call.file, line: call.line });
        }
    }
    let mut found: BTreeSet<Crossing> = BTreeSet::new();
    for (channel, sending) in &senders {
        let Some(listening) = listeners.get(channel) else { continue };
        let mut kept = 0;
        for (from, to) in sending.iter().flat_map(|from| listening.iter().map(move |to| (from, to))) {
            if from.unit == to.unit || kept >= MOST_PER_CHANNEL {
                continue;
            }
            kept += 1;
            found.insert(Crossing {
                kind: "event",
                communication: "message",
                channel: channel.clone(),
                from: from.unit.to_string(),
                from_file: from.file,
                from_line: from.line,
                through: None,
                to: to.unit.to_string(),
                to_file: to.file,
                to_line: to.line,
            });
        }
    }
    found.into_iter().collect()
}

fn messages(files: &[String], messages: &[MessageFact]) -> Vec<Crossing> {
    let mut sent: HashMap<&str, Vec<&MessageFact>> = HashMap::default();
    let mut handled: HashMap<&str, Vec<&MessageFact>> = HashMap::default();
    for message in messages.iter().filter(|message| files.get(message.file as usize).is_some_and(|path| !is_test(path))) {
        match message.said {
            Said::Sent => sent.entry(message.tag.as_str()).or_default().push(message),
            Said::Handled => handled.entry(message.tag.as_str()).or_default().push(message),
        }
    }
    let mut found: BTreeSet<Crossing> = BTreeSet::new();
    for (tag, sending) in &sent {
        let Some(handling) = handled.get(tag) else { continue };
        let mut kept = 0;
        for (from, to) in sending.iter().flat_map(|from| handling.iter().map(move |to| (from, to))) {
            if from.file == to.file || kept >= MOST_PER_CHANNEL {
                continue;
            }
            kept += 1;
            found.insert(Crossing {
                kind: "network",
                communication: "message",
                channel: tag.to_string(),
                from: from.unit.clone(),
                from_file: from.file,
                from_line: from.line,
                through: None,
                to: to.unit.clone(),
                to_file: to.file,
                to_line: to.line,
            });
        }
    }
    let mut spoken: HashMap<(u32, u32), BTreeSet<&str>> = HashMap::default();
    for crossing in &found {
        spoken.entry((crossing.from_file, crossing.to_file)).or_default().insert(crossing.channel.as_str());
    }
    let protocols: HashSet<(u32, u32)> = spoken
        .into_iter()
        .filter(|(_, tags)| tags.len() >= TAGS_THAT_MAKE_A_PROTOCOL)
        .map(|(pair, _)| pair)
        .collect();
    found.into_iter().filter(|crossing| protocols.contains(&(crossing.from_file, crossing.to_file))).collect()
}

fn commands(entry_points: &[EntryPoint], exit_points: &[ExitPoint], files: &[String]) -> Vec<Crossing> {
    let mut served: HashMap<&str, Vec<&EntryPoint>> = HashMap::default();
    for entry in entry_points.iter().filter(|entry| entry.kind == "ipc") {
        served.entry(entry.name.as_str()).or_default().push(entry);
    }
    let mut found: BTreeSet<Crossing> = BTreeSet::new();
    for exit in exit_points.iter().filter(|exit| exit.kind == "api") {
        let Some(channel) = exit.addressed.as_deref().and_then(|held| held.strip_prefix(IPC_SCHEME)) else { continue };
        let command = served.get(exit.target.as_str()).and_then(|held| held.iter().find(|entry| entry.registrar != crate::entry_exit::HAND_ROLLED_DISPATCH_REGISTRAR));
        let (handlers, through) = match served.get(channel) {
            Some(arms) if channel != exit.target => (arms, command.map(|entry| entry.handler.clone())),
            Some(handlers) => (handlers, None),
            None => match served.get(exit.target.as_str()) {
                Some(handlers) => (handlers, None),
                None => continue,
            },
        };
        for handler in handlers {
            if files.get(handler.file as usize).is_none() {
                continue;
            }
            found.insert(Crossing {
                kind: "ipc",
                communication: "sync",
                channel: channel.to_string(),
                from: exit.source.clone(),
                from_file: exit.file,
                from_line: exit.line,
                through: through.clone(),
                to: handler.handler.clone(),
                to_file: handler.file,
                to_line: handler.line,
            });
        }
    }
    found.into_iter().collect()
}

pub fn derive(
    files: &[String],
    nodes: &[IndexNode],
    calls: &[CallFact],
    locals: &[LocalBinding],
    entry_points: &[EntryPoint],
    exit_points: &[ExitPoint],
    held_messages: &[MessageFact],
    imports: &[ImportFact],
) -> Vec<Crossing> {
    let constants = Constants::new(locals);
    let mut found = commands(entry_points, exit_points, files);
    found.extend(events(files, nodes, calls, &constants));
    found.extend(messages(files, held_messages));
    found.extend(crate::queues::derive(files, nodes, calls, locals, imports));
    found
}
