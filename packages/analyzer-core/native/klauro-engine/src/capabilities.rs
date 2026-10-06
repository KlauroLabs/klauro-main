use std::collections::{BTreeMap, BTreeSet};

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::author::{Placed, Proposal, Proposed, Serving};
use crate::comprehend::{carved_name, settle, Capability, Delivery, Family, Flow, PUBLISHED};

const FAMILIES_PER_PROPOSAL: usize = 20;
const PLACING_ROUNDS: usize = 2;
const READINGS: usize = 3;

fn most_detailed_reading(said: &str, listed: &[(String, String)]) -> Proposal {
    let mut orders: Vec<Vec<(String, String)>> = Vec::new();
    for at in 0..READINGS {
        let mut ordered = listed.to_vec();
        match at {
            0 => {}
            1 => ordered.reverse(),
            _ => ordered.rotate_left(listed.len() / 2),
        }
        if !orders.contains(&ordered) {
            orders.push(ordered);
        }
    }
    let weight = crate::author::weight();
    let readings: Vec<Proposal> = crate::author::asking(|| {
        orders
            .par_iter()
            .map(|ordered| crate::author::weighing(weight, || crate::author::propose_capabilities(said, ordered, false)))
            .collect()
    });
    let settled = |reading: &Proposal| {
        let named: BTreeSet<&str> =
            reading.capabilities.iter().flat_map(|held| held.families.iter().map(String::as_str)).collect();
        listed.iter().filter(|(id, _)| named.contains(id.as_str())).count()
    };
    readings
        .into_iter()
        .enumerate()
        .max_by_key(|(at, reading)| {
            (settled(reading), std::cmp::Reverse(reading.capabilities.len()), std::cmp::Reverse(*at))
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
    roles: BTreeMap<String, Serving>,
}

impl Held {
    fn absorb(&mut self, other: Held) {
        self.families.extend(other.families);
        for (family, serving) in other.roles {
            self.roles.entry(family).or_insert(serving);
        }
    }
}

#[derive(Serialize, Deserialize, Default)]
struct Remembered {
    digest: String,
    capabilities: Vec<RememberedCapability>,
    families: BTreeMap<String, String>,
}

#[derive(Serialize, Deserialize)]
struct RememberedCapability {
    name: String,
    description: String,
    audience: String,
    families: BTreeSet<String>,
    #[serde(default)]
    roles: BTreeMap<String, (String, String)>,
}

pub(crate) type Fields = BTreeMap<String, String>;

const RECORDS_DESCRIBED: usize = 4;

pub(crate) const PART: &str = "part";
pub(crate) const WHOLE: &str = "whole";
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

const FUNCTIONS_TOLD: usize = 14;
const SPLIT_FROM_FLOWS: usize = 30;
const SPLIT_OUTCOMES_SHOWN: usize = 80;
const SPLIT_LINES_PER_OUTCOME: usize = 4;

fn is_only_a_trigger(family: &Family) -> bool {
    family.key.starts_with("trigger:")
}

pub(crate) fn is_caller_initiated(flow: &Flow) -> bool {
    crate::entry_exit::USER_FACING.contains(&flow.kind)
}

fn outcomes_reached(flow: &Flow, bookkeeping: &BTreeSet<&str>) -> BTreeSet<Family> {
    let primary = outcome_of(flow, bookkeeping);
    if flow.kind == "export" || asked_for_by_name(flow).is_some() {
        return BTreeSet::from([primary]);
    }
    let changed: BTreeSet<Family> = flow
        .writes
        .iter()
        .filter(|record| !bookkeeping.contains(record.as_str()))
        .map(|record| Family { key: format!("changes:{record}"), basis: "the record it changes" })
        .collect();
    let handed: BTreeSet<Family> = flow
        .steps
        .iter()
        .filter(|step| matches!(step.kind, "raise" | "hand_off"))
        .filter_map(|step| step.object.as_deref())
        .map(|object| Family { key: format!("hands on:{object}"), basis: "what it hands on to another part" })
        .collect();
    if changed.len() + handed.len() < 2 {
        return BTreeSet::from([primary]);
    }
    let mut reached: BTreeSet<Family> = changed.into_iter().chain(handed).collect();
    if !primary.key.starts_with("records:") && !primary.key.starts_with("changes:") {
        reached.insert(primary);
    }
    reached
}

fn only_passes_work_on(flow: &Flow) -> bool {
    flow.kind != "export" && only_relays_a_signal(&[flow])
}

pub(crate) fn outcomes_of<'a>(flows: &[&'a Flow]) -> BTreeMap<Family, Vec<&'a Flow>> {
    let bookkeeping = kept_for_itself(flows);
    let mut grouped: BTreeMap<Family, Vec<&'a Flow>> = BTreeMap::new();
    let mut traversed: Vec<&'a Flow> = Vec::new();
    for flow in flows {
        if only_passes_work_on(flow) {
            traversed.push(flow);
            continue;
        }
        for family in outcomes_reached(flow, &bookkeeping) {
            grouped.entry(family).or_default().push(flow);
        }
    }
    if grouped.is_empty() {
        for flow in traversed {
            for family in outcomes_reached(flow, &bookkeeping) {
                grouped.entry(family).or_default().push(flow);
            }
        }
    }
    if grouped.keys().any(|family| !is_only_a_trigger(family)) {
        grouped.retain(|family, _| !is_only_a_trigger(family));
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
        told = touched_by(flow);
    }
    told
}

fn touched_by(flow: &Flow) -> String {
    let mut touched: Vec<&str> = Vec::new();
    for step in &flow.path {
        let name = step.unit.rsplit(':').next().unwrap_or_default();
        if !name.is_empty() && touched.last() != Some(&name) && !touched.contains(&name) {
            touched.push(name);
        }
    }
    let more = touched.len().saturating_sub(STEPS_TOLD);
    touched.truncate(STEPS_TOLD);
    match touched.is_empty() {
        true => "no steps read".to_string(),
        false => format!(
            "no steps read; it runs through {}{}",
            touched.join(" -> "),
            match more {
                0 => String::new(),
                more => format!(" -> and {more} more"),
            }
        ),
    }
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
                && flow.reads.is_empty()
                && flow.reaches.is_empty()
                && flow.steps.iter().any(|step| matches!(step.kind, "raise" | "hand_off"))
                && flow.steps.iter().all(|step| matches!(step.kind, "raise" | "hand_off" | "respond"))
        })
}

const ONLY_PASSES_A_SIGNAL: &str =
    "; its paths only pass a signal on or hand what arrives to another part, and change, call and keep nothing themselves";

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
    let functions_run: Vec<&str> = match flows {
        [flow] if flow.kind == "cli" => {
            flow.stages.iter().flat_map(|stage| stage.names.iter().map(String::as_str)).take(FUNCTIONS_TOLD).collect()
        }
        _ => Vec::new(),
    };
    let kept: Vec<String> = writes
        .iter()
        .chain(reads.iter())
        .filter_map(|record| fields.get(record).map(|held| format!("{record} ({held})")))
        .take(RECORDS_DESCRIBED)
        .collect();
    format!(
        "  outcome ({}): {}, which is {}\n  {RECORDS_HOLD} {}\n  entered as: {}\n  reached through: {}{}\n  guarded by: {}\n  what its paths do:\n{}{}\n  writes: {}\n  reads: {}\n  reaches: {}\n  paths: {}",
        terminality_of(family, flows),
        object,
        match family.key.starts_with("asks:") && only_relays_a_signal(flows) {
            true => format!("{}{ONLY_PASSES_A_SIGNAL}", family.basis),
            false => family.basis.to_string(),
        },
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
        match functions_run.is_empty() {
            true => String::new(),
            false => format!("\n  the functions it runs: {}", functions_run.join(", ")),
        },
        listed(&writes),
        listed(&reads),
        listed(&reaches),
        flows.len()
    )
}

fn gather(proposals: Vec<Proposal>, held: &mut Vec<Held>, known: &BTreeSet<String>) {
    for proposal in proposals {
        for Proposed { name, description, audience, families, roles } in proposal.capabilities {
            let families: BTreeSet<String> = families.into_iter().filter(|id| known.contains(id)).collect();
            if families.is_empty() {
                continue;
            }
            let roles = roles.into_iter().filter(|(id, _)| families.contains(id)).collect();
            let incoming = Held { name, description, audience, families, roles };
            match held.iter_mut().find(|other| name_key(&other.name) == name_key(&incoming.name)) {
                Some(other) => other.absorb(incoming),
                None => held.push(incoming),
            }
        }
    }
}

fn merge_same_named(held: &mut Vec<Held>) {
    let mut at = 0;
    while at < held.len() {
        let key = name_key(&held[at].name);
        let mut other = at + 1;
        while other < held.len() {
            if !key.is_empty() && name_key(&held[other].name) == key {
                let merged = held.remove(other);
                held[at].absorb(merged);
            } else {
                other += 1;
            }
        }
        at += 1;
    }
}

fn consolidate_purposes(said: &str, held: Vec<Held>) -> Vec<Held> {
    if held.len() < 2 {
        return held;
    }
    let listed: Vec<(String, String)> =
        held.iter().map(|other| (other.name.clone(), in_a_line(&other.description))).collect();
    let groups = the_same_among(&listed, |offered| crate::author::same_capability(said, offered));
    if groups.is_empty() {
        return held;
    }
    let mut slots: Vec<Option<Held>> = held.into_iter().map(Some).collect();
    let mut kept: Vec<Held> = Vec::new();
    for group in groups {
        let mut members = group.members.iter();
        let Some(mut together) = members.next().and_then(|at| slots[*at].take()) else { continue };
        for at in members {
            if let Some(other) = slots[*at].take() {
                together.absorb(other);
            }
        }
        if !group.name.is_empty() {
            together.name = group.name;
        }
        if !group.description.is_empty() {
            together.description = group.description;
        }
        if !group.audience.is_empty() {
            together.audience = group.audience;
        }
        kept.push(together);
    }
    kept.extend(slots.into_iter().flatten());
    kept
}

fn unseated<'a>(known: impl Iterator<Item = &'a String>, held: &[Held]) -> Vec<String> {
    let seated: BTreeSet<&String> = held.iter().flat_map(|other| other.families.iter()).collect();
    known.filter(|id| !seated.contains(id)).cloned().collect()
}

fn place(
    said: &str,
    told: &BTreeMap<String, String>,
    held: &mut Vec<Held>,
) -> bool {
    let unplaced: Vec<(String, String)> = unseated(told.keys(), held)
        .into_iter()
        .filter_map(|id| told.get(&id).map(|evidence| (id, evidence.clone())))
        .collect();
    let placed: BTreeSet<String> = held.iter().flat_map(|other| other.families.iter().cloned()).collect();
    if unplaced.is_empty() {
        return false;
    }
    let standing: Vec<(String, String)> =
        held.iter().map(|other| (other.name.clone(), other.description.clone())).collect();
    let weight = crate::author::weight();
    let answers: Vec<Placed> = crate::author::asking(|| {
        unplaced
            .par_chunks(FAMILIES_PER_PROPOSAL)
            .flat_map(|chunk| crate::author::weighing(weight, || crate::author::place_families(said, &standing, chunk)))
            .collect()
    });
    let answered = !answers.is_empty();
    for Placed { family, capability, description, audience, role, why } in answers {
        if !told.contains_key(&family) || placed.contains(&family) {
            continue;
        }
        if name_key(&capability) == name_key(crate::author::UNASSIGNED) {
            continue;
        }
        let roles: BTreeMap<String, Serving> = crate::author::role_named(&role)
            .map(|role| BTreeMap::from([(family.clone(), Serving { role: role.to_string(), why: why.trim().to_string() })]))
            .unwrap_or_default();
        match held.iter_mut().find(|other| name_key(&other.name) == name_key(&capability)) {
            Some(other) => other.absorb(Held {
                name: capability,
                description,
                audience,
                families: BTreeSet::from([family]),
                roles,
            }),
            None => held.push(Held { name: capability, description, audience, families: BTreeSet::from([family]), roles }),
        }
    }
    answered
}

pub(crate) fn is_proposable(flow: &Flow) -> bool {
    !crate::unshipped::is_set_aside(flow.unshipped.as_ref())
}

fn lines_of_outcomes(held: &Held, lanes: &BTreeMap<&str, (&Family, &Vec<&Flow>)>) -> Vec<(usize, String)> {
    let mut lines: Vec<(usize, String)> = Vec::new();
    for family_id in &held.families {
        let Some((family, lane)) = lanes.get(family_id.as_str()) else { continue };
        let (_, object) = family.key.split_once(':').unwrap_or(("", family.key.as_str()));
        let role = held.roles.get(family_id).map(|serving| serving.role.as_str()).unwrap_or("primary");
        let mut surfaces: Vec<String> = lane.iter().map(|flow| surface_of(flow)).collect();
        settle(&mut surfaces);
        let more = surfaces.len().saturating_sub(OUTCOME_SURFACES);
        surfaces.truncate(OUTCOME_SURFACES);
        lines.push((
            lane.len(),
            format!(
                "    - {role}: {object}, reached through {}{}",
                surfaces.join(", "),
                match more {
                    0 => String::new(),
                    more => format!(" and {more} more"),
                }
            ),
        ));
    }
    lines.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| left.1.cmp(&right.1)));
    lines
}

const OUTCOMES_LISTED: usize = 40;
const OUTCOME_SURFACES: usize = 2;
const OUTCOMES_DETAILED: usize = 2;

fn evidence_of_capability(held: &Held, lanes: &BTreeMap<&str, (&Family, &Vec<&Flow>)>, fields: &Fields) -> String {
    let lines = lines_of_outcomes(held, lanes);
    let more = lines.len().saturating_sub(OUTCOMES_LISTED);
    let mut told = format!(
        "  it is served by {} outcomes, each with its role in it:\n{}{}",
        lines.len(),
        lines.iter().take(OUTCOMES_LISTED).map(|(_, line)| line.as_str()).collect::<Vec<_>>().join("\n"),
        match more {
            0 => String::new(),
            more => format!("\n    - and {more} more outcomes"),
        }
    );
    let mut main: Vec<(&Family, &Vec<&Flow>)> =
        held.families.iter().filter_map(|id| lanes.get(id.as_str()).copied()).collect();
    main.sort_by(|left, right| right.1.len().cmp(&left.1.len()).then_with(|| left.0.key.cmp(&right.0.key)));
    for (family, lane) in main.into_iter().take(OUTCOMES_DETAILED) {
        told.push('\n');
        told.push_str(&evidence_of(lane, family, fields));
    }
    told
}

fn flows_held(held: &Held, lanes: &BTreeMap<&str, &Vec<&Flow>>) -> usize {
    held.families
        .iter()
        .filter_map(|id| lanes.get(id.as_str()))
        .flat_map(|lane| lane.iter().map(|flow| flow.id.as_str()))
        .collect::<BTreeSet<&str>>()
        .len()
}

fn split_the_broad(
    said: &str,
    told: &BTreeMap<String, String>,
    lanes: &BTreeMap<&str, &Vec<&Flow>>,
    held: Vec<Held>,
) -> Vec<Held> {
    let (broad, mut kept): (Vec<Held>, Vec<Held>) =
        held.into_iter().partition(|other| flows_held(other, lanes) > SPLIT_FROM_FLOWS);
    if broad.is_empty() {
        return kept;
    }
    let weight = crate::author::weight();
    let proposals: Vec<(usize, Proposal)> = crate::author::asking(|| {
        broad
            .par_iter()
            .map(|wide| crate::author::weighing(weight, || {
                let listed: Vec<(String, String)> = wide
                    .families
                    .iter()
                    .filter_map(|id| {
                        told.get(id).map(|evidence| {
                            (id.clone(), evidence.lines().take(SPLIT_LINES_PER_OUTCOME).collect::<Vec<_>>().join("\n"))
                        })
                    })
                    .take(SPLIT_OUTCOMES_SHOWN)
                    .collect();
                let proposal = crate::author::split_purpose(said, &wide.name, &wide.description, &listed);
                (listed.len(), proposal)
            }))
            .collect()
    });
    let mut split_any = false;
    for (wide, (outcomes, proposal)) in broad.into_iter().zip(proposals) {
        if std::env::var("KLAURO_AUTHOR_DEBUG").is_ok() {
            eprintln!("  split {} over {} outcomes into {} capabilities", wide.name, outcomes, proposal.capabilities.len());
        }
        if proposal.capabilities.len() < 2 {
            kept.push(wide);
            continue;
        }
        split_any = true;
        let known: BTreeSet<String> = wide.families.clone();
        gather(vec![proposal], &mut kept, &known);
    }
    if split_any {
        place(said, told, &mut kept);
    }
    kept
}

pub(crate) const SETTLED: &str = "settled";
pub(crate) const PENDING: &str = "pending";
pub(crate) const ABSENT: &str = "none";

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct PartState {
    pub capabilities: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

pub(crate) struct OfAPart {
    pub(crate) capabilities: Vec<Capability>,
    pub(crate) state: PartState,
    pub(crate) pending: BTreeSet<String>,
}

impl OfAPart {
    fn without(state: &'static str, reason: &str) -> OfAPart {
        OfAPart {
            capabilities: Vec::new(),
            state: PartState { capabilities: state, reason: Some(reason.to_string()) },
            pending: BTreeSet::new(),
        }
    }
}

fn candidate_flows<'a>(flows: &[&'a Flow]) -> Vec<&'a Flow> {
    let proposable = |flow: &&Flow| is_proposable(flow);
    let tiers: [Vec<&Flow>; 4] = [
        flows.iter().copied().filter(|flow| is_caller_initiated(flow)).filter(proposable).collect(),
        flows.iter().copied().filter(|flow| flow.kind == "export").filter(proposable).collect(),
        flows.iter().copied().filter(proposable).collect(),
        flows.to_vec(),
    ];
    let reaches_an_outcome = |tier: &Vec<&Flow>| {
        outcomes_of(tier).iter().any(|(family, lane)| terminality_of(family, lane) == "terminal")
    };
    tiers
        .iter()
        .find(|tier| reaches_an_outcome(tier))
        .or_else(|| tiers.iter().find(|tier| !outcomes_of(tier).is_empty()))
        .cloned()
        .unwrap_or_default()
}

pub(crate) fn of_a_part(flows: &[&Flow], said: &str, remembered_as: &str, fields: &Fields) -> OfAPart {
    let candidates = candidate_flows(flows);
    if std::env::var("KLAURO_FAMILY_DUMP").is_ok() {
        for family in outcomes_of(&candidates).keys() {
            eprintln!("family[{remembered_as}]: {}", family.key);
        }
    }
    let families = outcomes_of(&candidates);
    if families.is_empty() {
        return OfAPart::without(ABSENT, "the part holds no flow");
    }
    if !crate::author::asked() {
        return OfAPart::without(PENDING, "the AI was not asked");
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
        .map(|(id, evidence)| {
            (
                key_of[id.as_str()].to_string(),
                crate::jev::named(&format!("{}\u{1}{said}\u{1}{evidence}", crate::author::PURPOSE_CONTRACT_VERSION)),
            )
        })
        .collect();
    let digest = crate::jev::named(&format!("{}\u{1}{said}\u{1}{:?}", crate::author::PURPOSE_CONTRACT_VERSION, evidence_of_key));
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
    let mut held = match memory {
        Some(memory) if memory.digest == digest => recollected(&memory, &id_of, |_| true),
        Some(memory) => {
            let mut held = recollected(&memory, &id_of, |key| {
                memory.families.get(key).is_some_and(|was| evidence_of_key.get(key) == Some(was))
            });
            place(said, &told, &mut held);
            held
        }
        None => {
            let listed: Vec<(String, String)> =
                told.iter().map(|(id, evidence)| (id.clone(), evidence.clone())).collect();
            let proposing = std::time::Instant::now();
            let proposals: Vec<Proposal> = match listed.len() <= FAMILIES_PER_PROPOSAL {
                true => vec![most_detailed_reading(said, &listed)],
                false => crate::author::asking(|| {
                    let weight = crate::author::weight();
                    listed
                        .par_chunks(FAMILIES_PER_PROPOSAL)
                        .map(|chunk| crate::author::weighing(weight, || most_detailed_reading(said, chunk)))
                        .collect()
                }),
            };
            let chunked = proposals.len() > 1;
            let mut held: Vec<Held> = Vec::new();
            if std::env::var("KLAURO_AUTHOR_DEBUG").is_ok() {
                eprintln!("  proposing {} outcomes took {:?}", listed.len(), proposing.elapsed());
            }
            let proposed: usize = proposals.iter().map(|proposal| proposal.capabilities.len()).sum();
            gather(proposals, &mut held, &known);
            if std::env::var("KLAURO_AUTHOR_DEBUG").is_ok() {
                eprintln!("  proposed {proposed} capabilities, {} held after gathering", held.len());
            }
            let clock = std::time::Instant::now();
            let counted = |step: &str, held: &Vec<Held>| {
                if std::env::var("KLAURO_AUTHOR_DEBUG").is_ok() {
                    eprintln!("  after {step}: {} capabilities at {:?}", held.len(), clock.elapsed());
                }
            };
            if chunked {
                held = consolidate_purposes(said, held);
                counted("consolidating purposes", &held);
            }
            place(said, &told, &mut held);
            counted("placing", &held);
            held
        }
    };
    held.retain(|other| !other.families.is_empty());
    for again in [false, true] {
        if !held.is_empty() {
            break;
        }
        let mut listed: Vec<(String, String)> = told.iter().map(|(id, evidence)| (id.clone(), evidence.clone())).collect();
        if again {
            listed.reverse();
        }
        let proposals: Vec<Proposal> = crate::author::asking(|| {
            let weight = crate::author::weight();
            listed
                .par_chunks(FAMILIES_PER_PROPOSAL)
                .map(|chunk| crate::author::weighing(weight, || crate::author::propose_capabilities(said, chunk, true)))
                .collect()
        });
        gather(proposals, &mut held, &known);
    }
    for _ in 0..PLACING_ROUNDS {
        if unseated(known.iter(), &held).is_empty() || !place(said, &told, &mut held) {
            break;
        }
    }
    merge_same_named(&mut held);
    let lane_flows: BTreeMap<&str, &Vec<&Flow>> = keyed.iter().map(|(id, _, lane)| (id.as_str(), *lane)).collect();
    held = split_the_broad(said, &told, &lane_flows, held);
    merge_same_named(&mut held);
    if std::env::var("KLAURO_AUTHOR_DEBUG").is_ok() {
        let unseated = unseated(known.iter(), &held);
        eprintln!("  settled {} capabilities and {} unassigned of {} outcomes", held.len(), unseated.len(), told.len());
        for id in &unseated {
            eprintln!("  unassigned {}", key_of[id.as_str()]);
        }
    }
    let settled_every_family = unseated(known.iter(), &held).is_empty();
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
                        roles: other
                            .roles
                            .iter()
                            .filter(|(id, _)| key_of.contains_key(id.as_str()))
                            .map(|(id, serving)| (key_of[id.as_str()].to_string(), (serving.role.clone(), serving.why.clone())))
                            .collect(),
                    })
                    .collect(),
                families: evidence_of_key.clone(),
            },
        );
    }
    let lanes: BTreeMap<&str, (&Family, &Vec<&Flow>)> =
        keyed.iter().map(|(id, family, lane)| (id.as_str(), (*family, *lane))).collect();
    let unanswered: BTreeSet<&str> = known
        .iter()
        .map(String::as_str)
        .filter(|id| !held.iter().any(|other| other.families.contains(*id)))
        .collect();
    let pending: BTreeSet<String> = unanswered
        .iter()
        .filter_map(|id| lanes.get(id))
        .flat_map(|(_, lane)| lane.iter().map(|flow| flow.id.clone()))
        .collect();
    let mut formed: Vec<Capability> = held.into_iter().filter_map(|other| built(other, &lanes, fields)).collect();
    formed.sort_by(|left, right| left.id.cmp(&right.id));
    let state = match (unanswered.is_empty(), formed.is_empty()) {
        (true, false) => PartState { capabilities: SETTLED, reason: None },
        (true, true) => PartState {
            capabilities: PENDING,
            reason: Some("the AI named no purpose for this part after being asked twice".to_string()),
        },
        (false, _) => PartState {
            capabilities: PENDING,
            reason: Some(format!("the AI left {} of {} outcomes unanswered", unanswered.len(), known.len())),
        },
    };
    OfAPart { capabilities: formed, state, pending }
}

fn recollected(
    memory: &Remembered,
    id_of: &BTreeMap<&str, &str>,
    still_holds: impl Fn(&str) -> bool,
) -> Vec<Held> {
    memory
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
            roles: was
                .roles
                .iter()
                .filter(|(key, _)| still_holds(key))
                .filter_map(|(key, (role, why))| {
                    Some((id_of.get(key.as_str())?.to_string(), Serving { role: role.clone(), why: why.clone() }))
                })
                .collect(),
        })
        .collect()
}

static SCREEN_EVENTS: &[&str] = &[
    "blur", "change", "click", "contextmenu", "dblclick", "domcontentloaded", "focus", "input", "keydown", "keypress",
    "keyup", "load", "mousedown", "mouseenter", "mouseleave", "mousemove", "mouseout", "mouseover", "mouseup",
    "pointerdown", "pointerenter", "pointerleave", "pointermove", "pointerout", "pointerover", "pointerup", "resize",
    "scroll", "touchend", "touchmove", "touchstart", "visibilitychange", "wheel",
];

pub(crate) fn is_a_screen_event(operation: &str) -> bool {
    SCREEN_EVENTS.contains(&operation.to_ascii_lowercase().as_str())
}

fn built(held: Held, lanes: &BTreeMap<&str, (&Family, &Vec<&Flow>)>, fields: &Fields) -> Option<Capability> {
    let name = held.name.trim().to_string();
    if name.is_empty() {
        return None;
    }
    let evidence = evidence_of_capability(&held, lanes, fields);
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
        level: crate::capabilities::PART,
        touches: Vec::new(),
        terminality: None,
        confidence: None,
        unsettled: None,
        composition_provenance: Vec::new(),
        parent_originated: None,
        evidence,
    };
    for family_id in &held.families {
        let Some((family, lane)) = lanes.get(family_id.as_str()) else { continue };
        let terminality = terminality_of(family, lane);
        if terminality == "terminal" || capability.terminality.is_none() {
            capability.terminality = Some(terminality);
        }
        let serving = held.roles.get(family_id);
        for flow in lane.iter() {
            capability.project = capability.project.take().or_else(|| flow.project.clone());
            capability.delivered.push(Delivery {
                flow: flow.id.clone(),
                role: serving
                    .and_then(|serving| crate::author::role_named(&serving.role))
                    .unwrap_or(match flow.standing {
                        "terminal" | "proximal" => "primary",
                        _ => "supporting",
                    }),
                rationale: match serving.map(|serving| serving.why.as_str()).filter(|why| !why.is_empty()) {
                    Some(why) => why.to_string(),
                    None => format!("{} belongs here by {}", flow.operation, family.basis),
                },
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
    capability.delivered.sort_by(|left, right| left.flow.cmp(&right.flow).then_with(|| role_rank(left.role).cmp(&role_rank(right.role))));
    capability.delivered.dedup_by(|left, right| left.flow == right.flow);
    capability.flows = capability.delivered.iter().map(|held| held.flow.clone()).collect();
    settle(&mut capability.surfaces);
    settle(&mut capability.records);
    settle(&mut capability.touches);
    settle(&mut capability.changes);
    Some(capability)
}

fn role_rank(role: &str) -> usize {
    crate::author::SERVING_ROLES.iter().position(|held| *held == role).unwrap_or(usize::MAX)
}

#[derive(Debug, Serialize, Clone)]
pub struct PartCoverage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    pub flows: u32,
    pub related: u32,
    pub unmapped: u32,
    pub flows_to_capabilities: f64,
    pub capabilities: PartState,
}

#[derive(Debug, Serialize, Clone)]
pub struct Unmapped {
    pub flow: String,
    pub reason: String,
}

#[derive(Debug, Serialize, Clone, Default)]
pub struct Coverage {
    pub flows: u32,
    pub related: u32,
    pub unmapped: u32,
    pub flows_to_capabilities: f64,
    pub parts: Vec<PartCoverage>,
    pub unmapped_flows: Vec<Unmapped>,
}

fn share_of(related: u32, flows: u32) -> f64 {
    match flows {
        0 => 0.0,
        flows => (f64::from(related) / f64::from(flows) * 1000.0).round() / 1000.0,
    }
}

fn why_unmapped(flow: &Flow, pending: &BTreeSet<String>) -> String {
    if let Some(tag) = flow.unshipped.as_ref().filter(|tag| crate::unshipped::is_set_aside(Some(tag))) {
        return format!("set aside as not shipped: {} ({})", tag.role, tag.basis);
    }
    if !is_caller_initiated(flow) && flow.kind != "export" {
        return format!("a {} entry is started by the runtime, not by a caller", flow.kind);
    }
    if pending.contains(&flow.id) {
        return "the AI left its outcome unanswered".to_string();
    }
    if flow.writes.is_empty() && flow.reads.is_empty() && flow.changes.is_empty() && flow.reaches.is_empty() {
        return "it reaches no domain entity and changes nothing outside the program".to_string();
    }
    "no capability the product states is served by it".to_string()
}

pub(crate) fn coverage_of(
    flows: &[Flow],
    capabilities: &[Capability],
    states: &BTreeMap<Option<String>, PartState>,
    pending: &BTreeSet<String>,
) -> Coverage {
    let related: BTreeSet<&str> =
        capabilities.iter().flat_map(|capability| capability.flows.iter().map(String::as_str)).collect();
    let mut parts: BTreeMap<Option<&str>, PartCoverage> = BTreeMap::new();
    let mut unmapped_flows: Vec<Unmapped> = Vec::new();
    let mut mapped = 0u32;
    for flow in flows {
        let part = parts.entry(flow.project.as_deref()).or_insert_with(|| PartCoverage {
            project: flow.project.clone(),
            flows: 0,
            related: 0,
            unmapped: 0,
            flows_to_capabilities: 0.0,
            capabilities: states
                .get(&flow.project)
                .cloned()
                .unwrap_or(PartState { capabilities: ABSENT, reason: Some("no caller-initiated flow was read".to_string()) }),
        });
        part.flows += 1;
        if related.contains(flow.id.as_str()) {
            part.related += 1;
            mapped += 1;
        } else {
            part.unmapped += 1;
            unmapped_flows.push(Unmapped { flow: flow.id.clone(), reason: why_unmapped(flow, pending) });
        }
    }
    let mut parts: Vec<PartCoverage> = parts.into_values().collect();
    for part in parts.iter_mut() {
        part.flows_to_capabilities = share_of(part.related, part.flows);
    }
    unmapped_flows.sort_by(|left, right| left.flow.cmp(&right.flow));
    let count = flows.len() as u32;
    Coverage {
        flows: count,
        related: mapped,
        unmapped: count - mapped,
        flows_to_capabilities: share_of(mapped, count),
        parts,
        unmapped_flows,
    }
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
                        "FIRST:\n{using}\n\nSECOND:\n{reached}\n\nThe first continues into the second, so they serve one purpose reached from two parts of the system, and the product's description would list them as one thing rather than as two separate purposes"
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
    crate::author::asking(|| chunks.par_iter().flat_map(|chunk| crate::author::same_outcome(spoken, chunk)).collect())
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

fn reaches_a_user(capability: &Capability, flow_of: &BTreeMap<&str, &Flow>) -> bool {
    capability
        .flows
        .iter()
        .filter_map(|flow| flow_of.get(flow.as_str()))
        .any(|flow| crate::entry_exit::USER_FACING.contains(&flow.kind) && flow.unshipped.is_none())
}

pub(crate) fn of_the_whole(parts: &[Capability], spoken: &str, scope: &str, flows: &[Flow]) -> Vec<Capability> {
    let scope = &format!("{scope}\u{1}{}", crate::author::PURPOSE_CONTRACT_VERSION);
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
                    "  it is called: {}\n  for: {}\n  what someone gets: {}\n  found in the part: {}\n  reached through: {}\n  records it changes: {}\n  entities it works on: {}{}",
                    capability.name.as_deref().unwrap_or(""),
                    capability.audience.as_deref().unwrap_or("someone"),
                    capability.description.as_deref().unwrap_or(""),
                    capability.project.as_deref().unwrap_or("the repository root"),
                    surfaces.join(", "),
                    in_few(&capability.records),
                    in_few(&capability.touches),
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
            .filter(|at| *at < parts.len() && !taken[*at] && reaches_a_user(&parts[*at], &flow_of))
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
        if !taken[at] && reaches_a_user(capability, &flow_of) {
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

const LISTED_AT_ONCE: usize = 120;
const TOLD_IN_A_LINE: usize = 160;
const ENTITIES_SHOWN: usize = 6;

fn in_few(held: &[String]) -> String {
    match held.is_empty() {
        true => "none".to_string(),
        false => held.iter().take(ENTITIES_SHOWN).cloned().collect::<Vec<_>>().join(", "),
    }
}

fn singular(word: &str) -> String {
    if let Some(stem) = word.strip_suffix("ies").filter(|stem| stem.len() > 1) {
        return format!("{stem}y");
    }
    if ["sses", "xes", "ches", "shes"].iter().any(|ending| word.ends_with(ending)) {
        return word[..word.len() - 2].to_string();
    }
    match word.strip_suffix('s') {
        Some(stem) if stem.len() > 2 && !stem.ends_with('s') && !stem.ends_with('u') && !stem.ends_with('i') => {
            stem.to_string()
        }
        _ => word.to_string(),
    }
}

pub(crate) fn name_key(name: &str) -> String {
    name.to_lowercase()
        .split(|letter: char| !letter.is_alphanumeric())
        .filter(|word| !word.is_empty() && !matches!(*word, "a" | "an" | "the"))
        .map(singular)
        .collect::<Vec<_>>()
        .join(" ")
}

fn in_a_line(told: &str) -> String {
    let first = told.split_terminator(". ").next().unwrap_or(told).trim();
    match first.char_indices().nth(TOLD_IN_A_LINE) {
        Some((cut, _)) => first[..cut].to_string(),
        None => first.to_string(),
    }
}

fn asked_together(listed: &[usize]) -> Vec<Vec<usize>> {
    if listed.len() <= LISTED_AT_ONCE {
        return vec![listed.to_vec()];
    }
    let halves: Vec<&[usize]> = listed.chunks(LISTED_AT_ONCE / 2).collect();
    let mut asked: Vec<Vec<usize>> = Vec::new();
    for first in 0..halves.len() {
        for second in first + 1..halves.len() {
            asked.push(halves[first].iter().chain(halves[second].iter()).copied().collect());
        }
    }
    asked
}

pub(crate) struct Joined {
    pub(crate) members: Vec<usize>,
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) audience: String,
}

pub(crate) fn the_same_among(
    listed: &[(String, String)],
    ask: impl Fn(&BTreeMap<String, String>) -> Vec<crate::author::Same> + Sync,
) -> Vec<Joined> {
    let mut leader: Vec<usize> = (0..listed.len()).collect();
    fn found(leader: &mut [usize], at: usize) -> usize {
        let mut current = at;
        while leader[current] != current {
            leader[current] = leader[leader[current]];
            current = leader[current];
        }
        current
    }
    let join = |leader: &mut Vec<usize>, first: usize, second: usize| {
        let (left, right) = (found(leader, first), found(leader, second));
        if left != right {
            leader[left.max(right)] = left.min(right);
        }
    };
    let mut first_named: BTreeMap<String, usize> = BTreeMap::new();
    for (at, (name, _)) in listed.iter().enumerate() {
        let key = name_key(name);
        if key.is_empty() {
            continue;
        }
        match first_named.get(&key).copied() {
            Some(earlier) => join(&mut leader, earlier, at),
            None => {
                first_named.insert(key, at);
            }
        }
    }
    let shown: Vec<usize> = (0..listed.len()).filter(|at| found(&mut leader, *at) == *at).collect();
    let weight = crate::author::weight();
    let answers: Vec<(Vec<usize>, Vec<crate::author::Same>)> = crate::author::asking(|| {
        asked_together(&shown)
            .into_par_iter()
            .filter(|chunk| chunk.len() > 1)
            .map(|chunk| crate::author::weighing(weight, || {
                let offered: BTreeMap<String, String> = chunk
                    .iter()
                    .map(|at| (format!("c{at}"), format!("{} | {}", listed[*at].0.trim(), listed[*at].1)))
                    .collect();
                let said = ask(&offered);
                (chunk, said)
            }))
            .collect()
    });
    let mut named: Vec<(Vec<usize>, String, String, String)> = Vec::new();
    for (chunk, said) in answers {
        for same in said {
            let members: Vec<usize> = same
                .of
                .iter()
                .filter_map(|id| id.trim().strip_prefix('c')?.parse::<usize>().ok())
                .filter(|at| chunk.contains(at))
                .collect::<BTreeSet<usize>>()
                .into_iter()
                .collect();
            if members.len() < 2 {
                continue;
            }
            for at in &members[1..] {
                join(&mut leader, members[0], *at);
            }
            named.push((members, same.name.trim().to_string(), same.description.trim().to_string(), same.audience.trim().to_string()));
        }
    }
    let mut components: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for at in 0..listed.len() {
        let root = found(&mut leader, at);
        components.entry(root).or_default().push(at);
    }
    components
        .into_values()
        .filter(|members| members.len() > 1)
        .map(|members| {
            let chosen = named
                .iter()
                .filter(|(held, name, _, _)| !name.is_empty() && held.iter().all(|at| members.contains(at)))
                .max_by_key(|(held, _, _, _)| held.len());
            match chosen {
                Some((_, name, description, audience)) => Joined {
                    members,
                    name: name.clone(),
                    description: description.clone(),
                    audience: audience.clone(),
                },
                None => Joined { members, name: String::new(), description: String::new(), audience: String::new() },
            }
        })
        .collect()
}

const SURFACES_COMPARED: usize = 4;
const RECORDS_COMPARED: usize = 3;

fn reached_by(capability: &Capability) -> String {
    let surfaces: Vec<&str> = capability.surfaces.iter().take(SURFACES_COMPARED).map(String::as_str).collect();
    let records: Vec<&str> = capability.records.iter().take(RECORDS_COMPARED).map(String::as_str).collect();
    let mut told = Vec::new();
    if !surfaces.is_empty() {
        told.push(format!("reached through {}", surfaces.join(", ")));
    }
    if !records.is_empty() {
        told.push(format!("changes {}", records.join(", ")));
    }
    match told.is_empty() {
        true => String::new(),
        false => format!(" ({})", told.join("; ")),
    }
}

const NEAR_FLOW_SHARE: f64 = 0.5;

fn near_in_flows(left: &[String], right: &[String]) -> bool {
    let shared = left.iter().filter(|flow| right.contains(flow)).count();
    let smaller = left.len().min(right.len());
    smaller >= 1 && shared as f64 >= NEAR_FLOW_SHARE * smaller as f64
}

fn near_duplicates(capabilities: &[Capability]) -> Vec<usize> {
    let mut near: BTreeSet<usize> = BTreeSet::new();
    for first in 0..capabilities.len() {
        for second in first + 1..capabilities.len() {
            if near_in_flows(&capabilities[first].flows, &capabilities[second].flows) {
                near.insert(first);
                near.insert(second);
            }
        }
    }
    near.into_iter().collect()
}

fn united(groups: Vec<Joined>) -> Vec<Joined> {
    let mut united: Vec<Joined> = Vec::new();
    for group in groups {
        let mut group = group;
        while let Some(at) = united.iter().position(|held| held.members.iter().any(|member| group.members.contains(member))) {
            let held = united.remove(at);
            let (keeper, other) = if held.members.len() >= group.members.len() { (held, group) } else { (group, held) };
            let mut members = keeper.members.clone();
            members.extend(other.members.iter().copied().filter(|member| !keeper.members.contains(member)));
            members.sort_unstable();
            group = Joined { members, ..keeper };
        }
        united.push(group);
    }
    united
}

pub(crate) fn keep_levels_apart(parts: &mut [Capability], whole: &mut [Capability]) {
    let mut renamed: BTreeMap<(String, String), String> = BTreeMap::new();
    for part in parts.iter_mut() {
        part.level = PART;
        let Some(project) = part.project.as_deref() else { continue };
        let scoped = format!(
            "capability:{}/{}",
            project.strip_prefix("subproject:").unwrap_or(project),
            part.id.strip_prefix("capability:").unwrap_or(&part.id)
        );
        renamed.insert((project.to_string(), std::mem::replace(&mut part.id, scoped.clone())), scoped);
    }
    for capability in whole.iter_mut() {
        capability.level = WHOLE;
        for source in capability.composition_provenance.iter_mut() {
            if let Some(scoped) = renamed.get(&(source.source_child.clone(), source.source_capability_id.clone())) {
                source.source_capability_id = scoped.clone();
            }
        }
    }
}

pub(crate) fn which_are_the_same(capabilities: &[Capability], said: &str) -> Vec<Joined> {
    groups_of_the_same(capabilities, |offered| crate::author::same_capability(said, offered))
}

#[cfg(test)]
fn one_of_each_asking(
    capabilities: &mut Vec<Capability>,
    ask: impl Fn(&BTreeMap<String, String>) -> Vec<crate::author::Same> + Sync,
) {
    let groups = groups_of_the_same(capabilities, ask);
    merge_the_same(capabilities, groups);
}

fn groups_of_the_same(
    capabilities: &[Capability],
    ask: impl Fn(&BTreeMap<String, String>) -> Vec<crate::author::Same> + Sync,
) -> Vec<Joined> {
    if capabilities.len() < 2 {
        return Vec::new();
    }
    let listed: Vec<(String, String)> = capabilities
        .iter()
        .map(|capability| {
            (
                capability.name.clone().unwrap_or_default(),
                format!(
                    "{}{}",
                    in_a_line(capability.description.as_deref().unwrap_or_default()),
                    reached_by(capability)
                ),
            )
        })
        .collect();
    let near = near_duplicates(capabilities);
    let narrowed: Vec<(String, String)> = near.iter().map(|at| listed[*at].clone()).collect();
    let (groups, again) = rayon::join(
        || the_same_among(&listed, &ask),
        || match near.len() > 1 {
            true => the_same_among(&narrowed, &ask),
            false => Vec::new(),
        },
    );
    let again = again.into_iter().map(|joined| Joined {
        members: joined.members.into_iter().map(|at| near[at]).collect(),
        ..joined
    });
    let groups = match near.len() > 1 {
        true => united(groups.into_iter().chain(again).collect()),
        false => groups,
    };
    groups
}

pub(crate) fn merge_the_same(capabilities: &mut Vec<Capability>, groups: Vec<Joined>) {
    if groups.is_empty() {
        return;
    }
    let mut slots: Vec<Option<Capability>> = std::mem::take(capabilities).into_iter().map(Some).collect();
    let mut kept: Vec<Capability> = Vec::new();
    for group in groups {
        let keeper = group
            .members
            .iter()
            .copied()
            .max_by_key(|at| (slots[*at].as_ref().map_or(0, |held| held.flows.len()), std::cmp::Reverse(*at)))
            .unwrap_or(group.members[0]);
        let Some(mut together) = slots[keeper].take() else { continue };
        let mut merged_names: Vec<String> = vec![together.name.clone().unwrap_or_default()];
        for at in &group.members {
            if let Some(other) = slots[*at].take() {
                merged_names.push(other.name.clone().unwrap_or_default());
                crate::comprehend::joined(&mut together, other);
            }
        }
        if !group.name.is_empty() {
            together.id = format!("capability:{}", carved_name(&group.name));
            together.name = Some(group.name.clone());
        }
        if !group.description.is_empty() {
            together.description = Some(group.description.clone());
        }
        if !group.audience.is_empty() {
            together.audience = Some(group.audience.to_ascii_lowercase());
        }
        eprintln!(
            "  one of each: {} <- {}",
            together.name.as_deref().unwrap_or(""),
            merged_names.join(" | ")
        );
        kept.push(together);
    }
    kept.extend(slots.into_iter().flatten());
    let mut unique: Vec<Capability> = Vec::new();
    for capability in kept {
        match unique.iter_mut().find(|held| held.id == capability.id) {
            Some(held) => crate::comprehend::joined(held, capability),
            None => unique.push(capability),
        }
    }
    unique.sort_by(|left, right| left.id.cmp(&right.id));
    *capabilities = unique;
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
            confidence: 1.0,
            unsettled: None,
            open: 0,
            cut: false,
            name: None,
            description: None,
            grounding: None,
            path: Vec::new(),
            steps: Vec::new(),
            step_edges: Vec::new(),
            units: 1,
            rank: 0,
            stages: Vec::new(),
            changes: Vec::new(),
            leads_into: Vec::new(),
            project: None,
            unshipped: None,
        }
    }

    #[test]
    fn a_directory_whose_work_is_almost_all_programs_nothing_ships_is_tooling_though_one_product_flow_starts_there() {
        let in_directory = |id: &str, directory: &str, units: u32, aside: bool| {
            let mut held = flow(id, "lifecycle", None, id, &[], &[]);
            held.path = vec![crate::comprehend::Step { unit: format!("{directory}/{id}.ts:function:main"), depth: 0, leaves: Vec::new() }];
            held.units = units;
            held.unshipped = aside.then(|| crate::entry_exit::Unshipped { role: "benchmark", basis: "shipping-evidence", evidence: String::new() });
            held
        };
        let flows = vec![
            in_directory("sweep", "src/bench", 1000, true),
            in_directory("watch", "src/bench", 40, false),
            in_directory("serve", "src/app", 300, false),
            in_directory("tool", "src/app", 400, true),
        ];
        let tooling = crate::comprehend::tooling_directories(&flows);
        assert!(tooling.contains("src/bench"));
        assert!(!tooling.contains("src/app"));
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

    fn starting_in(mut flow: Flow, unit: &str) -> Flow {
        flow.path = vec![crate::comprehend::Step { unit: unit.to_string(), depth: 0, leaves: Vec::new() }];
        flow
    }

    #[test]
    fn a_flow_that_changes_several_records_reaches_each_as_its_own_outcome() {
        let start = flow("flow:1", "lifecycle", None, "main", &["orders", "invoices"], &[]);
        let flows = vec![&start];
        let grouped = outcomes_of(&flows);
        let keys: BTreeSet<&str> = grouped.keys().map(|family| family.key.as_str()).collect();
        assert!(keys.contains("changes:orders") && keys.contains("changes:invoices"), "{keys:?}");
    }

    #[test]
    fn a_surface_that_ends_in_no_outcome_does_not_hide_a_program_that_does() {
        let relay = flow("flow:1", "http", Some("GET"), "/", &[], &[]);
        let mut program = flow("flow:2", "lifecycle", None, "main", &["projects"], &[]);
        program.steps.push(logical_step("change", Some("projects")));
        let flows = vec![&relay, &program];
        let candidates = candidate_flows(&flows);
        assert!(candidates.iter().any(|candidate| candidate.id == "flow:2"));
    }

    #[test]
    fn a_surface_that_reaches_an_outcome_keeps_the_candidates_to_the_surface() {
        let order = flow("flow:1", "http", Some("POST"), "/orders", &["orders"], &[]);
        let program = flow("flow:2", "lifecycle", None, "main", &["projects"], &[]);
        let flows = vec![&order, &program];
        let candidates = candidate_flows(&flows);
        assert_eq!(candidates.len(), 1);
    }

    #[test]
    fn flows_that_only_trigger_are_read_by_what_triggers_them_only_when_nothing_else_is_the_surface() {
        let accept = starting_in(flow("flow:6", "event", None, "click", &[], &[]), "site/consent.js:callback:accept");
        let reject = starting_in(flow("flow:7", "event", None, "click", &[], &[]), "site/consent.js:callback:reject");
        let flows = vec![&accept, &reject];
        let grouped = outcomes_of(&flows);
        let keys: Vec<&str> = grouped.keys().map(|family| family.key.as_str()).collect();
        assert_eq!(keys, vec!["trigger:event"]);
    }

    #[test]
    fn only_a_flow_a_caller_starts_is_a_candidate_by_section_0_7_1() {
        for kind in ["http", "cli", "tool", "ipc", "rpc", "graphql", "ui"] {
            assert!(is_caller_initiated(&flow("flow:1", kind, None, "x", &[], &[])), "{kind}");
        }
        for kind in ["lifecycle", "schedule", "background", "event", "message", "export", "test"] {
            assert!(!is_caller_initiated(&flow("flow:1", kind, None, "x", &[], &[])), "{kind}");
        }
    }

    #[test]
    fn a_trigger_beside_a_real_outcome_is_left_out() {
        let order = flow("flow:9", "http", Some("POST"), "/orders", &["orders"], &[]);
        let signal = flow("flow:10", "event", None, "SIGTERM", &[], &[]);
        let flows = vec![&order, &signal];
        let grouped = outcomes_of(&flows);
        assert_eq!(grouped.len(), 1);
    }

    #[test]
    fn a_flow_with_no_steps_is_told_by_the_units_it_runs_through() {
        let started = starting_in(flow("flow:11", "event", None, "click", &[], &[]), "site/main.js:callback:menuButton.addEventListener");
        assert_eq!(told_steps(&started), "no steps read; it runs through menuButton.addEventListener");
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
    fn a_named_command_whose_steps_were_never_read_stays_terminal() {
        let family = Family { key: "asks:replace".to_string(), basis: "the command someone explicitly asked it to run" };
        let unread = flow("flow:1", "ipc", None, "replace", &[], &[]);
        assert_eq!(terminality_of(&family, &[&unread]), "terminal");
        assert!(!evidence_of(&[&unread], &family, &Fields::new()).contains(ONLY_PASSES_A_SIGNAL));
    }

    #[test]
    fn a_relay_command_carries_the_signal_note_in_its_evidence() {
        let family = Family { key: "asks:relay:forward".to_string(), basis: "the command someone explicitly asked it to run" };
        let mut relay = flow("flow:1", "ipc", None, "relay:forward", &[], &[]);
        relay.steps.push(logical_step("hand_off", Some("channel")));
        let told = evidence_of(&[&relay], &family, &Fields::new());
        assert!(told.contains("outcome (proximal)") && told.contains(ONLY_PASSES_A_SIGNAL), "{told}");
    }

    #[test]
    fn a_named_command_that_reads_what_it_shows_stays_terminal() {
        let family = Family { key: "asks:usage:get".to_string(), basis: "the command someone explicitly asked it to run" };
        let shows = flow("flow:1", "ipc", None, "usage:get", &[], &["usage"]);
        assert_eq!(terminality_of(&family, &[&shows]), "terminal");
        assert!(!evidence_of(&[&shows], &family, &Fields::new()).contains(ONLY_PASSES_A_SIGNAL));
    }

    #[test]
    fn a_route_family_never_carries_the_signal_note() {
        let family = Family { key: "hands on:close_event".to_string(), basis: "what it hands on to another part" };
        let mut raised = flow("flow:1", "event", None, "close", &[], &[]);
        raised.steps.push(logical_step("raise", Some("close_event")));
        assert_eq!(terminality_of(&family, &[&raised]), "terminal");
        assert!(!evidence_of(&[&raised], &family, &Fields::new()).contains(ONLY_PASSES_A_SIGNAL));
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

    fn held_of(name: &str, families: &[&str]) -> Held {
        Held {
            name: name.to_string(),
            description: String::new(),
            audience: String::new(),
            families: families.iter().map(|id| id.to_string()).collect(),
            roles: BTreeMap::new(),
        }
    }

    #[test]
    fn a_proposal_names_a_role_per_family_() {
        let said = serde_json::json!({
            "capabilities": [
                {"name": "Trade assets", "description": "d", "audience": "traders", "serves": [
                    {"id": "f0", "role": "primary", "why": "places the trade"},
                    {"id": "f1", "role": "Prerequisite", "why": "signs in first"},
                    {"id": "f2", "role": "nonsense", "why": "x"},
                    "f3"
                ]},
                {"name": "", "serves": [{"id": "f9", "role": "primary"}]},
                {"name": "Empty", "serves": []}
            ],
            "unassigned": ["f4"]
        });
        let proposal = crate::author::proposal_of(&said);
        assert_eq!(proposal.capabilities.len(), 1);
        let trade = &proposal.capabilities[0];
        assert_eq!(trade.families, vec!["f0", "f1", "f2", "f3"]);
        assert_eq!(trade.roles["f0"].role, "primary");
        assert_eq!(trade.roles["f0"].why, "places the trade");
        assert_eq!(trade.roles["f1"].role, "prerequisite");
        assert!(!trade.roles.contains_key("f2"), "an unknown role is not kept");
        assert!(!trade.roles.contains_key("f3"));
    }

    #[test]
    fn the_legacy_families_list_of_ids_still_parses() {
        let said = serde_json::json!({"capabilities": [{"name": "Browse the catalog", "families": ["f0", "f1"]}], "plumbing": []});
        let proposal = crate::author::proposal_of(&said);
        assert_eq!(proposal.capabilities[0].families, vec!["f0", "f1"]);
        assert!(proposal.capabilities[0].roles.is_empty());
    }

    #[test]
    fn gathering_groups_many_families_under_one_purpose_and_reports_what_it_left_out() {
        let known: BTreeSet<String> = ["f0", "f1", "f2", "f3"].iter().map(|id| id.to_string()).collect();
        let one = crate::author::proposal_of(
            &serde_json::json!({"capabilities": [{"name": "Manage photo albums", "serves": [
                {"id": "f0", "role": "primary"}, {"id": "f9", "role": "primary"}]}], "unassigned": ["f3", "f8"]}),
        );
        let two = crate::author::proposal_of(
            &serde_json::json!({"capabilities": [{"name": "manage photo album", "serves": [
                {"id": "f1", "role": "supporting", "why": "lists them"}, {"id": "f2", "role": "recovery"}]}]}),
        );
        let mut held: Vec<Held> = Vec::new();
        gather(vec![one, two], &mut held, &known);
        assert_eq!(held.len(), 1, "the same purpose named twice is one capability");
        assert_eq!(held[0].families, BTreeSet::from(["f0".to_string(), "f1".to_string(), "f2".to_string()]));
        assert_eq!(held[0].roles["f1"].role, "supporting");
        assert_eq!(held[0].roles["f2"].role, "recovery");
        assert_eq!(unseated(known.iter(), &held), vec!["f3".to_string()], "an outcome the AI left out is still unplaced, to be attached");
    }

    #[test]
    fn capabilities_with_the_same_name_merge_at_any_level_without_asking() {
        let mut held = vec![
            held_of("Configure engine environment", &["f0"]),
            held_of("Delete a post", &["f1"]),
            held_of("  configure   Engine environments ", &["f2"]),
        ];
        merge_same_named(&mut held);
        assert_eq!(held.len(), 2);
        assert_eq!(held[0].families, BTreeSet::from(["f0".to_string(), "f2".to_string()]));
    }

    #[test]
    fn a_family_serving_two_purposes_delivers_its_flows_to_both_with_a_role_each() {
        let sign_in = flow("flow:1", "http", Some("POST"), "/session", &["session"], &[]);
        let place = flow("flow:2", "http", Some("POST"), "/orders", &["orders"], &[]);
        let sign_in_family = Family { key: "changes:session".to_string(), basis: "the record it changes" };
        let place_family = Family { key: "changes:orders".to_string(), basis: "the record it changes" };
        let (a, b) = (vec![&sign_in], vec![&place]);
        let lanes: BTreeMap<&str, (&Family, &Vec<&Flow>)> =
            BTreeMap::from([("f0", (&sign_in_family, &a)), ("f1", (&place_family, &b))]);
        let mut trade = held_of("Place orders", &["f0", "f1"]);
        trade.roles.insert("f0".to_string(), Serving { role: "prerequisite".to_string(), why: "signs in first".to_string() });
        trade.roles.insert("f1".to_string(), Serving { role: "primary".to_string(), why: String::new() });
        let mut account = held_of("Manage an account", &["f0"]);
        account.roles.insert("f0".to_string(), Serving { role: "primary".to_string(), why: String::new() });
        let placed = built(trade, &lanes, &Fields::new()).expect("built");
        let managed = built(account, &lanes, &Fields::new()).expect("built");
        let role_of = |capability: &Capability, flow: &str| capability.delivered.iter().find(|held| held.flow == flow).map(|held| held.role);
        assert_eq!(role_of(&placed, "flow:1"), Some("prerequisite"));
        assert_eq!(role_of(&placed, "flow:2"), Some("primary"));
        assert_eq!(role_of(&managed, "flow:1"), Some("primary"));
        assert_eq!(placed.flows, vec!["flow:1", "flow:2"]);
        assert!(placed.evidence.contains("it is served by 2 outcomes"), "{}", placed.evidence);
        assert!(placed.evidence.contains("- prerequisite: session"), "{}", placed.evidence);
        assert_eq!(placed.delivered.iter().find(|held| held.flow == "flow:1").map(|held| held.rationale.as_str()), Some("signs in first"));
    }

    fn capability_of(name: &str, flows: usize) -> Capability {
        Capability {
            id: format!("capability:{}", carved_name(name)),
            audience: None,
            delivered: Vec::new(),
            records: Vec::new(),
            changes: Vec::new(),
            flows: (0..flows).map(|at| format!("flow:{name}:{at}")).collect(),
            surfaces: Vec::new(),
            project: None,
            also_in: Vec::new(),
            place: None,
            name: Some(name.to_string()),
            description: None,
            grounding: None,
            standing: PUBLISHED,
            level: crate::capabilities::PART,
            touches: Vec::new(),
            terminality: None,
            confidence: None,
            unsettled: None,
            composition_provenance: Vec::new(),
            parent_originated: None,
            evidence: String::new(),
        }
    }

    fn all_one(offered: &BTreeMap<String, String>) -> Vec<crate::author::Same> {
        vec![crate::author::Same {
            of: offered.keys().cloned().collect(),
            name: "Do it all".to_string(),
            description: String::new(),
            audience: String::new(),
        }]
    }

    fn same_only_when_few_are_offered(offered: &BTreeMap<String, String>) -> Vec<crate::author::Same> {
        match offered.len() {
            2 => all_one(offered),
            _ => Vec::new(),
        }
    }

    #[test]
    fn capabilities_sharing_their_flows_are_put_to_the_ask_on_their_own() {
        let mut capabilities = vec![
            capability_of("Correlate runtime behavior with code", 4),
            capability_of("Send invoices", 3),
            capability_of("Track deliveries", 3),
            capability_of("Reset a password", 2),
            capability_of("Export a report", 2),
        ];
        let mut narrower = capability_of("Correlate runtime behavior with code analysis", 3);
        narrower.flows = capabilities[0].flows[..3].to_vec();
        capabilities.push(narrower);
        one_of_each_asking(&mut capabilities, same_only_when_few_are_offered);
        let names: Vec<String> = capabilities.iter().filter_map(|capability| capability.name.clone()).collect();
        assert_eq!(names.len(), 5, "{names:?}");
        assert!(names.iter().any(|name| name == "Do it all"), "{names:?}");
    }

    #[test]
    fn unrelated_names_and_disjoint_flows_are_not_near_duplicates() {
        let capabilities = vec![capability_of("Send invoices", 3), capability_of("Track deliveries", 3), capability_of("Reset a password", 2)];
        assert!(near_duplicates(&capabilities).is_empty());
    }

    #[test]
    fn capabilities_that_mostly_share_their_flows_are_near_duplicates() {
        let flows = |ids: &[&str]| -> Vec<String> { ids.iter().map(|id| id.to_string()).collect() };
        assert!(near_in_flows(&flows(&["a", "b", "c"]), &flows(&["b", "c", "d", "e"])));
        assert!(!near_in_flows(&flows(&["a", "b", "c"]), &flows(&["c", "d", "e"])));
        assert!(near_in_flows(&flows(&["a"]), &flows(&["a", "b"])));
        assert!(!near_in_flows(&flows(&["a"]), &flows(&["b"])));
    }

    #[test]
    fn names_alone_never_make_capabilities_near_duplicates_by_section_0_7_1() {
        let capabilities = vec![
            capability_of("Authenticate users", 3),
            capability_of("Authenticate and maintain sessions", 3),
            capability_of("Access and inspect analysis results", 4),
            capability_of("Export and inspect analysis results", 4),
        ];
        assert!(near_duplicates(&capabilities).is_empty());
    }

    #[test]
    fn a_part_capability_and_the_whole_capability_of_one_name_keep_distinct_ids_and_provenance_follows() {
        let mut part = capability_of("Authenticate users", 2);
        part.project = Some("subproject:apps/api".to_string());
        let mut whole = capability_of("Authenticate users", 2);
        whole.composition_provenance = vec![crate::parent::Source {
            source_child: "subproject:apps/api".to_string(),
            source_capability_id: part.id.clone(),
            disposition: "promoted",
            weight: None,
        }];
        let mut parts = vec![part];
        let mut wholes = vec![whole];
        keep_levels_apart(&mut parts, &mut wholes);
        assert_ne!(parts[0].id, wholes[0].id);
        assert_eq!((parts[0].level, wholes[0].level), (PART, WHOLE));
        assert_eq!(wholes[0].composition_provenance[0].source_capability_id, parts[0].id);
    }

    #[test]
    fn a_group_found_twice_is_united_with_the_larger_naming_it() {
        let group = |members: &[usize], name: &str| Joined {
            members: members.to_vec(),
            name: name.to_string(),
            description: String::new(),
            audience: String::new(),
        };
        let united = united(vec![group(&[0, 1], "Pair"), group(&[1, 2, 3], "Trio"), group(&[5, 6], "Apart")]);
        assert_eq!(united.len(), 2);
        let trio = united.iter().find(|held| held.name == "Trio").unwrap();
        assert_eq!(trio.members, vec![0, 1, 2, 3]);
    }

    #[test]
    fn product_surfaces_rank_before_programs_and_what_programs_alone_run() {
        let mut route = flow("flow:route", "http", Some("POST"), "/v1/analyze", &[], &[]);
        route.units = 10;
        let mut program = flow("flow:main", "lifecycle", None, "main", &[], &[]);
        program.units = 500;
        let mut benchmark = flow("flow:bench", "tool", None, "run_benchmark", &[], &[]);
        benchmark.units = 900;
        benchmark.unshipped = Some(crate::entry_exit::Unshipped { role: "benchmark", basis: "reaches-only-program-code", evidence: String::new() });
        let mut orient = flow("flow:orient", "tool", None, "get_start_context", &[], &[]);
        orient.units = 50;
        let mut obscure = flow("flow:obscure", "tool", None, "do_something_rare", &[], &[]);
        obscure.units = 400;
        let pointed_to: rustc_hash::FxHashMap<String, usize> = [("flow:orient".to_string(), 5)].into_iter().collect();
        let mut flows = vec![benchmark, program, route, obscure, orient];
        crate::comprehend::rank_flows(&mut flows, &pointed_to);
        let rank_of = |id: &str| flows.iter().find(|held| held.id == id).map(|held| held.rank);
        assert_eq!(
            (rank_of("flow:route"), rank_of("flow:orient"), rank_of("flow:obscure"), rank_of("flow:main"), rank_of("flow:bench")),
            (Some(2), Some(1), Some(3), Some(4), Some(5))
        );
    }

    #[test]
    fn coverage_withholds_no_flow_and_gives_each_unmapped_one_its_reason() {
        let served = flow("flow:1", "http", Some("GET"), "/a", &[], &[]);
        let hook = flow("flow:2", "event", None, "SIGTERM", &[], &[]);
        let mut tooling = flow("flow:3", "lifecycle", None, "main", &[], &[]);
        tooling.unshipped = Some(crate::entry_exit::Unshipped { role: "benchmark", basis: "shipping-evidence", evidence: String::new() });
        let reading = flow("flow:4", "event", None, "data", &[], &["orders"]);
        let waiting = flow("flow:5", "http", Some("GET"), "/b", &[], &["orders"]);
        let pending = BTreeSet::from(["flow:5".to_string()]);
        let covered = coverage_of(&[served, hook, tooling, reading, waiting], &[], &BTreeMap::new(), &pending);
        assert_eq!((covered.flows, covered.unmapped), (5, 5));
        let ids: Vec<&str> = covered.unmapped_flows.iter().map(|held| held.flow.as_str()).collect();
        assert_eq!(ids, vec!["flow:1", "flow:2", "flow:3", "flow:4", "flow:5"]);
        let reason = |id: &str| covered.unmapped_flows.iter().find(|held| held.flow == id).map(|held| held.reason.clone()).unwrap_or_default();
        assert!(reason("flow:1").contains("reaches no domain entity"));
        assert!(reason("flow:2").contains("started by the runtime"));
        assert!(reason("flow:3").contains("set aside"));
        assert!(reason("flow:5").contains("unanswered"));
    }

    #[test]
    fn flows_that_no_capability_serves_are_counted_and_listed_as_unmapped() {
        let mut first = flow("flow:1", "http", Some("GET"), "/a", &[], &[]);
        first.project = Some("subproject:web".to_string());
        let mut second = flow("flow:2", "http", Some("GET"), "/b", &[], &[]);
        second.project = Some("subproject:web".to_string());
        let third = flow("flow:3", "cli", None, "tool", &[], &[]);
        let capability = Capability {
            id: "capability:x".to_string(),
            audience: None,
            delivered: Vec::new(),
            records: Vec::new(),
            changes: Vec::new(),
            flows: vec!["flow:1".to_string(), "flow:3".to_string()],
            surfaces: Vec::new(),
            project: None,
            also_in: Vec::new(),
            place: None,
            name: Some("X".to_string()),
            description: None,
            grounding: None,
            standing: PUBLISHED,
            level: crate::capabilities::PART,
            touches: Vec::new(),
            terminality: None,
            confidence: None,
            unsettled: None,
            composition_provenance: Vec::new(),
            parent_originated: None,
            evidence: String::new(),
        };
        let covered = coverage_of(&[first, second, third], &[capability], &BTreeMap::new(), &BTreeSet::new());
        assert_eq!((covered.flows, covered.related, covered.unmapped), (3, 2, 1));
        assert_eq!(covered.flows_to_capabilities, 0.667);
        assert_eq!(covered.unmapped_flows.iter().map(|held| held.flow.as_str()).collect::<Vec<_>>(), vec!["flow:2"]);
        let web = covered.parts.iter().find(|part| part.project.as_deref() == Some("subproject:web")).expect("web part");
        assert_eq!((web.flows, web.related, web.unmapped), (2, 1, 1));
        let root = covered.parts.iter().find(|part| part.project.is_none()).expect("root part");
        assert_eq!(root.flows_to_capabilities, 1.0);
    }

    #[test]
    fn a_flow_tagged_as_unshipped_by_evidence_is_never_proposed() {
        let mut tooling = flow("flow:1", "cli", None, "build", &[], &[]);
        assert!(is_proposable(&tooling));
        for basis in ["shipping-evidence", "island"] {
            tooling.unshipped = Some(crate::entry_exit::Unshipped { role: "tooling", basis, evidence: String::new() });
            assert!(!is_proposable(&tooling), "{basis}");
        }
    }

    #[test]
    fn a_flow_tagged_as_unshipped_only_by_its_name_is_still_proposed() {
        let mut named = flow("flow:1", "cli", None, "build", &[], &[]);
        named.unshipped = Some(crate::entry_exit::Unshipped { role: "tooling", basis: "name", evidence: String::new() });
        assert!(is_proposable(&named));
    }
}

#[cfg(test)]
mod one_of_each_tests {
    use super::*;

    fn listed(names: &[String]) -> Vec<(String, String)> {
        names.iter().map(|name| (name.clone(), format!("Someone gets {name}."))).collect()
    }

    fn synonyms_asked(offered: &BTreeMap<String, String>) -> Vec<crate::author::Same> {
        let links = offered.iter().find(|(_, told)| told.starts_with("Open external links |"));
        let urls = offered.iter().find(|(_, told)| told.starts_with("Open external URLs |"));
        match (links, urls) {
            (Some((first, _)), Some((second, _))) => vec![crate::author::Same {
                of: vec![first.clone(), second.clone()],
                name: "Open external links".to_string(),
                description: "Opens links outside the app.".to_string(),
                audience: "user".to_string(),
            }],
            _ => Vec::new(),
        }
    }

    #[test]
    fn a_name_key_ignores_case_punctuation_articles_and_plurals() {
        assert_eq!(name_key("Open External Links."), name_key("open an external link"));
        assert_eq!(name_key("Manage Categories"), name_key("manage category"));
        assert_eq!(name_key("Track the process"), name_key("track processes"));
        assert_ne!(name_key("Sign in"), name_key("Sign out"));
    }

    #[test]
    fn the_same_normalized_name_is_merged_without_asking() {
        let names = vec!["Configure engine environment".to_string(), "Delete a post".to_string(), "configure Engine environments!".to_string()];
        let asked = std::sync::atomic::AtomicUsize::new(0);
        let groups = the_same_among(&listed(&names), |offered| {
            asked.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            assert_eq!(offered.len(), 2, "a name already merged is listed once: {offered:?}");
            Vec::new()
        });
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].members, vec![0, 2]);
    }

    #[test]
    fn a_synonym_pair_planted_in_different_chunks_comes_out_as_one() {
        let mut names: Vec<String> = (0..300).map(|at| format!("Distinct capability {at}")).collect();
        names[5] = "Open external links".to_string();
        names[280] = "Open external URLs".to_string();
        let items = listed(&names);
        assert!(asked_together(&(0..300).collect::<Vec<_>>()).iter().all(|chunk| chunk.len() <= LISTED_AT_ONCE));
        let groups = the_same_among(&items, synonyms_asked);
        assert_eq!(groups.len(), 1, "exactly the planted pair merges");
        assert_eq!(groups[0].members, vec![5, 280]);
        assert_eq!(groups[0].name, "Open external links");
    }

    #[test]
    fn every_pair_is_asked_together_at_least_once() {
        let shown: Vec<usize> = (0..400).collect();
        let chunks = asked_together(&shown);
        for first in (0..400).step_by(37) {
            for second in (0..400).step_by(41) {
                assert!(chunks.iter().any(|chunk| chunk.contains(&first) && chunk.contains(&second)), "{first} and {second}");
            }
        }
    }

    #[test]
    fn names_that_are_not_the_same_stay_apart_when_nothing_is_said_the_same() {
        let names = vec!["Sign in".to_string(), "Sign out".to_string(), "Delete a post".to_string()];
        assert!(the_same_among(&listed(&names), |_| Vec::new()).is_empty());
    }
}
