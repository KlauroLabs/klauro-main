use std::collections::{BTreeMap, BTreeSet};

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::author::{Placed, Proposal, Proposed};
use crate::comprehend::{carved_name, settle, Capability, Delivery, Family, Flow, PUBLISHED};

const FAMILIES_PER_PROPOSAL: usize = 60;
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
        .max_by_key(|(at, reading)| (settled(reading), reading.capabilities.len(), std::cmp::Reverse(*at)))
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

fn outcome_of(flow: &Flow, bookkeeping: &BTreeSet<&str>) -> Family {
    if flow.kind == "export" {
        return crate::comprehend::family_of(flow);
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

pub(crate) fn terminality_of(family: &Family) -> &'static str {
    match family.key.split(':').next().unwrap_or_default() {
        "changes" | "hands on" | "calls" | "acts" | "keeps" => "terminal",
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
        terminality_of(family),
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
    family.split_once(':').map(|(_, object)| object).unwrap_or(family)
}

fn terminal_first(family: &str) -> bool {
    matches!(family.split(':').next().unwrap_or_default(), "changes" | "hands on" | "calls" | "acts")
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

fn consolidate_within(said: &str, held: Vec<Held>) -> Vec<Held> {
    if held.len() < 2 {
        return held;
    }
    let listed: BTreeMap<String, String> = held
        .iter()
        .enumerate()
        .map(|(at, other)| {
            (
                format!("c{at}"),
                format!(
                    "  it is called: {}\n  for: {}\n  what someone gets: {}",
                    other.name, other.audience, other.description
                ),
            )
        })
        .collect();
    let groups = crate::author::same_outcome(said, &listed);
    let mut taken: Vec<bool> = vec![false; held.len()];
    let mut slots: Vec<Option<Held>> = held.into_iter().map(Some).collect();
    let mut joined: Vec<Held> = Vec::new();
    for group in groups {
        let members: Vec<usize> = group
            .of
            .iter()
            .filter_map(|id| id.trim().strip_prefix('c')?.parse::<usize>().ok())
            .filter(|at| *at < taken.len() && !taken[*at])
            .collect();
        if members.is_empty() {
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
    joined.extend(slots.into_iter().flatten());
    joined
}

pub(crate) fn of_a_part(flows: &[&Flow], said: &str, remembered_as: &str, fields: &Fields) -> Vec<Capability> {
    if !crate::author::asked() || flows.is_empty() {
        return Vec::new();
    }
    let served = flows.iter().any(|flow| SERVED_KINDS.contains(&flow.kind));
    let kept: Vec<&Flow> = flows
        .iter()
        .copied()
        .filter(|flow| !served || flow.kind != "export")
        .filter(|flow| !only_moves_the_screen(flow))
        .collect();
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
            let proposals: Vec<Proposal> = match listed.len() <= FAMILIES_PER_PROPOSAL {
                true => vec![most_detailed_reading(said, &listed)],
                false => listed
                    .par_chunks(FAMILIES_PER_PROPOSAL)
                    .map(|chunk| crate::author::propose_capabilities(said, chunk))
                    .collect(),
            };
            let chunked = proposals.len() > 1;
            let mut held: Vec<Held> = Vec::new();
            let mut plumbing: BTreeSet<String> = BTreeSet::new();
            let proposed: usize = proposals.iter().map(|proposal| proposal.capabilities.len()).sum();
            gather(proposals, &mut held, &mut plumbing, &known);
            if std::env::var("KLAURO_AUTHOR_DEBUG").is_ok() {
                eprintln!("  proposed {proposed} capabilities, {} held after gathering, {} plumbing", held.len(), plumbing.len());
            }
            if chunked {
                held = consolidate_within(said, held);
            }
            hold_together(said, &told, &mut held);
            place(said, &told, &mut held, &mut plumbing);
            join_the_same(said, &mut held);
            (held, plumbing)
        }
    };
    held.retain(|other| !other.families.is_empty());
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
        if terminality_of(family) == "terminal" || capability.terminality.is_none() {
            capability.terminality = Some(terminality_of(family));
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
