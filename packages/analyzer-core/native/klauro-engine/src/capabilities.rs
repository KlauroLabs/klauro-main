use std::collections::{BTreeMap, BTreeSet};

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::author::{Placed, Proposal, Proposed};
use crate::comprehend::{carved_name, settle, Capability, Delivery, Family, Flow, PUBLISHED};

const FAMILIES_PER_PROPOSAL: usize = 20;
const READINGS: usize = 3;

fn most_detailed_reading(said: &str, listed: &[(String, String)]) -> Proposal {
    let orders: Vec<Vec<(String, String)>> = (0..READINGS)
        .map(|at| {
            let mut ordered = listed.to_vec();
            match at {
                0 => {}
                1 => ordered.reverse(),
                _ => ordered.rotate_left(listed.len() / 2),
            }
            ordered
        })
        .collect();
    let readings: Vec<Proposal> = orders
        .par_iter()
        .map(|ordered| crate::author::propose_capabilities(said, ordered))
        .collect();
    let settled = |reading: &Proposal| {
        let named: BTreeSet<&str> = reading
            .capabilities
            .iter()
            .flat_map(|held| held.families.iter().map(String::as_str))
            .chain(reading.plumbing.iter().map(String::as_str))
            .collect();
        listed.iter().filter(|(id, _)| named.contains(id.as_str())).count()
    };
    readings
        .into_iter()
        .enumerate()
        .max_by_key(|(at, reading)| {
            (settled(reading), reading.capabilities.len(), std::cmp::Reverse(reading.plumbing.len()), std::cmp::Reverse(*at))
        })
        .map(|(_, reading)| reading)
        .unwrap_or_default()
}
const SURFACES_SHOWN: usize = 6;
const CAPABILITIES_CONSOLIDATED_AT_ONCE: usize = 160;

struct Held {
    name: String,
    description: String,
    audience: String,
    families: BTreeSet<String>,
}

#[derive(Serialize, Deserialize, Default)]
struct Remembered {
    digest: String,
    capabilities: Vec<RememberedCapability>,
    plumbing: BTreeSet<String>,
    families: BTreeMap<String, String>,
}

#[derive(Serialize, Deserialize)]
struct RememberedCapability {
    name: String,
    description: String,
    audience: String,
    families: BTreeSet<String>,
}

pub(crate) type Fields = BTreeMap<String, String>;

const RECORDS_DESCRIBED: usize = 4;

static SERVED_KINDS: &[&str] = &["background", "cli", "event", "graphql", "http", "message", "rpc", "schedule", "websocket"];

pub(crate) const RECORDS_HOLD: &str = "what the records it touches hold:";

fn recalled(key: &str) -> Option<Remembered> {
    crate::memory::recalled("capabilities", key)
}

fn keep_in_memory(key: &str, remembered: &Remembered) {
    crate::memory::keep("capabilities", key, remembered);
}

const PATHS_SHOWN: usize = 5;
const STEPS_TOLD: usize = 7;

fn changes_in(flow: &Flow) -> impl Iterator<Item = &str> {
    flow.steps
        .iter()
        .rev()
        .filter(|step| matches!(step.kind, "change" | "remove" | "create"))
        .filter_map(|step| step.object.as_deref())
        .filter(|object| flow.writes.iter().any(|held| held == object))
}

fn kept_for_itself<'a>(flows: &[&'a Flow]) -> BTreeSet<&'a str> {
    let mut changed_by: BTreeMap<&str, (usize, usize)> = BTreeMap::new();
    for flow in flows {
        for record in &flow.writes {
            let held = changed_by.entry(record.as_str()).or_default();
            held.0 += 1;
            if flow.writes.len() == 1 {
                held.1 += 1;
            }
        }
    }
    changed_by
        .into_iter()
        .filter(|(_, (changing, alone))| *changing >= 3 && *alone == 0)
        .map(|(record, _)| record)
        .collect()
}

static SAID_OF_AN_EVENT: &[&str] = &["UiEvent", "UIEvent", "ViewEvent", "Event", "Intent", "Action"];

static KEEPS_A_SCREEN: &[&str] = &["Presenter", "ViewModel", "Reducer", "Feature"];

fn screen_of(flow: &Flow) -> Option<String> {
    if flow.kind != "ui" {
        return None;
    }
    let screen = match flow.operation.split_once('.') {
        Some((family, _)) => SAID_OF_AN_EVENT.iter().find_map(|suffix| family.strip_suffix(suffix)).unwrap_or(family),
        None => KEEPS_A_SCREEN.iter().find_map(|suffix| flow.operation.strip_suffix(suffix))?,
    };
    (!screen.is_empty()).then(|| screen.to_string())
}

static NAMED_COMMAND_KINDS: &[&str] = &["ipc", "cli", "tool"];

fn asked_for_by_name(flow: &Flow) -> Option<&str> {
    let named_kind = NAMED_COMMAND_KINDS.contains(&flow.kind)
        || (flow.kind == "http" && flow.method.is_none() && !flow.operation.starts_with('/'));
    (named_kind && !flow.operation.is_empty()).then(|| flow.operation.as_str())
}

fn outcome_of(flow: &Flow, bookkeeping: &BTreeSet<&str>) -> Family {
    if flow.kind == "export" {
        return crate::comprehend::family_of(flow);
    }
    if let Some(named) = asked_for_by_name(flow) {
        return Family {
            key: format!("asks:{named}"),
            basis: "the command someone explicitly asked it to run",
        };
    }
    if let Some(record) = changes_in(flow).find(|record| !bookkeeping.contains(record)) {
        return Family { key: format!("changes:{record}"), basis: "the record it changes" };
    }
    if flow.changes.iter().any(|change| change.starts_with("client_storage:")) {
        let kept = screen_of(flow).unwrap_or_else(|| flow.operation.clone());
        return Family { key: format!("keeps:{kept}"), basis: "what it keeps on the person's device" };
    }
    let handed: Option<&str> = flow
        .steps
        .iter()
        .rev()
        .filter(|step| matches!(step.kind, "raise" | "hand_off"))
        .find_map(|step| step.object.as_deref());
    if let Some(handed) = handed {
        return Family { key: format!("hands on:{handed}"), basis: "what it hands on to another part" };
    }
    if let Some(record) = changes_in(flow).next() {
        return Family { key: format!("changes:{record}"), basis: "the record it changes" };
    }
    let acted: Option<&str> =
        flow.steps.iter().rev().filter(|step| step.kind == "do").find_map(|step| step.doing.as_deref());
    if let Some(acted) = acted {
        return Family { key: format!("acts:{acted}"), basis: "the action it takes" };
    }
    let called: Option<&str> =
        flow.steps.iter().rev().filter(|step| step.kind == "call").find_map(|step| step.object.as_deref());
    if let Some(called) = called.filter(|_| flow.standing == "terminal") {
        return Family { key: format!("calls:{called}"), basis: "the service it acts through" };
    }
    if let Some(screen) = screen_of(flow) {
        return Family { key: format!("screen:{screen}"), basis: "the screen a person acts on" };
    }
    let shown: Option<&str> = flow
        .steps
        .iter()
        .rev()
        .filter(|step| step.kind == "read")
        .find_map(|step| step.object.as_deref().filter(|object| flow.reads.iter().any(|held| held == object)))
        .or_else(|| flow.reads.first().map(String::as_str));
    if let Some(shown) = shown {
        return Family { key: format!("shows:{shown}"), basis: "what it shows someone" };
    }
    crate::comprehend::family_of(flow)
}

pub(crate) fn outcomes_of<'a>(flows: &[&'a Flow]) -> BTreeMap<Family, Vec<&'a Flow>> {
    let bookkeeping = kept_for_itself(flows);
    let mut grouped: BTreeMap<Family, Vec<&'a Flow>> = BTreeMap::new();
    for flow in flows {
        grouped.entry(outcome_of(flow, &bookkeeping)).or_default().push(flow);
    }
    if grouped.keys().any(|family| !family.key.starts_with("trigger:")) {
        grouped.retain(|family, _| !family.key.starts_with("trigger:"));
    }
    for lane in grouped.values_mut() {
        lane.sort_by(|left, right| left.id.cmp(&right.id));
    }
    grouped
}

pub(crate) fn told_steps(flow: &Flow) -> String {
    let mut said: Vec<&str> = Vec::new();
    for step in &flow.steps {
        if step.kind == "respond" && step.object.is_none() {
            continue;
        }
        if said.last() != Some(&step.label.as_str()) {
            said.push(step.label.as_str());
        }
    }
    let more = said.len().saturating_sub(STEPS_TOLD);
    said.truncate(STEPS_TOLD);
    let mut told = said.join(" -> ");
    if more > 0 {
        told.push_str(&format!(" -> and {more} more"));
    }
    if told.is_empty() {
        told = "no steps read".to_string();
    }
    told
}

pub(crate) fn surface_of(flow: &Flow) -> String {
    match flow.method.as_deref() {
        Some(method) => format!("{method} {}", flow.operation),
        None => format!("{} {}", flow.kind, flow.operation),
    }
}

fn only_relays_a_signal(flows: &[&Flow]) -> bool {
    !flows.is_empty()
        && flows.iter().all(|flow| {
            flow.writes.is_empty()
                && flow.changes.is_empty()
                && flow.steps.iter().any(|step| matches!(step.kind, "raise" | "hand_off"))
                && !flow.steps.iter().any(|step| matches!(step.kind, "change" | "create" | "remove" | "call" | "do"))
        })
}

pub(crate) fn terminality_of(family: &Family, flows: &[&Flow]) -> &'static str {
    match family.key.split(':').next().unwrap_or_default() {
        "asks" if only_relays_a_signal(flows) => "proximal",
        "changes" | "hands on" | "calls" | "acts" | "keeps" | "asks" => "terminal",
        _ => "proximal",
    }
}

fn evidence_of(flows: &[&Flow], family: &Family, fields: &Fields) -> String {
    let mut surfaces: Vec<String> = flows.iter().map(|flow| surface_of(flow)).collect();
    settle(&mut surfaces);
    let more = surfaces.len().saturating_sub(SURFACES_SHOWN);
    surfaces.truncate(SURFACES_SHOWN);
    let mut kinds: Vec<String> = flows.iter().map(|flow| flow.kind.to_string()).collect();
    settle(&mut kinds);
    let mut writes: Vec<String> = flows.iter().flat_map(|flow| flow.writes.iter().cloned()).collect();
    settle(&mut writes);
    let mut reads: Vec<String> = flows.iter().flat_map(|flow| flow.reads.iter().cloned()).collect();
    settle(&mut reads);
    reads.retain(|held| !writes.contains(held));
    let mut reaches: Vec<String> = flows.iter().flat_map(|flow| flow.reaches.iter().cloned()).collect();
    settle(&mut reaches);
    let mut guarded: Vec<String> = flows
        .iter()
        .flat_map(|flow| flow.steps.iter().filter(|step| step.kind == "check").take(1))
        .filter_map(|step| step.object.clone())
        .collect();
    settle(&mut guarded);
    guarded.truncate(4);
    let mut shown: Vec<&&Flow> = flows.iter().collect();
    shown.sort_by_key(|flow| std::cmp::Reverse(flow.steps.len()));
    shown.truncate(PATHS_SHOWN);
    shown.sort_by(|left, right| left.id.cmp(&right.id));
    let listed = |held: &[String]| match held.is_empty() {
        true => "none".to_string(),
        false => held.join(", "),
    };
    let (_, object) = family.key.split_once(':').unwrap_or(("", family.key.as_str()));
    let kept: Vec<String> = writes
        .iter()
        .chain(reads.iter())
        .filter_map(|record| fields.get(record).map(|held| format!("{record} ({held})")))
        .take(RECORDS_DESCRIBED)
        .collect();
    format!(
        "  outcome ({}): {}, which is {}\n  {RECORDS_HOLD} {}\n  entered as: {}\n  reached through: {}{}\n  guarded by: {}\n  what its paths do:\n{}\n  writes: {}\n  reads: {}\n  reaches: {}\n  paths: {}",
        terminality_of(family, flows),
        object,
        family.basis,
        listed(&kept),
        kinds.join(", "),
        surfaces.join(", "),
        match more {
            0 => String::new(),
            more => format!(" and {more} more"),
        },
        listed(&guarded),
        shown
            .iter()
            .map(|flow| format!("    - {}: {}", surface_of(flow), told_steps(flow)))
            .collect::<Vec<_>>()
            .join("\n"),
        listed(&writes),
        listed(&reads),
        listed(&reaches),
        flows.len()
    )
}

fn outcome_key(name: &str) -> String {
    name.trim().to_ascii_lowercase()
}

fn gather(proposals: Vec<Proposal>, held: &mut Vec<Held>, plumbing: &mut BTreeSet<String>, known: &BTreeSet<String>) {
    for proposal in proposals {
        plumbing.extend(proposal.plumbing.into_iter().filter(|id| known.contains(id)));
        for Proposed { name, description, audience, families } in proposal.capabilities {
            let families: BTreeSet<String> = families.into_iter().filter(|id| known.contains(id)).collect();
            if families.is_empty() {
                continue;
            }
            match held.iter_mut().find(|other| outcome_key(&other.name) == outcome_key(&name)) {
                Some(other) => other.families.extend(families),
                None => held.push(Held { name, description, audience, families }),
            }
        }
    }
}

fn lumped(name: &str) -> bool {
    let lowered = format!(" {} ", name.to_ascii_lowercase());
    [" and ", " & ", ", "].iter().any(|joins| lowered.contains(joins))
}

fn split_what_was_lumped(said: &str, told: &BTreeMap<String, String>, held: &mut Vec<Held>) {
    let lumps: Vec<usize> = held
        .iter()
        .enumerate()
        .filter(|(_, other)| lumped(&other.name) && other.families.len() > 1)
        .map(|(at, _)| at)
        .collect();
    let splits: Vec<(usize, Proposal)> = lumps
        .par_iter()
        .map(|at| {
            let families: Vec<(String, String)> = held[*at]
                .families
                .iter()
                .filter_map(|id| told.get(id).map(|evidence| (id.clone(), evidence.clone())))
                .collect();
            (*at, crate::author::propose_capabilities(said, &families))
        })
        .collect();
    let mut replaced: BTreeSet<usize> = BTreeSet::new();
    let mut added: Vec<Held> = Vec::new();
    for (at, proposal) in splits {
        let within = &held[at].families;
        let parts: Vec<Held> = proposal
            .capabilities
            .into_iter()
            .map(|Proposed { name, description, audience, families }| Held {
                name,
                description,
                audience,
                families: families.into_iter().filter(|id| within.contains(id)).collect(),
            })
            .filter(|part| !part.families.is_empty())
            .collect();
        let covered: BTreeSet<&String> = parts.iter().flat_map(|part| part.families.iter()).collect();
        if parts.len() < 2 || covered.len() < within.len() {
            continue;
        }
        replaced.insert(at);
        added.extend(parts);
    }
    let mut at = 0;
    held.retain(|_| {
        let keep = !replaced.contains(&at);
        at += 1;
        keep
    });
    held.extend(added);
}

fn place(
    said: &str,
    told: &BTreeMap<String, String>,
    held: &mut Vec<Held>,
    plumbing: &mut BTreeSet<String>,
) {
    let placed: BTreeSet<String> = held.iter().flat_map(|other| other.families.iter().cloned()).collect();
    let unplaced: Vec<(String, String)> = told
        .iter()
        .filter(|(id, _)| !placed.contains(*id) && !plumbing.contains(*id))
        .map(|(id, evidence)| (id.clone(), evidence.clone()))
        .collect();
    if unplaced.is_empty() {
        return;
    }
    let standing: Vec<(String, String)> =
        held.iter().map(|other| (other.name.clone(), other.description.clone())).collect();
    for Placed { family, capability, description, audience } in crate::author::place_families(said, &standing, &unplaced) {
        if !told.contains_key(&family) || placed.contains(&family) {
            continue;
        }
        if capability.trim().eq_ignore_ascii_case("plumbing") {
            plumbing.insert(family);
            continue;
        }
        match held.iter_mut().find(|other| outcome_key(&other.name) == outcome_key(&capability)) {
            Some(other) => {
                other.families.insert(family);
            }
            None => held.push(Held {
                name: capability,
                description,
                audience,
                families: BTreeSet::from([family]),
            }),
        }
    }
}

const HELD_TOGETHER: f64 = 0.5;

fn hold_together(said: &str, told: &BTreeMap<String, String>, held: &mut [Held]) {
    let mut questions: BTreeMap<String, crate::jev::Question> = BTreeMap::new();
    let mut asked_of: BTreeMap<String, (usize, String)> = BTreeMap::new();
    for (at, other) in held.iter().enumerate() {
        if other.families.len() < 2 {
            continue;
        }
        for family in &other.families {
            let Some(evidence) = told.get(family) else { continue };
            let key = format!("h{at}-{family}");
            questions.insert(
                key.clone(),
                crate::jev::Question {
                    kind: "noul",
                    instructions: format!(
                        "CAPABILITY: {}, for {}: {}\n\nOUTCOME read from the code:\n{evidence}\n\nSomeone who comes for the capability above comes for this outcome as part of the same thing, rather than for a different reason or as a different person",
                        other.name, other.audience, other.description
                    ),
                    criteria: BTreeMap::new().into(),
                },
            );
            asked_of.insert(key, (at, family.clone()));
        }
    }
    if questions.is_empty() {
        return;
    }
    let answers = crate::jev::decide(&format!("A software system describes itself like this:\n{said}"), questions);
    for (key, (at, family)) in asked_of {
        let apart = answers.get(&key).map(crate::jev::Decision::settled).is_some_and(|held| held < HELD_TOGETHER);
        if apart && held[at].families.len() > 1 {
            held[at].families.remove(&family);
        }
    }
}

fn object_of(family: &str) -> &str {
    let (prefix, object) = family.split_once(':').unwrap_or(("", family));
    match prefix {
        "asks" => object.split_once(':').map(|(namespace, _)| namespace).unwrap_or(object),
        _ => object,
    }
}

fn terminal_first(family: &str) -> bool {
    matches!(family.split(':').next().unwrap_or_default(), "changes" | "hands on" | "calls" | "acts" | "asks")
}

fn join_the_same(said: &str, held: &mut Vec<Held>) {
    let mut questions: BTreeMap<String, crate::jev::Question> = BTreeMap::new();
    let mut pairs: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    for first in 0..held.len() {
        for second in first + 1..held.len() {
            let shared = held[first]
                .families
                .iter()
                .any(|family| held[second].families.iter().any(|other| object_of(other) == object_of(family)));
            if !shared {
                continue;
            }
            let key = format!("j{first}-{second}");
            let told = |other: &Held| format!("{}, for {}: {}", other.name, other.audience, other.description);
            questions.insert(
                key.clone(),
                crate::jev::Question {
                    kind: "noul",
                    instructions: format!(
                        "FIRST: {}\nSECOND: {}\n\nThese are one outcome for the same person: someone who comes for one of them would say they came for the other, rather than for a different reason",
                        told(&held[first]),
                        told(&held[second])
                    ),
                    criteria: BTreeMap::new().into(),
                },
            );
            pairs.insert(key, (first, second));
        }
    }
    if questions.is_empty() {
        return;
    }
    let answers = crate::jev::decide(&format!("A software system describes itself like this:\n{said}"), questions);
    let mut into: Vec<usize> = (0..held.len()).collect();
    let root = |into: &Vec<usize>, mut at: usize| {
        while into[at] != at {
            at = into[at];
        }
        at
    };
    for (key, (first, second)) in pairs {
        if answers.get(&key).map(crate::jev::Decision::settled).is_some_and(|held| held >= HELD_TOGETHER) {
            let (left, right) = (root(&into, first), root(&into, second));
            if left != right {
                let keeper = match held[right].families.iter().any(|family| terminal_first(family))
                    && !held[left].families.iter().any(|family| terminal_first(family))
                {
                    true => right,
                    false => left,
                };
                let other = if keeper == left { right } else { left };
                into[other] = keeper;
            }
        }
    }
    let mut kept: Vec<Held> = Vec::new();
    let mut slot_of: BTreeMap<usize, usize> = BTreeMap::new();
    let taken: Vec<Held> = std::mem::take(held);
    let roots: Vec<usize> = (0..taken.len()).map(|at| root(&into, at)).collect();
    let mut pending: Vec<(usize, Held)> = Vec::new();
    for (at, other) in taken.into_iter().enumerate() {
        match roots[at] == at {
            true => {
                slot_of.insert(at, kept.len());
                kept.push(other);
            }
            false => pending.push((roots[at], other)),
        }
    }
    for (keeper, other) in pending {
        if let Some(slot) = slot_of.get(&keeper) {
            kept[*slot].families.extend(other.families);
        }
    }
    *held = kept;
}

fn stemmed(word: &str) -> String {
    let lowered = word.to_ascii_lowercase().replace(['-', '_'], "");
    lowered.strip_suffix('s').filter(|stem| stem.len() > 2).map(str::to_string).unwrap_or(lowered)
}

fn record_key(family: &str) -> String {
    match family.starts_with("asks:") {
        true => stemmed(object_of(family)),
        false => {
            let object = object_of(family).to_ascii_lowercase();
            object.strip_suffix('s').filter(|stem| stem.len() > 2).map(str::to_string).unwrap_or(object)
        }
    }
}

static NOT_AN_OBJECT_NOUN: &[&str] = &[
    "a", "an", "and", "as", "at", "by", "for", "from", "in", "into", "is", "it", "its", "of", "on", "or", "someone",
    "the", "their", "them", "they", "this", "to", "user", "users", "with",
    "add", "authenticate", "cache", "check", "close", "compute", "configure", "create", "delete", "disable", "emit",
    "enable", "execute", "fetch", "find", "forward", "get", "handle", "hide", "list", "load", "manage", "monitor",
    "open", "organize", "parse", "read", "receive", "remove", "replace", "retrieve", "run", "save", "search", "send",
    "set", "show", "sign", "start", "stop", "sync", "toggle", "track", "update", "view", "write",
];

fn object_nouns(name: &str) -> Vec<String> {
    name.split_whitespace()
        .map(|word| word.trim_matches(|letter: char| !letter.is_ascii_alphanumeric()).to_string())
        .filter(|word| word.len() > 2)
        .map(|word| stemmed(&word))
        .filter(|word| word.len() > 2 && !NOT_AN_OBJECT_NOUN.contains(&word.as_str()))
        .collect()
}

fn could_repeat(held: &[Held], key_of: &BTreeMap<&str, &str>) -> Vec<Vec<usize>> {
    let mut leader: Vec<usize> = (0..held.len()).collect();
    fn found(leader: &mut [usize], at: usize) -> usize {
        let mut current = at;
        while leader[current] != current {
            leader[current] = leader[leader[current]];
            current = leader[current];
        }
        current
    }
    let union = |leader: &mut Vec<usize>, first: usize, second: usize| {
        let (left, right) = (found(leader, first), found(leader, second));
        if left != right {
            leader[right] = left;
        }
    };
    let mut first_with: BTreeMap<String, usize> = BTreeMap::new();
    for (at, other) in held.iter().enumerate() {
        let all_asks = !other.families.is_empty()
            && other.families.iter().all(|family| {
                key_of.get(family.as_str()).copied().unwrap_or(family.as_str()).starts_with("asks:")
            });
        let mut keys: BTreeSet<String> = other
            .families
            .iter()
            .map(|family| record_key(key_of.get(family.as_str()).copied().unwrap_or(family.as_str())))
            .collect();
        if all_asks {
            keys.extend(object_nouns(&other.name));
        }
        for key in keys {
            match first_with.get(&key).copied() {
                Some(earlier) => union(&mut leader, earlier, at),
                None => {
                    first_with.insert(key, at);
                }
            }
        }
    }
    let mut clusters: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for at in 0..held.len() {
        let root = found(&mut leader, at);
        clusters.entry(root).or_default().push(at);
    }
    clusters
        .into_values()
        .filter(|cluster| cluster.len() > 1)
        .flat_map(|cluster| cluster.chunks(FAMILIES_PER_PROPOSAL).map(<[usize]>::to_vec).collect::<Vec<_>>())
        .collect()
}

fn asks_only_families(families: &BTreeSet<String>, key_of: &BTreeMap<&str, &str>) -> bool {
    !families.is_empty()
        && families.iter().all(|id| key_of.get(id.as_str()).copied().unwrap_or(id.as_str()).starts_with("asks:"))
}

fn normalized_name(name: &str) -> String {
    name.trim().to_ascii_lowercase().split_whitespace().collect::<Vec<_>>().join(" ")
}

fn merge_exact_asks_duplicates(held: &mut Vec<Held>, key_of: &BTreeMap<&str, &str>) {
    let mut at = 0;
    while at < held.len() {
        if !asks_only_families(&held[at].families, key_of) {
            at += 1;
            continue;
        }
        let name = normalized_name(&held[at].name);
        let mut other = at + 1;
        while other < held.len() {
            if asks_only_families(&held[other].families, key_of) && normalized_name(&held[other].name) == name {
                let merged = held.remove(other);
                held[at].families.extend(merged.families);
            } else {
                other += 1;
            }
        }
        at += 1;
    }
}

fn consolidate_within(said: &str, held: Vec<Held>, key_of: &BTreeMap<&str, &str>) -> Vec<Held> {
    if held.len() < 2 {
        return held;
    }
    let clusters = could_repeat(&held, key_of);
    let answers: Vec<(Vec<usize>, Vec<crate::author::Same>)> = clusters
        .par_iter()
        .map(|cluster| {
            let listed: BTreeMap<String, String> = cluster
                .iter()
                .map(|at| {
                    let other = &held[*at];
                    (
                        format!("c{at}"),
                        format!(
                            "  it is called: {}\n  for: {}\n  what someone gets: {}",
                            other.name, other.audience, other.description
                        ),
                    )
                })
                .collect();
            (cluster.clone(), crate::author::same_outcome(said, &listed))
        })
        .collect();
    let mut taken: Vec<bool> = vec![false; held.len()];
    let mut slots: Vec<Option<Held>> = held.into_iter().map(Some).collect();
    let mut joined: Vec<Held> = Vec::new();
    for (cluster, groups) in answers {
        for group in groups {
            let members: Vec<usize> = group
                .of
                .iter()
                .filter_map(|id| id.trim().strip_prefix('c')?.parse::<usize>().ok())
                .filter(|at| cluster.contains(at) && !taken[*at])
                .collect();
            if members.len() < 2 {
                continue;
            }
            let mut families = BTreeSet::new();
            for at in &members {
                taken[*at] = true;
                if let Some(other) = slots[*at].take() {
                    families.extend(other.families);
                }
            }
            joined.push(Held {
                name: group.name.trim().to_string(),
                description: group.description.trim().to_string(),
                audience: group.audience.trim().to_string(),
                families,
            });
        }
    }
    joined.extend(slots.into_iter().flatten());
    joined
}

pub(crate) fn of_a_part(flows: &[&Flow], said: &str, remembered_as: &str, fields: &Fields) -> Vec<Capability> {
    if flows.is_empty() {
        return Vec::new();
    }
    let served = flows.iter().any(|flow| SERVED_KINDS.contains(&flow.kind));
    let kept: Vec<&Flow> = flows
        .iter()
        .copied()
        .filter(|flow| !served || flow.kind != "export")
        .filter(|flow| !only_moves_the_screen(flow))
        .collect();
    if std::env::var("KLAURO_FAMILY_DUMP").is_ok() {
        for family in outcomes_of(&kept).keys() {
            eprintln!("family[{remembered_as}]: {}", family.key);
        }
    }
    if !crate::author::asked() {
        return Vec::new();
    }
    let families = outcomes_of(&kept);
    if families.keys().all(|family| family.key.starts_with("trigger:")) {
        return Vec::new();
    }
    let keyed: Vec<(String, &Family, &Vec<&Flow>)> = families
        .iter()
        .enumerate()
        .map(|(at, (family, lane))| (format!("f{at}"), family, lane))
        .collect();
    let told: BTreeMap<String, String> =
        keyed.iter().map(|(id, family, lane)| (id.clone(), evidence_of(lane, family, fields))).collect();
    let known: BTreeSet<String> = told.keys().cloned().collect();
    let key_of: BTreeMap<&str, &str> =
        keyed.iter().map(|(id, family, _)| (id.as_str(), family.key.as_str())).collect();
    let id_of: BTreeMap<&str, &str> = key_of.iter().map(|(id, key)| (*key, *id)).collect();
    let evidence_of_key: BTreeMap<String, String> = told
        .iter()
        .map(|(id, evidence)| (key_of[id.as_str()].to_string(), crate::jev::named(&format!("{said}\u{1}{evidence}"))))
        .collect();
    let digest = crate::jev::named(&format!("{said}\u{1}{:?}", evidence_of_key));
    if std::env::var("KLAURO_AUTHOR_DEBUG").is_ok() {
        eprintln!("said of {}: {said}", remembered_as.replace('\u{1}', "/"));
        for (id, evidence) in &told {
            eprintln!("evidence {} {}\n{evidence}", remembered_as.replace('\u{1}', "/"), key_of[id.as_str()]);
        }
    }
    let memory = recalled(remembered_as).filter(|memory| !memory.capabilities.is_empty()).filter(|memory| {
        let carried = evidence_of_key.iter().filter(|(key, evidence)| memory.families.get(*key) == Some(*evidence)).count();
        carried * 2 >= evidence_of_key.len()
    });
    let (mut held, mut plumbing) = match memory {
        Some(memory) if memory.digest == digest => recollected(&memory, &id_of, |_| true),
        Some(memory) => {
            let (mut held, mut plumbing) = recollected(&memory, &id_of, |key| {
                memory.families.get(key).is_some_and(|was| evidence_of_key.get(key) == Some(was))
            });
            place(said, &told, &mut held, &mut plumbing);
            (held, plumbing)
        }
        None => {
            let listed: Vec<(String, String)> =
                told.iter().map(|(id, evidence)| (id.clone(), evidence.clone())).collect();
            let proposing = std::time::Instant::now();
            let proposals: Vec<Proposal> = match listed.len() <= FAMILIES_PER_PROPOSAL {
                true => vec![most_detailed_reading(said, &listed)],
                false => listed
                    .par_chunks(FAMILIES_PER_PROPOSAL)
                    .map(|chunk| most_detailed_reading(said, chunk))
                    .collect(),
            };
            let chunked = proposals.len() > 1;
            let mut held: Vec<Held> = Vec::new();
            let mut plumbing: BTreeSet<String> = BTreeSet::new();
            if std::env::var("KLAURO_AUTHOR_DEBUG").is_ok() {
                eprintln!("  proposing {} outcomes took {:?}", listed.len(), proposing.elapsed());
            }
            let proposed: usize = proposals.iter().map(|proposal| proposal.capabilities.len()).sum();
            gather(proposals, &mut held, &mut plumbing, &known);
            if std::env::var("KLAURO_AUTHOR_DEBUG").is_ok() {
                eprintln!("  proposed {proposed} capabilities, {} held after gathering, {} plumbing", held.len(), plumbing.len());
            }
            let clock = std::time::Instant::now();
            let counted = |step: &str, held: &Vec<Held>| {
                if std::env::var("KLAURO_AUTHOR_DEBUG").is_ok() {
                    eprintln!("  after {step}: {} capabilities at {:?}", held.len(), clock.elapsed());
                }
            };
            if chunked {
                held = consolidate_within(said, held, &key_of);
                counted("consolidating", &held);
            }
            hold_together(said, &told, &mut held);
            counted("holding together", &held);
            place(said, &told, &mut held, &mut plumbing);
            counted("placing", &held);
            join_the_same(said, &mut held);
            counted("joining the same", &held);
            split_what_was_lumped(said, &told, &mut held);
            counted("splitting", &held);
            (held, plumbing)
        }
    };
    held.retain(|other| !other.families.is_empty());
    merge_exact_asks_duplicates(&mut held, &key_of);
    plumbing.retain(|id| known.contains(id));
    if std::env::var("KLAURO_AUTHOR_DEBUG").is_ok() {
        eprintln!("  settled {} capabilities and {} plumbing of {} outcomes", held.len(), plumbing.len(), told.len());
    }
    let settled_every_family = told.keys().all(|id| {
        plumbing.contains(id) || held.iter().any(|other| other.families.contains(id))
    });
    if crate::author::asked() && settled_every_family && !held.is_empty() {
        keep_in_memory(
            remembered_as,
            &Remembered {
                digest,
                capabilities: held
                    .iter()
                    .map(|other| RememberedCapability {
                        name: other.name.clone(),
                        description: other.description.clone(),
                        audience: other.audience.clone(),
                        families: other.families.iter().map(|id| key_of[id.as_str()].to_string()).collect(),
                    })
                    .collect(),
                plumbing: plumbing.iter().map(|id| key_of[id.as_str()].to_string()).collect(),
                families: evidence_of_key.clone(),
            },
        );
    }
    let lanes: BTreeMap<&str, (&Family, &Vec<&Flow>)> =
        keyed.iter().map(|(id, family, lane)| (id.as_str(), (*family, *lane))).collect();
    let assigned = split_shared(said, &held, &lanes);
    let mut formed: Vec<Capability> = held
        .into_iter()
        .filter_map(|other| {
            let name = other.name.clone();
            built(other, &lanes, fields, |family, flow| {
                assigned.get(family).and_then(|by_flow| by_flow.get(flow)).is_none_or(|owners| owners.contains(&name))
            })
        })
        .collect();
    formed.sort_by(|left, right| left.id.cmp(&right.id));
    formed
}

fn recollected(
    memory: &Remembered,
    id_of: &BTreeMap<&str, &str>,
    still_holds: impl Fn(&str) -> bool,
) -> (Vec<Held>, BTreeSet<String>) {
    let held = memory
        .capabilities
        .iter()
        .map(|was| Held {
            name: was.name.clone(),
            description: was.description.clone(),
            audience: was.audience.clone(),
            families: was
                .families
                .iter()
                .filter(|key| still_holds(key))
                .filter_map(|key| id_of.get(key.as_str()).map(|id| id.to_string()))
                .collect(),
        })
        .collect();
    let plumbing = memory
        .plumbing
        .iter()
        .filter(|key| still_holds(key))
        .filter_map(|key| id_of.get(key.as_str()).map(|id| id.to_string()))
        .collect();
    (held, plumbing)
}

static SCREEN_EVENTS: &[&str] = &[
    "blur", "change", "click", "contextmenu", "dblclick", "domcontentloaded", "focus", "input", "keydown", "keypress",
    "keyup", "load", "mousedown", "mouseenter", "mouseleave", "mousemove", "mouseout", "mouseover", "mouseup",
    "pointerdown", "pointerenter", "pointerleave", "pointermove", "pointerout", "pointerover", "pointerup", "resize",
    "scroll", "touchend", "touchmove", "touchstart", "visibilitychange", "wheel",
];

fn only_moves_the_screen(flow: &Flow) -> bool {
    flow.kind == "event"
        && SCREEN_EVENTS.contains(&flow.operation.to_ascii_lowercase().as_str())
        && flow.writes.is_empty()
        && !flow.steps.iter().any(|step| matches!(step.kind, "call" | "hand_off" | "raise" | "change" | "create" | "remove"))
}

fn split_shared(said: &str, held: &[Held], lanes: &BTreeMap<&str, (&Family, &Vec<&Flow>)>) -> BTreeMap<String, BTreeMap<String, Vec<String>>> {
    let mut claimed: BTreeMap<&str, Vec<&Held>> = BTreeMap::new();
    for other in held {
        for family in &other.families {
            claimed.entry(family.as_str()).or_default().push(other);
        }
    }
    let mut assigned: BTreeMap<String, BTreeMap<String, Vec<String>>> = BTreeMap::new();
    for (family, claimants) in claimed.into_iter().filter(|(_, claimants)| claimants.len() > 1) {
        let Some((_, lane)) = lanes.get(family) else { continue };
        let choices: Vec<(String, String)> =
            claimants.iter().map(|other| (other.name.trim().to_string(), other.description.trim().to_string())).collect();
        let paths: Vec<(String, String)> = lane
            .iter()
            .map(|flow| (flow.id.clone(), format!("  reached through: {}\n  steps: {}", surface_of(flow), told_steps(flow))))
            .collect();
        let context = format!(
            "{said}\u{1}{}",
            choices.iter().map(|(name, description)| format!("{name}: {description}")).collect::<Vec<_>>().join("\n")
        );
        let by_flow: BTreeMap<String, Vec<String>> =
            crate::memory::each("delivered by", &context, &paths, |missing| crate::author::assign_paths(said, &choices, missing));
        assigned.insert(family.to_string(), by_flow);
    }
    assigned
}

fn built(
    held: Held,
    lanes: &BTreeMap<&str, (&Family, &Vec<&Flow>)>,
    fields: &Fields,
    delivers: impl Fn(&str, &str) -> bool,
) -> Option<Capability> {
    let name = held.name.trim().to_string();
    if name.is_empty() {
        return None;
    }
    let mut capability = Capability {
        id: format!("capability:{}", carved_name(&name)),
        audience: Some(held.audience.trim().to_ascii_lowercase()).filter(|audience| !audience.is_empty()),
        delivered: Vec::new(),
        records: Vec::new(),
        changes: Vec::new(),
        flows: Vec::new(),
        surfaces: Vec::new(),
        project: None,
        also_in: Vec::new(),
        place: None,
        name: Some(name),
        description: Some(held.description.trim().to_string()).filter(|description| !description.is_empty()),
        grounding: None,
        standing: PUBLISHED,
        touches: Vec::new(),
        terminality: None,
        confidence: None,
        evidence: String::new(),
    };
    let mut told: Vec<String> = Vec::new();
    for family_id in &held.families {
        let Some((family, lane)) = lanes.get(family_id.as_str()) else { continue };
        told.push(evidence_of(lane, family, fields));
        let terminality = terminality_of(family, lane);
        if terminality == "terminal" || capability.terminality.is_none() {
            capability.terminality = Some(terminality);
        }
        for flow in lane.iter().filter(|flow| delivers(family_id, &flow.id)) {
            capability.project = capability.project.take().or_else(|| flow.project.clone());
            capability.delivered.push(Delivery {
                flow: flow.id.clone(),
                role: match flow.standing {
                    "terminal" | "proximal" => "primary",
                    _ => "supporting",
                },
                rationale: format!("{} belongs here by {}", flow.operation, family.basis),
            });
            capability.surfaces.push(match flow.method.as_deref() {
                Some(method) => format!("{method} {}", flow.operation),
                None => flow.operation.clone(),
            });
            capability.records.extend(flow.writes.iter().cloned());
            capability.touches.extend(flow.writes.iter().cloned());
            capability.touches.extend(flow.reads.iter().cloned());
            capability.changes.extend(flow.changes.iter().cloned());
        }
    }
    if capability.delivered.is_empty() {
        return None;
    }
    if capability.delivered.iter().all(|held| held.role != "primary") {
        for held in capability.delivered.iter_mut() {
            held.role = "primary";
        }
    }
    capability.evidence = told.join("\n");
    capability.delivered.sort_by(|left, right| left.flow.cmp(&right.flow));
    capability.delivered.dedup_by(|left, right| left.flow == right.flow);
    capability.flows = capability.delivered.iter().map(|held| held.flow.clone()).collect();
    settle(&mut capability.surfaces);
    settle(&mut capability.records);
    settle(&mut capability.touches);
    settle(&mut capability.changes);
    Some(capability)
}

#[derive(Serialize, Deserialize)]
struct Whole {
    groups: Vec<WholeGroup>,
    seen: BTreeSet<String>,
}

#[derive(Serialize, Deserialize)]
struct WholeGroup {
    name: String,
    description: String,
    audience: String,
    members: BTreeSet<String>,
}

fn standing_of(capability: &Capability) -> String {
    crate::jev::named(&format!(
        "{:?}\u{1}{}\u{1}{}\u{1}{}",
        capability.project,
        capability.name.as_deref().unwrap_or(""),
        capability.audience.as_deref().unwrap_or(""),
        capability.description.as_deref().unwrap_or("")
    ))
}

fn continued_together(
    groups: &mut Vec<crate::author::Same>,
    continues: &[BTreeSet<usize>],
    told: &BTreeMap<String, String>,
    spoken: &str,
) {
    let mut questions: BTreeMap<String, crate::jev::Question> = BTreeMap::new();
    let mut pairs: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    for (first, onward) in continues.iter().enumerate() {
        for second in onward {
            let (Some(using), Some(reached)) = (told.get(&format!("c{first}")), told.get(&format!("c{second}"))) else {
                continue;
            };
            let key = format!("p{first}-{second}");
            questions.insert(
                key.clone(),
                crate::jev::Question {
                    kind: "noul",
                    instructions: format!(
                        "FIRST:\n{using}\n\nSECOND:\n{reached}\n\nSomeone using the first is getting the second done through it: they are one outcome for the same person, reached two ways, rather than two things someone would come for separately"
                    ),
                    criteria: BTreeMap::new().into(),
                },
            );
            pairs.insert(key, (first, *second));
        }
    }
    if questions.is_empty() {
        return;
    }
    let answers = crate::jev::decide(&format!("A software system describes itself like this:\n{spoken}"), questions);
    let at_of = |groups: &Vec<crate::author::Same>, member: usize| {
        let id = format!("c{member}");
        groups.iter().position(|group| group.of.iter().any(|held| held.trim() == id))
    };
    let together: Vec<(usize, usize)> = pairs
        .into_iter()
        .filter(|(key, _)| answers.get(key).map(crate::jev::Decision::settled).is_some_and(|held| held >= 0.5))
        .map(|(_, pair)| pair)
        .collect();
    let mut reaching: BTreeMap<usize, BTreeSet<String>> = BTreeMap::new();
    for (first, second) in &together {
        let landing = at_of(groups, *second).map(|at| format!("g{at}")).unwrap_or_else(|| format!("c{second}"));
        reaching.entry(*first).or_default().insert(landing);
    }
    for (first, second) in together {
        if reaching.get(&first).is_some_and(|landings| landings.len() > 1) {
            continue;
        }
        match (at_of(groups, first), at_of(groups, second)) {
            (Some(left), Some(right)) if left != right => {
                let moved = groups[right].of.clone();
                groups[left].of.extend(moved);
                groups.remove(right);
            }
            (Some(_), Some(_)) => {}
            (Some(left), None) => groups[left].of.push(format!("c{second}")),
            (None, Some(right)) => groups[right].of.push(format!("c{first}")),
            (None, None) => groups.push(crate::author::Same {
                of: vec![format!("c{first}"), format!("c{second}")],
                name: String::new(),
                description: String::new(),
                audience: String::new(),
            }),
        }
    }
}

fn asked_afresh(listed: BTreeMap<String, String>, spoken: &str) -> Vec<crate::author::Same> {
    let chunks: Vec<BTreeMap<String, String>> = listed
        .into_iter()
        .collect::<Vec<_>>()
        .chunks(CAPABILITIES_CONSOLIDATED_AT_ONCE)
        .map(|chunk| chunk.iter().cloned().collect())
        .collect();
    chunks.par_iter().flat_map(|chunk| crate::author::same_outcome(spoken, chunk)).collect()
}

fn grouped(
    parts: &[Capability],
    listed: BTreeMap<String, String>,
    spoken: &str,
    scope: &str,
) -> Vec<crate::author::Same> {
    let standing: Vec<String> = parts.iter().map(standing_of).collect();
    let at_of: BTreeMap<&str, usize> = standing.iter().enumerate().map(|(at, key)| (key.as_str(), at)).collect();
    let at_in = |id: &str| id.trim().strip_prefix('c')?.parse::<usize>().ok().filter(|at| *at < parts.len());
    let groups = match crate::memory::recalled::<Whole>("whole", scope) {
        None => asked_afresh(listed, spoken),
        Some(memory) => {
            let mut groups: Vec<crate::author::Same> = memory
                .groups
                .iter()
                .map(|group| crate::author::Same {
                    of: group
                        .members
                        .iter()
                        .filter_map(|key| at_of.get(key.as_str()))
                        .map(|at| format!("c{at}"))
                        .collect(),
                    name: group.name.clone(),
                    description: group.description.clone(),
                    audience: group.audience.clone(),
                })
                .filter(|group| !group.of.is_empty())
                .collect();
            let newcomers: BTreeSet<usize> =
                (0..parts.len()).filter(|at| !memory.seen.contains(&standing[*at])).collect();
            if !newcomers.is_empty() {
                let in_a_group: BTreeSet<usize> =
                    groups.iter().flat_map(|group| group.of.iter().filter_map(|id| at_in(id))).collect();
                let mut offered: BTreeMap<String, String> = groups
                    .iter()
                    .enumerate()
                    .map(|(at, group)| {
                        (
                            format!("g{at}"),
                            format!(
                                "  it is called: {}\n  for: {}\n  what someone gets: {}",
                                group.name, group.audience, group.description
                            ),
                        )
                    })
                    .collect();
                offered.extend(
                    listed.iter().filter(|(id, _)| at_in(id).is_some_and(|at| !in_a_group.contains(&at))).map(
                        |(id, told)| (id.clone(), told.clone()),
                    ),
                );
                for same in crate::author::same_outcome(spoken, &offered) {
                    let joining: Vec<String> = same
                        .of
                        .iter()
                        .filter(|id| at_in(id).is_some_and(|at| newcomers.contains(&at)))
                        .map(|id| id.trim().to_string())
                        .collect();
                    if joining.is_empty() {
                        continue;
                    }
                    let into = same
                        .of
                        .iter()
                        .find_map(|id| id.trim().strip_prefix('g')?.parse::<usize>().ok())
                        .filter(|at| *at < groups.len());
                    match into {
                        Some(at) => groups[at].of.extend(joining),
                        None => groups.push(crate::author::Same {
                            of: same
                                .of
                                .iter()
                                .filter(|id| at_in(id).is_some_and(|at| !in_a_group.contains(&at)))
                                .map(|id| id.trim().to_string())
                                .collect(),
                            ..same
                        }),
                    }
                }
            }
            groups
        }
    };
    if crate::author::asked() && !groups.is_empty() {
        crate::memory::keep(
            "whole",
            scope,
            &Whole {
                groups: groups
                    .iter()
                    .map(|group| WholeGroup {
                        name: group.name.clone(),
                        description: group.description.clone(),
                        audience: group.audience.clone(),
                        members: group
                            .of
                            .iter()
                            .filter_map(|id| at_in(id))
                            .map(|at| standing[at].clone())
                            .collect(),
                    })
                    .collect(),
                seen: standing.iter().cloned().collect(),
            },
        );
    }
    groups
}

pub(crate) fn of_the_whole(parts: &[Capability], spoken: &str, scope: &str, flows: &[Flow]) -> Vec<Capability> {
    let projects: BTreeSet<Option<&str>> = parts.iter().map(|capability| capability.project.as_deref()).collect();
    if parts.len() < 2 || projects.len() < 2 {
        return Vec::new();
    }
    let mut holding: BTreeMap<&str, Vec<usize>> = BTreeMap::new();
    for (at, capability) in parts.iter().enumerate() {
        for flow in &capability.flows {
            holding.entry(flow.as_str()).or_default().push(at);
        }
    }
    let flow_of: BTreeMap<&str, &Flow> = flows.iter().map(|flow| (flow.id.as_str(), flow)).collect();
    let continues: Vec<BTreeSet<usize>> = parts
        .iter()
        .enumerate()
        .map(|(at, capability)| {
            capability
                .flows
                .iter()
                .filter_map(|flow| flow_of.get(flow.as_str()))
                .flat_map(|flow| flow.leads_into.iter())
                .flat_map(|entry| holding.get(format!("flow:{entry}").as_str()).cloned().unwrap_or_default())
                .filter(|other| *other != at && parts[*other].project != capability.project)
                .collect()
        })
        .collect();
    let listed: BTreeMap<String, String> = parts
        .iter()
        .enumerate()
        .map(|(at, capability)| {
            let mut surfaces = capability.surfaces.clone();
            surfaces.truncate(SURFACES_SHOWN);
            (
                format!("c{at}"),
                format!(
                    "  it is called: {}\n  for: {}\n  what someone gets: {}\n  found in the part: {}\n  reached through: {}{}",
                    capability.name.as_deref().unwrap_or(""),
                    capability.audience.as_deref().unwrap_or("someone"),
                    capability.description.as_deref().unwrap_or(""),
                    capability.project.as_deref().unwrap_or("the repository root"),
                    surfaces.join(", "),
                    match continues[at].is_empty() {
                        true => String::new(),
                        false => format!(
                            "\n  its paths continue into: {}",
                            continues[at].iter().map(|other| format!("c{other}")).collect::<Vec<_>>().join(", ")
                        ),
                    }
                ),
            )
        })
        .collect();
    let told_of = listed.clone();
    let mut groups = grouped(parts, listed, spoken, scope);
    continued_together(&mut groups, &continues, &told_of, spoken);
    let mut taken = vec![false; parts.len()];
    let mut whole: Vec<Capability> = Vec::new();
    for group in groups {
        let mut from_parts: BTreeSet<Option<&str>> = BTreeSet::new();
        let members: Vec<usize> = group
            .of
            .iter()
            .filter_map(|id| id.trim().strip_prefix('c')?.parse::<usize>().ok())
            .filter(|at| *at < parts.len() && !taken[*at])
            .filter(|at| from_parts.insert(parts[*at].project.as_deref()))
            .collect();
        let Some(first) = members.first().copied() else { continue };
        let mut together = parts[first].clone();
        for at in &members {
            taken[*at] = true;
        }
        for at in members.iter().skip(1) {
            crate::comprehend::joined(&mut together, parts[*at].clone());
        }
        if !group.name.trim().is_empty() {
            together.id = format!("capability:{}", carved_name(&group.name));
            together.name = Some(group.name.trim().to_string());
        }
        if !group.description.trim().is_empty() {
            together.description = Some(group.description.trim().to_string());
        }
        if !group.audience.trim().is_empty() {
            together.audience = Some(group.audience.trim().to_ascii_lowercase());
        }
        whole.push(together);
    }
    for (at, capability) in parts.iter().enumerate() {
        if !taken[at] {
            whole.push(capability.clone());
        }
    }
    for capability in whole.iter_mut() {
        if let Some(part) = capability.project.take()
            && !capability.also_in.contains(&part)
        {
            capability.also_in.push(part);
        }
        capability.also_in.sort();
        capability.also_in.dedup();
    }
    let mut merged: Vec<Capability> = Vec::new();
    for capability in whole {
        match merged.iter_mut().find(|held| held.id == capability.id) {
            Some(held) => crate::comprehend::joined(held, capability),
            None => merged.push(capability),
        }
    }
    merged.sort_by(|left, right| left.id.cmp(&right.id));
    merged
}

#[cfg(test)]
mod command_family_tests {
    use super::*;

    fn flow(id: &str, kind: &'static str, method: Option<&str>, operation: &str, writes: &[&str], reads: &[&str]) -> Flow {
        Flow {
            summary: String::new(),
            writes: writes.iter().map(|held| held.to_string()).collect(),
            reads: reads.iter().map(|held| held.to_string()).collect(),
            reaches: Vec::new(),
            id: id.to_string(),
            entry_point: format!("entry:{id}"),
            kind,
            method: method.map(str::to_string),
            operation: operation.to_string(),
            surface: None,
            plays: None,
            standing: "terminal",
            name: None,
            description: None,
            grounding: None,
            path: Vec::new(),
            steps: Vec::new(),
            step_edges: Vec::new(),
            units: 1,
            changes: Vec::new(),
            leads_into: Vec::new(),
            project: None,
        }
    }

    #[test]
    fn two_ipc_commands_ending_in_a_file_write_stay_two_families() {
        let run = flow("flow:1", "ipc", None, "chat:run", &["file"], &[]);
        let rename = flow("flow:2", "ipc", None, "archive:rename", &["file"], &[]);
        let flows = vec![&run, &rename];
        let grouped = outcomes_of(&flows);
        let keys: BTreeSet<&str> = grouped.keys().map(|family| family.key.as_str()).collect();
        assert_eq!(keys, BTreeSet::from(["asks:chat:run", "asks:archive:rename"]));
        assert_eq!(grouped.len(), 2, "each named command must be its own family: {keys:?}");
    }

    #[test]
    fn a_cli_and_a_tool_command_are_also_named_by_themselves() {
        let cli = flow("flow:3", "cli", None, "deploy", &["release"], &[]);
        let tool = flow("flow:4", "tool", None, "find_tests", &["release"], &[]);
        let flows = vec![&cli, &tool];
        let grouped = outcomes_of(&flows);
        let keys: BTreeSet<&str> = grouped.keys().map(|family| family.key.as_str()).collect();
        assert_eq!(keys, BTreeSet::from(["asks:deploy", "asks:find_tests"]));
    }

    #[test]
    fn an_http_route_family_is_unchanged() {
        let route = flow("flow:5", "http", Some("GET"), "/orders", &[], &["orders"]);
        let flows = vec![&route];
        let grouped = outcomes_of(&flows);
        let keys: Vec<&str> = grouped.keys().map(|family| family.key.as_str()).collect();
        assert_eq!(keys, vec!["shows:orders"], "an http framework route must not be keyed by name");
    }

    #[test]
    fn command_namespaces_share_an_object_for_join_the_same() {
        assert_eq!(object_of("asks:archive:rename"), "archive");
        assert_eq!(object_of("asks:archive:delete"), "archive");
        assert_ne!(object_of("asks:archive:rename"), object_of("asks:chat:run"));
        assert_eq!(object_of("changes:orders"), "orders");
    }

    #[test]
    fn a_named_command_is_terminal() {
        let family = Family { key: "asks:chat:run".to_string(), basis: "the command someone explicitly asked it to run" };
        let acts = flow("flow:1", "ipc", None, "chat:run", &["chat"], &[]);
        assert_eq!(terminality_of(&family, &[&acts]), "terminal");
    }

    fn logical_step(kind: &'static str, object: Option<&str>) -> crate::steps::LogicalStep {
        crate::steps::LogicalStep {
            id: "s1".to_string(),
            kind,
            label: kind.to_string(),
            object: object.map(str::to_string),
            doing: None,
            when: "always",
            regions: Vec::new(),
            description: None,
        }
    }

    #[test]
    fn a_bare_signal_relay_command_is_not_forced_terminal() {
        let family = Family { key: "asks:window:closeShortcut".to_string(), basis: "the command someone explicitly asked it to run" };
        let mut relay = flow("flow:1", "ipc", None, "window:closeShortcut", &[], &[]);
        relay.steps.push(logical_step("raise", Some("close_event")));
        assert_eq!(terminality_of(&family, &[&relay]), "proximal");
    }

    #[test]
    fn a_named_command_that_writes_a_record_stays_terminal() {
        let family = Family { key: "asks:archive:rename".to_string(), basis: "the command someone explicitly asked it to run" };
        let mut renamed = flow("flow:1", "ipc", None, "archive:rename", &["file"], &[]);
        renamed.steps.push(logical_step("change", Some("file")));
        assert_eq!(terminality_of(&family, &[&renamed]), "terminal");
    }

    #[test]
    fn a_named_command_with_hand_written_logic_beyond_a_relay_stays_terminal() {
        let family = Family { key: "asks:text:replace".to_string(), basis: "the command someone explicitly asked it to run" };
        let mut replaces = flow("flow:1", "ipc", None, "text:replace", &[], &[]);
        replaces.steps.push(logical_step("do", None));
        assert_eq!(terminality_of(&family, &[&replaces]), "terminal");
    }

    #[test]
    fn exact_duplicate_asks_only_capabilities_merge_without_asking_ai() {
        let mut key_of: BTreeMap<&str, &str> = BTreeMap::new();
        key_of.insert("f0", "asks:engine:configure");
        key_of.insert("f1", "asks:engine:setup");
        let mut held = vec![
            Held {
                name: "Configure engine environment".to_string(),
                description: "Sets up the engine".to_string(),
                audience: "developer".to_string(),
                families: BTreeSet::from(["f0".to_string()]),
            },
            Held {
                name: "  configure   engine environment ".to_string(),
                description: "Sets up the engine".to_string(),
                audience: "developer".to_string(),
                families: BTreeSet::from(["f1".to_string()]),
            },
        ];
        merge_exact_asks_duplicates(&mut held, &key_of);
        assert_eq!(held.len(), 1, "identical-named asks-only capabilities must merge deterministically");
        assert_eq!(held[0].families, BTreeSet::from(["f0".to_string(), "f1".to_string()]));
    }

    #[test]
    fn duplicate_names_across_a_mixed_family_are_left_for_the_ai() {
        let mut key_of: BTreeMap<&str, &str> = BTreeMap::new();
        key_of.insert("f0", "asks:engine:configure");
        key_of.insert("f1", "changes:engine");
        let mut held = vec![
            Held {
                name: "Configure engine environment".to_string(),
                description: "one".to_string(),
                audience: "developer".to_string(),
                families: BTreeSet::from(["f0".to_string()]),
            },
            Held {
                name: "Configure engine environment".to_string(),
                description: "two".to_string(),
                audience: "developer".to_string(),
                families: BTreeSet::from(["f1".to_string()]),
            },
        ];
        merge_exact_asks_duplicates(&mut held, &key_of);
        assert_eq!(held.len(), 2, "a non-asks family must not be merged deterministically");
    }

    #[test]
    fn object_nouns_widen_clustering_for_asks_only_capabilities() {
        let mut key_of: BTreeMap<&str, &str> = BTreeMap::new();
        key_of.insert("f0", "asks:accounts:signIn");
        key_of.insert("f1", "asks:auth:manage");
        let held = vec![
            Held {
                name: "Sign in with subscription account".to_string(),
                description: String::new(),
                audience: String::new(),
                families: BTreeSet::from(["f0".to_string()]),
            },
            Held {
                name: "Authenticate with subscription accounts".to_string(),
                description: String::new(),
                audience: String::new(),
                families: BTreeSet::from(["f1".to_string()]),
            },
        ];
        let clusters = could_repeat(&held, &key_of);
        assert_eq!(clusters, vec![vec![0, 1]], "a shared object noun must cluster two different asks namespaces");
    }

    #[test]
    fn namespace_dashes_and_underscores_are_treated_the_same() {
        let mut key_of: BTreeMap<&str, &str> = BTreeMap::new();
        key_of.insert("f0", "asks:chat-session:list");
        key_of.insert("f1", "asks:chat_sessions:create");
        let held = vec![
            Held {
                name: "List chats".to_string(),
                description: String::new(),
                audience: String::new(),
                families: BTreeSet::from(["f0".to_string()]),
            },
            Held {
                name: "Start a chat".to_string(),
                description: String::new(),
                audience: String::new(),
                families: BTreeSet::from(["f1".to_string()]),
            },
        ];
        let clusters = could_repeat(&held, &key_of);
        assert_eq!(clusters, vec![vec![0, 1]], "chat-session and chat_sessions must normalize to the same namespace");
    }

    #[test]
    fn oversized_asks_clusters_split_into_bounded_groups_without_dropping_members() {
        let mut key_of: BTreeMap<&str, &str> = BTreeMap::new();
        let mut held = Vec::new();
        for at in 0..(FAMILIES_PER_PROPOSAL * 2 + 3) {
            let id = format!("f{at}");
            key_of.insert(Box::leak(id.clone().into_boxed_str()), Box::leak(format!("asks:usage{at}:track").into_boxed_str()));
            held.push(Held {
                name: "Track API usage".to_string(),
                description: String::new(),
                audience: String::new(),
                families: BTreeSet::from([id]),
            });
        }
        let clusters = could_repeat(&held, &key_of);
        let total: usize = clusters.iter().map(Vec::len).sum();
        assert_eq!(total, held.len(), "no member may be dropped when a cluster is split");
        assert!(clusters.iter().all(|cluster| cluster.len() <= FAMILIES_PER_PROPOSAL), "each split cluster must stay bounded: {clusters:?}");
    }
}
